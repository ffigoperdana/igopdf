import type { Request, Response, NextFunction } from 'express';
import { getSession } from '../services/authService.js';
import { sessionConfig } from '../config/session.js';
import { logger } from '../utils/logger.js';
import type { User } from '../types/index.js';

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        username: string;
        role: string;
        authSource?: string;
      };
      sessionId?: string;
    }
  }
}

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const token = req.cookies[sessionConfig.cookieName];

  if (!token) {
    res.status(401).json({
      success: false,
      error: 'Authentication required',
      code: 'AUTH_REQUIRED',
    });
    return;
  }

  try {
    const session = await getSession(token);

    if (!session) {
      res.clearCookie(sessionConfig.cookieName);
      res.status(401).json({
        success: false,
        error: 'Invalid or expired session',
        code: 'SESSION_INVALID',
      });
      return;
    }

    req.user = {
      id: session.user_id,
      username: session.username,
      role: session.role,
      authSource: session.auth_source,
    };
    req.sessionId = session.id;

    next();
  } catch (err) {
    logger.error('Auth middleware error', err);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
}

export function optionalAuthMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  const token = req.cookies[sessionConfig.cookieName];

  if (token) {
    getSession(token)
      .then((session) => {
        if (session) {
          req.user = {
            id: session.user_id,
            username: session.username,
            role: session.role,
          };
          req.sessionId = session.id;
        }
        next();
      })
      .catch(() => next());
  } else {
    next();
  }
}
