import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import pino, { Logger } from 'pino';
import { Prisma, PrismaClient } from '@prisma/client';

export type Tx = Prisma.TransactionClient;
export type Db = PrismaClient;

/** Paths that must never reach logs (tokens, secrets, cookies, raw message payloads). */
export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-paystack-signature"]',
  'req.headers["x-hub-signature-256"]',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  'token',
  '*.token',
  'password',
  '*.password',
  'accessToken',
  '*.accessToken',
  'secretKey',
  '*.secretKey',
  'whatsappInviteUrl',
  '*.whatsappInviteUrl',
  'payload',
  '*.payload',
  'body',
  '*.body',
];

export function createLogger(name: string): Logger {
  return pino({
    name,
    level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
    redact: { paths: LOG_REDACT_PATHS, censor: '[redacted]' },
  });
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Constant-time comparison of two hex digests; false on any length/format mismatch. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b)) return false;
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}

export function hmacHex(algorithm: 'sha512' | 'sha256', key: string, raw: Buffer | string): string {
  return createHmac(algorithm, key).update(raw).digest('hex');
}

/** Payment reference: unambiguous, URL-safe, unique (also enforced by a DB constraint). */
export function newPaymentReference(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(16);
  let s = '';
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return `CP-${s}`;
}

export function newId(): string {
  return `c${randomBytes(12).toString('hex')}`;
}

export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus = 400,
  ) {
    super(message);
  }
}

export class NotFoundError extends DomainError {
  constructor(what = 'Resource') {
    super('NOT_FOUND', `${what} not found`, 404);
  }
}

export function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}

export interface AuditEntry {
  organizationId?: string | null;
  actorType: 'USER' | 'MEMBER' | 'SYSTEM' | 'PROVIDER' | 'ADMIN';
  actorId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
}

export async function audit(db: Tx | Db, e: AuditEntry): Promise<void> {
  await db.auditLog.create({
    data: {
      organizationId: e.organizationId ?? null,
      actorType: e.actorType,
      actorId: e.actorId ?? null,
      action: e.action,
      entityType: e.entityType,
      entityId: e.entityId ?? null,
      metadata: (e.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}
