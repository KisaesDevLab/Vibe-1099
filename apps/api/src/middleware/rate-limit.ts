/**
 * Redis fixed-window rate limiting — applied to ALL public endpoints
 * (client portal, recipient portal, W-9) and login.
 */
import type { NextFunction, Request, Response } from 'express';
import { AppError, ErrorCodes } from '@vibe1099/shared';
import { getRedis } from '@vibe1099/core';

export function rateLimit(opts: { key: string; limit: number; windowSec: number }) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const ip = req.ip ?? 'unknown';
      const redisKey = `rl:${opts.key}:${ip}`;
      const redis = getRedis();
      const count = await redis.incr(redisKey);
      if (count === 1) await redis.expire(redisKey, opts.windowSec);
      if (count > opts.limit) {
        res.setHeader('retry-after', String(opts.windowSec));
        next(new AppError(ErrorCodes.E_RATE_LIMIT, 'Too many requests — slow down', 429));
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Attempt-lockout counter (recipient last-4 challenge, login): increments on
 * failure, throws E_LOCKED_OUT past the limit. Returns helpers for the caller.
 */
export async function checkLockout(scopeKey: string, limit = 5, windowSec = 900): Promise<void> {
  const redis = getRedis();
  const count = await redis.get(`lock:${scopeKey}`);
  if (count && parseInt(count, 10) >= limit) {
    throw new AppError(ErrorCodes.E_LOCKED_OUT, 'Too many failed attempts — locked out. Staff has been notified.', 423);
  }
}

export async function recordFailure(scopeKey: string, windowSec = 900): Promise<number> {
  const redis = getRedis();
  const key = `lock:${scopeKey}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, windowSec);
  return count;
}

export async function clearFailures(scopeKey: string): Promise<void> {
  await getRedis().del(`lock:${scopeKey}`);
}
