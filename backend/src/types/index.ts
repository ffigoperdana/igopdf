export interface User {
  id: string;
  username: string;
  passwordHash: string;
  role: 'admin' | 'user';
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastLogin: Date | null;
  createdBy: string | null;
}

export interface Session {
  id: string;
  userId: string;
  tokenHash: string;
  ipAddress: string;
  userAgent: string;
  expiresAt: Date;
  createdAt: Date;
}

export interface LoginAttempt {
  id: number;
  username: string;
  ipAddress: string;
  success: boolean;
  attemptedAt: Date;
}

export interface AuditLog {
  id: number;
  userId: string | null;
  action: string;
  details: Record<string, unknown> | null;
  ipAddress: string | null;
  createdAt: Date;
}

export interface CaptchaToken {
  id: string;
  tokenHash: string;
  answerHash: string;
  expiresAt: Date;
  used: boolean;
  createdAt: Date;
}

export interface JwtPayload {
  userId: string;
  sessionId: string;
}

export type UserRole = 'admin' | 'user';

export interface CreateUserRequest {
  username: string;
  password: string;
  role: UserRole;
}

export interface UpdateUserRequest {
  username?: string;
  role?: UserRole;
  isActive?: boolean;
}

export interface LoginRequest {
  username: string;
  password: string;
  captchaToken: string;
  captchaAnswer: string;
}

export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

export interface BulkImportUser {
  username: string;
  password: string;
  role: UserRole;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  message?: string;
  error?: string;
  code?: string;
}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface DashboardStats {
  totalUsers: number;
  activeUsers: number;
  inactiveUsers: number;
  adminCount: number;
  userCount: number;
  recentLogins: number;
  recentAuditLogs: number;
}
