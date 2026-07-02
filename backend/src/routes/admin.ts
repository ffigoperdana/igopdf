import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/rbac.js';
import {
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  resetUserPassword,
  bulkCreateUsers,
  getDashboardStats,
} from '../services/userService.js';
import { validateCsvContent, validateTxtContent } from '../utils/csvValidator.js';
import { generateRandomPassword } from '../utils/password.js';
import { logger } from '../utils/logger.js';

const router = Router();

router.use(authMiddleware);
router.use(requireAdmin);

const createUserSchema = z
  .object({
    username: z
      .string()
      .min(3)
      .max(150)
      .regex(
        /^[a-zA-Z0-9._@-]+$/,
        'Username can only contain letters, numbers, dots, underscores, hyphens, and @'
      ),
    // Optional because LDAP-backed accounts (authSource: 'ldap') never store a
    // local password — see the .refine() below, which still requires it for
    // local accounts.
    password: z.string().min(8).optional(),
    role: z.enum(['admin', 'user']),
    authSource: z.enum(['local', 'ldap']).optional().default('local'),
  })
  .refine((data) => data.authSource !== 'local' || Boolean(data.password), {
    message: 'Password is required for local accounts',
    path: ['password'],
  })
  .refine((data) => !(data.authSource === 'ldap' && data.role === 'admin'), {
    // "Admin SELALU akun lokal": an LDAP-backed admin authenticates live
    // against AD yet is invisible to this panel (listUsers is local-only), so
    // it becomes an unmanageable "hidden admin". Disallow that combination.
    message: 'Admin accounts must be local; LDAP users cannot be admins',
    path: ['role'],
  });

const updateUserSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(150)
    .regex(
      /^[a-zA-Z0-9._@-]+$/,
      'Username can only contain letters, numbers, dots, underscores, hyphens, and @'
    )
    .optional(),
  role: z.enum(['admin', 'user']).optional(),
  isActive: z.boolean().optional(),
});

const resetPasswordSchema = z.object({
  newPassword: z
    .string()
    .min(8)
    .regex(
      /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).+$/,
      'Password must contain at least one uppercase letter, one lowercase letter, and one number'
    )
    .optional(),
});

router.get('/dashboard', async (_req, res) => {
  try {
    const stats = await getDashboardStats();
    res.json({
      success: true,
      data: stats,
    });
  } catch (err) {
    logger.error('Dashboard stats error', err);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

router.get('/users', async (req, res) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const search = req.query.search as string | undefined;
    const role = req.query.role as string | undefined;
    const isActiveStr = req.query.isActive as string | undefined;

    let isActive: boolean | undefined;
    if (isActiveStr === 'true') isActive = true;
    else if (isActiveStr === 'false') isActive = false;

    const result = await listUsers(page, limit, search, role, isActive);

    res.json({
      success: true,
      data: result.users,
      total: result.total,
      page,
      limit,
      totalPages: Math.ceil(result.total / limit),
    });
  } catch (err) {
    logger.error('List users error', err);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

router.post('/users', async (req, res) => {
  try {
    const validation = createUserSchema.safeParse(req.body);
    if (!validation.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid input',
        details: validation.error.issues,
      });
      return;
    }

    const user = await createUser(validation.data, req.user!.id);
    res.status(201).json({
      success: true,
      data: { user },
      message: 'User created successfully',
    });
  } catch (err) {
    logger.error('Create user error', err);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

router.put('/users/:id', async (req, res) => {
  try {
    const validation = updateUserSchema.safeParse(req.body);
    if (!validation.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid input',
        details: validation.error.issues,
      });
      return;
    }

    const user = await updateUser(req.params.id, validation.data);
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
      message: 'User updated successfully',
    });
  } catch (err) {
    logger.error('Update user error', err);
    const message = err instanceof Error ? err.message : 'Internal server error';
    res.status(400).json({
      success: false,
      error: message,
    });
  }
});

router.delete('/users/:id', async (req, res) => {
  try {
    if (req.params.id === req.user!.id) {
      res.status(400).json({
        success: false,
        error: 'Cannot delete your own account',
      });
      return;
    }

    const deleted = await deleteUser(req.params.id);
    if (!deleted) {
      res.status(404).json({
        success: false,
        error: 'User not found',
      });
      return;
    }

    res.json({
      success: true,
      message: 'User deleted successfully',
    });
  } catch (err) {
    logger.error('Delete user error', err);
    const message = err instanceof Error ? err.message : 'Internal server error';
    res.status(400).json({
      success: false,
      error: message,
    });
  }
});

router.post('/users/:id/reset-password', async (req, res) => {
  try {
    const validation = resetPasswordSchema.safeParse(req.body);
    if (!validation.success) {
      res.status(400).json({
        success: false,
        error: 'Invalid input',
        details: validation.error.issues,
      });
      return;
    }

    const newPassword = validation.data.newPassword || generateRandomPassword();
    const result = await resetUserPassword(req.params.id, newPassword);

    if (!result.success) {
      res.status(result.error === 'User not found' ? 404 : 400).json({
        success: false,
        error: result.error || 'User not found',
      });
      return;
    }

    res.json({
      success: true,
      data: validation.data.newPassword ? undefined : { newPassword },
      message: 'Password reset successfully',
    });
  } catch (err) {
    logger.error('Reset password error', err);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

router.post('/users/bulk-import', async (req, res) => {
  try {
    const { content, format } = req.body;

    if (!content) {
      res.status(400).json({
        success: false,
        error: 'No content provided',
      });
      return;
    }

    const validation =
      format === 'txt' ? validateTxtContent(content) : validateCsvContent(content);

    if (!validation.valid) {
      res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: validation.errors,
        warnings: validation.warnings,
      });
      return;
    }

    const result = await bulkCreateUsers(validation.records, req.user!.id);

    res.json({
      success: true,
      data: {
        created: result.created,
        failed: result.failed,
        errors: result.errors,
        warnings: validation.warnings,
      },
      message: `Import completed: ${result.created} created, ${result.failed} failed`,
    });
  } catch (err) {
    logger.error('Bulk import error', err);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

router.post('/users/import-preview', async (req, res) => {
  try {
    const { content, format } = req.body;

    if (!content) {
      res.status(400).json({
        success: false,
        error: 'No content provided',
      });
      return;
    }

    const validation =
      format === 'txt' ? validateTxtContent(content) : validateCsvContent(content);

    res.json({
      success: true,
      data: {
        valid: validation.valid,
        records: validation.records,
        errors: validation.errors,
        warnings: validation.warnings,
        totalRows: validation.records.length,
      },
    });
  } catch (err) {
    logger.error('Import preview error', err);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
});

export default router;
