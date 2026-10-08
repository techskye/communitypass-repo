import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  ExceptionFilter,
  HttpException,
  Injectable,
  NestMiddleware,
  PipeTransform,
} from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import type { NextFunction, Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { ZodSchema } from 'zod';
import { DomainError, randomToken } from '@communitypass/core';
import type { CoreContext } from '@communitypass/core';

export const STAFF_COOKIE = 'cp_session';
export const MEMBER_COOKIE = 'cp_member';
export const CSRF_COOKIE = 'cp_csrf';
export const CSRF_HEADER = 'x-csrf-token';

/** Validates request bodies/queries with the shared zod schemas. */
export class ZodPipe<T> implements PipeTransform {
  constructor(private readonly schema: ZodSchema<T>) {}
  transform(value: unknown): T {
    const r = this.schema.safeParse(value);
    if (!r.success) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: r.error.issues[0]?.message ?? 'Invalid input',
        issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return r.data;
  }
}

/** Maps domain errors to HTTP without leaking internals. */
@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  constructor(private readonly core: CoreContext) {}
  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof DomainError) {
      res.status(exception.httpStatus).json({ code: exception.code, message: exception.message });
      return;
    }
    if (exception instanceof ThrottlerException) {
      res.status(429).json({ code: 'RATE_LIMITED', message: 'Too many requests. Please wait a moment and try again.' });
      return;
    }
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      const status = exception.getStatus();
      if (typeof body === 'object' && body && 'code' in body) {
        res.status(status).json(body);
      } else {
        res.status(status).json({
          code: status === 404 ? 'NOT_FOUND' : status === 403 ? 'FORBIDDEN' : status === 401 ? 'UNAUTHORIZED' : 'ERROR',
          message: typeof body === 'string' ? body : (body as any)?.message ?? exception.message,
        });
      }
      return;
    }
    this.core.logger.error({ err: (exception as Error)?.message, stack: (exception as Error)?.stack }, 'unhandled error');
    res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' });
  }
}

export function cookieOptions(core: CoreContext, maxAgeMs: number, httpOnly = true) {
  return {
    httpOnly,
    secure: core.config.cookieSecure,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: maxAgeMs,
  };
}

export function issueCsrfCookie(core: CoreContext, res: Response): string {
  const token = randomToken(24);
  // Readable by the web app so it can echo it in the X-CSRF-Token header (double-submit).
  res.cookie(CSRF_COOKIE, token, cookieOptions(core, 7 * 24 * 3600 * 1000, false));
  return token;
}

/**
 * CSRF protection for cookie-authenticated, state-changing requests:
 *  1. SameSite=Lax cookies,
 *  2. Origin/Referer must match the web origin when present,
 *  3. double-submit token: X-CSRF-Token header must equal the cp_csrf cookie.
 * Provider webhooks are exempt (they are authenticated by signatures instead).
 */
@Injectable()
export class CsrfMiddleware implements NestMiddleware {
  constructor(private readonly core: CoreContext) {}
  use(req: Request, res: Response, next: NextFunction) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const path = req.originalUrl.split('?')[0];
    if (path.startsWith('/api/webhooks/')) return next();
    const allowed = new URL(this.core.config.webBaseUrl).origin;
    const origin = req.headers.origin ?? (req.headers.referer ? safeOrigin(req.headers.referer) : undefined);
    if (origin && origin !== allowed) {
      res.status(403).json({ code: 'CSRF_ORIGIN', message: 'Request origin not allowed' });
      return;
    }
    const header = req.headers[CSRF_HEADER];
    const cookie = req.cookies?.[CSRF_COOKIE];
    if (typeof header !== 'string' || typeof cookie !== 'string' || !safeEqual(header, cookie)) {
      res.status(403).json({ code: 'CSRF_TOKEN', message: 'Missing or invalid CSRF token. Refresh the page and try again.' });
      return;
    }
    next();
  }
}

function safeOrigin(u: string): string | undefined {
  try {
    return new URL(u).origin;
  } catch {
    return undefined;
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && ab.length > 0 && timingSafeEqual(ab, bb);
}

export function clientIp(req: Request): string {
  return req.ip ?? 'unknown';
}
