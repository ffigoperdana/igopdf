import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { config } from './config/index.js';
import { testConnection, closePool } from './config/database.js';
import { apiLimiter } from './middleware/rateLimiter.js';
import authRoutes from './routes/auth.js';
import captchaRoutes from './routes/captcha.js';
import userRoutes from './routes/users.js';
import adminRoutes from './routes/admin.js';
import { cleanupExpiredSessions } from './services/authService.js';
import { cleanupExpiredCaptchas } from './services/captchaService.js';
import { logger } from './utils/logger.js';

const app = express();

app.set('trust proxy', 1);

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

app.use(cors({
  origin: config.cors.origin,
  credentials: config.cors.credentials,
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use('/api', apiLimiter);

app.use('/api/auth', authRoutes);
app.use('/api/captcha', captchaRoutes);
app.use('/api/users', userRoutes);
app.use('/api/admin', adminRoutes);

app.get('/health', (_req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

app.use((_req, res) => {
  res.status(404).json({
    success: false,
    error: 'Not found',
  });
});

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error('Unhandled error', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
  });
});

const cleanupInterval = setInterval(async () => {
  try {
    await cleanupExpiredSessions();
    await cleanupExpiredCaptchas();
  } catch (err) {
    logger.error('Cleanup error', err);
  }
}, 60 * 60 * 1000);

async function start() {
  const connected = await testConnection();
  if (!connected) {
    logger.error('Failed to connect to database');
    process.exit(1);
  }

  app.listen(config.port, () => {
    logger.info(`IGO Backend running on port ${config.port}`);
    logger.info(`Environment: ${config.nodeEnv}`);
  });
}

process.on('SIGINT', async () => {
  logger.info('Shutting down...');
  clearInterval(cleanupInterval);
  await closePool();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Shutting down...');
  clearInterval(cleanupInterval);
  await closePool();
  process.exit(0);
});

start();

export default app;
