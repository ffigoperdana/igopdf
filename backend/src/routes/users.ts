import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { changePassword } from '../services/userService.js';
import { getUserById } from '../services/userService.js';
import { logger } from '../utils/logger.js';

const router = Router();

router.use(authMiddleware);

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z
    .string()
    .min(8)
    .regex(
      /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).+$/,
      'Password must contain at least one uppercase letter, one lowercase letter, and one number'
    ),
});

router.get('/profile', async (req, res) => {
  try {
    const user = await getUserById(req.user!.id);
    if (!user) {
      res.status(404).json({
        success: false,
        error: 'User not found',
      });
      return;
    }

    res.json({
      success: true,
      data: { user },
    });
  } catch (err) {
    logger.error('Get profile error', err);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

router.put('/profile', async (req, res) => {
  try {
    const user = await getUserById(req.user!.id);
    if (!user) {
      res.status(404).json({
        success: false,
        error: 'User not found',
      });
      return;
    }

    res.json({
      success: true,
      data: { user },
      message: 'Profile updated',
    });
  } catch (err) {
    logger.error('Update profile error', err);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

router.post('/change-password', async (req, res) => {
  try {
    const validation = changePasswordSchema.safeParse(req.body);
    if (!validation.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid input',
        details: validation.error.issues,
      });
      return;
    }

    const { currentPassword, newPassword } = validation.data;

    const result = await changePassword(
      req.user!.id,
      currentPassword,
      newPassword
    );

    if (!result.success) {
      res.status(400).json({
        success: false,
        error: result.error,
      });
      return;
    }

    res.json({
      success: true,
      message: 'Password changed successfully',
    });
  } catch (err) {
    logger.error('Change password error', err);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

export default router;
