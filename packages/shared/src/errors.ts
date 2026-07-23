/**
 * Vibe 1099 — application error taxonomy (Phase 1).
 * Every API error response carries { error: { code, message, details? } }.
 */

export const ErrorCodes = {
  // Generic
  E_VALIDATION: 'E_VALIDATION',
  E_NOT_FOUND: 'E_NOT_FOUND',
  E_CONFLICT: 'E_CONFLICT',
  E_INTERNAL: 'E_INTERNAL',

  // Auth / tenancy
  E_AUTH: 'E_AUTH', // not authenticated
  E_FORBIDDEN: 'E_FORBIDDEN', // authenticated but not allowed
  E_TOKEN_EXPIRED: 'E_TOKEN_EXPIRED',
  E_TOKEN_REVOKED: 'E_TOKEN_REVOKED',
  E_CHALLENGE_FAILED: 'E_CHALLENGE_FAILED', // recipient last-4 challenge
  E_LOCKED_OUT: 'E_LOCKED_OUT',
  E_RATE_LIMIT: 'E_RATE_LIMIT',
  E_CSRF: 'E_CSRF',

  // Domain state
  E_STATE: 'E_STATE', // invalid status transition
  E_IMMUTABLE: 'E_IMMUTABLE', // transmitted records cannot be edited/deleted
  E_DUPLICATE_TIN: 'E_DUPLICATE_TIN',
  E_TIN_MISMATCH: 'E_TIN_MISMATCH', // W-9 TIN differs from vault
  E_YEAR_CLOSED: 'E_YEAR_CLOSED',

  // Integrations
  E_IRIS: 'E_IRIS',
  E_IRIS_AUTH: 'E_IRIS_AUTH',
  E_IRIS_SCHEMA: 'E_IRIS_SCHEMA',
  E_RENDER: 'E_RENDER',
  E_DELIVERY: 'E_DELIVERY',
  E_MO_FILE: 'E_MO_FILE',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, status = 400, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.details = details;
  }

  static notFound(what = 'Resource'): AppError {
    return new AppError(ErrorCodes.E_NOT_FOUND, `${what} not found`, 404);
  }
  static forbidden(message = 'Not allowed'): AppError {
    return new AppError(ErrorCodes.E_FORBIDDEN, message, 403);
  }
  static auth(message = 'Authentication required'): AppError {
    return new AppError(ErrorCodes.E_AUTH, message, 401);
  }
  static validation(message: string, details?: unknown): AppError {
    return new AppError(ErrorCodes.E_VALIDATION, message, 422, details);
  }
  static state(message: string): AppError {
    return new AppError(ErrorCodes.E_STATE, message, 409);
  }
  static conflict(message: string, details?: unknown): AppError {
    return new AppError(ErrorCodes.E_CONFLICT, message, 409, details);
  }
}
