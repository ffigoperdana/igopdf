import crypto from 'crypto';
import svgCaptcha from 'svg-captcha';
import { pool } from '../config/database.js';
import { config } from '../config/index.js';
import { hashPassword } from '../utils/password.js';
import { logger } from '../utils/logger.js';

interface CaptchaResult {
  token: string;
  svg: string;
}

export async function generateCaptcha(): Promise<CaptchaResult> {
  const captcha = svgCaptcha.createMathExpr({
    mathMin: 1,
    mathMax: 9,
    mathOperator: '+',
    width: 150,
    height: 50,
    background: '#f0f0f0',
    color: true,
  });

  const token = crypto.randomUUID();
  const tokenHash = crypto
    .createHash('sha256')
    .update(token)
    .digest('hex');

  const answerHash = await hashPassword(captcha.text);

  const expiresAt = new Date(Date.now() + config.captcha.expiryMinutes * 60 * 1000);

  await pool.query(
    `INSERT INTO captcha_tokens (id, token_hash, answer_hash, expires_at, used)
     VALUES ($1, $2, $3, $4, false)`,
    [token, tokenHash, answerHash, expiresAt]
  );

  logger.info('CAPTCHA generated', { token: token.substring(0, 8) + '...' });

  return { token, svg: captcha.data };
}

export async function verifyCaptcha(
  token: string,
  answer: string
): Promise<boolean> {
  const tokenHash = crypto
    .createHash('sha256')
    .update(token)
    .digest('hex');

  const result = await pool.query(
    `SELECT id, answer_hash, expires_at, used
     FROM captcha_tokens
     WHERE token_hash = $1`,
    [tokenHash]
  );

  if (result.rows.length === 0) {
    logger.warn('CAPTCHA verification failed: token not found');
    return false;
  }

  const captcha = result.rows[0];

  if (captcha.used) {
    logger.warn('CAPTCHA verification failed: token already used');
    return false;
  }

  if (new Date(captcha.expires_at) < new Date()) {
    logger.warn('CAPTCHA verification failed: token expired');
    return false;
  }

  const { verifyPassword } = await import('../utils/password.js');
  const answerValid = await verifyPassword(answer, captcha.answer_hash);

  if (!answerValid) {
    logger.warn('CAPTCHA verification failed: wrong answer');
    return false;
  }

  await pool.query(
    `UPDATE captcha_tokens SET used = true WHERE id = $1`,
    [captcha.id]
  );

  logger.info('CAPTCHA verified successfully');
  return true;
}

export async function cleanupExpiredCaptchas(): Promise<void> {
  const result = await pool.query(
    `DELETE FROM captcha_tokens WHERE expires_at < NOW() OR used = true`
  );
  logger.debug(`Cleaned up ${result.rowCount} expired/used captchas`);
}
