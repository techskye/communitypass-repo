import type { PrismaClient } from '@prisma/client';
import type { AppConfig } from '../config';
import { hmacHex, timingSafeEqualHex } from '../infra';

/**
 * Outcome of a send attempt.
 * - accepted: provider accepted the request (not proof of delivery).
 * - retryable: provider clearly did NOT accept (e.g. 429, connection refused) — safe to retry.
 * - permanent: provider rejected it for a reason retrying will not fix.
 * - ambiguous: we cannot tell whether the provider accepted it (timeout after sending, 5xx).
 *   Unless `safeToRetry` (idempotency key supported), this is flagged for review instead of resent.
 */
export type SendOutcome =
  | { kind: 'accepted'; providerMessageId: string | null }
  | { kind: 'retryable'; code: string; message: string; retryAfterMs?: number }
  | { kind: 'permanent'; code: string; message: string }
  | { kind: 'ambiguous'; code: string; message: string; safeToRetry: boolean };

export interface TemplateParam {
  type: 'text';
  text: string;
}

export interface WhatsappTemplateMessage {
  toE164: string;
  templateName: string;
  language: string;
  bodyParams: string[];
  /** Used for the mock outbox only. */
  previewText: string;
}

export interface WhatsappAdapter {
  readonly kind: 'cloud_api' | 'mock' | 'disabled';
  sendTemplate(msg: WhatsappTemplateMessage): Promise<SendOutcome>;
}

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey?: string;
}

export interface EmailAdapter {
  readonly kind: 'resend' | 'mock' | 'disabled';
  send(msg: EmailMessage): Promise<SendOutcome>;
}

/**
 * Meta webhook signature: `X-Hub-Signature-256: sha256=<hex>` = HMAC-SHA256(raw body, app secret).
 */
export function verifyMetaSignature(
  rawBody: Buffer | undefined,
  header: string | undefined,
  appSecret: string | null,
): boolean {
  if (!rawBody || !header || !appSecret) return false;
  const [algo, sig] = header.trim().split('=');
  if (algo !== 'sha256' || !sig) return false;
  return timingSafeEqualHex(hmacHex('sha256', appSecret, rawBody), sig.toLowerCase());
}

function classifyHttp(status: number, code: string, message: string, idempotent: boolean): SendOutcome {
  if (status === 429) return { kind: 'retryable', code, message };
  if (status >= 500) return { kind: 'ambiguous', code, message, safeToRetry: idempotent };
  return { kind: 'permanent', code, message };
}

function isConnectError(e: unknown): boolean {
  const code = (e as any)?.cause?.code ?? (e as any)?.code;
  return ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET_BEFORE_SEND'].includes(code);
}

/** Official WhatsApp Cloud API (Graph API) template sender. */
export class WhatsappCloudApiAdapter implements WhatsappAdapter {
  readonly kind = 'cloud_api' as const;
  constructor(
    private readonly cfg: AppConfig['whatsapp'],
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 15000,
  ) {}

  async sendTemplate(msg: WhatsappTemplateMessage): Promise<SendOutcome> {
    const url = `https://graph.facebook.com/${this.cfg.graphVersion}/${this.cfg.phoneNumberId}/messages`;
    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: msg.toE164.replace(/^\+/, ''),
      type: 'template',
      template: {
        name: msg.templateName,
        language: { code: msg.language },
        components: msg.bodyParams.length
          ? [{ type: 'body', parameters: msg.bodyParams.map((t) => ({ type: 'text', text: t })) }]
          : [],
      },
    };
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.cfg.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      if (isConnectError(e)) return { kind: 'retryable', code: 'network', message: 'Connection failed' };
      return { kind: 'ambiguous', code: 'timeout', message: 'No response from WhatsApp', safeToRetry: false };
    }
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      /* ignore */
    }
    if (res.ok) {
      return { kind: 'accepted', providerMessageId: json?.messages?.[0]?.id ?? null };
    }
    const errCode = String(json?.error?.code ?? res.status);
    const errMsg = String(json?.error?.message ?? 'WhatsApp API error').slice(0, 300);
    // Throughput / rate-limit error codes are retryable.
    if (['4', '80007', '130429', '131048', '131056'].includes(errCode)) {
      return { kind: 'retryable', code: errCode, message: errMsg };
    }
    return classifyHttp(res.status, errCode, errMsg, false);
  }
}

/** Resend transactional email adapter (POST https://api.resend.com/emails). */
export class ResendEmailAdapter implements EmailAdapter {
  readonly kind = 'resend' as const;
  constructor(
    private readonly cfg: AppConfig['email'],
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 15000,
  ) {}

  async send(msg: EmailMessage): Promise<SendOutcome> {
    let res: Response;
    try {
      res = await this.fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.cfg.resendApiKey}`,
          'Content-Type': 'application/json',
          ...(msg.idempotencyKey ? { 'Idempotency-Key': msg.idempotencyKey.slice(0, 256) } : {}),
        },
        body: JSON.stringify({
          from: this.cfg.from,
          to: [msg.to],
          subject: msg.subject,
          html: msg.html,
          text: msg.text,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      if (isConnectError(e)) return { kind: 'retryable', code: 'network', message: 'Connection failed' };
      return {
        kind: 'ambiguous',
        code: 'timeout',
        message: 'No response from email provider',
        safeToRetry: !!msg.idempotencyKey,
      };
    }
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      /* ignore */
    }
    if (res.ok) return { kind: 'accepted', providerMessageId: json?.id ?? null };
    return classifyHttp(
      res.status,
      String(json?.name ?? res.status),
      String(json?.message ?? 'Email provider error').slice(0, 300),
      !!msg.idempotencyKey,
    );
  }
}

/**
 * Deterministic mock adapters for demo mode and tests. They NEVER contact real providers.
 * Deterministic failure rules (by recipient):
 *   phone ending 0999 / email starting "fail@"     -> permanent failure
 *   phone ending 0998 / email starting "slow@"     -> ambiguous (timeout)
 *   phone ending 0997 / email starting "busy@"     -> retryable (rate limited)
 */
export class MockWhatsappAdapter implements WhatsappAdapter {
  readonly kind = 'mock' as const;
  public readonly sent: WhatsappTemplateMessage[] = [];
  constructor(private readonly prisma?: PrismaClient) {}

  async sendTemplate(msg: WhatsappTemplateMessage): Promise<SendOutcome> {
    if (msg.toE164.endsWith('0999')) return { kind: 'permanent', code: '131026', message: 'Mock: message undeliverable' };
    if (msg.toE164.endsWith('0998')) return { kind: 'ambiguous', code: 'timeout', message: 'Mock: timeout', safeToRetry: false };
    if (msg.toE164.endsWith('0997')) return { kind: 'retryable', code: '130429', message: 'Mock: rate limited' };
    this.sent.push(msg);
    const id = `wamid.MOCK.${this.sent.length}.${Date.now()}`;
    if (this.prisma) {
      await this.prisma.demoOutboxMessage.create({
        data: {
          channel: 'WHATSAPP',
          recipient: msg.toE164,
          body: msg.previewText,
          meta: { template: msg.templateName, language: msg.language, providerMessageId: id },
        },
      });
    }
    return { kind: 'accepted', providerMessageId: id };
  }
}

export class MockEmailAdapter implements EmailAdapter {
  readonly kind = 'mock' as const;
  public readonly sent: EmailMessage[] = [];
  constructor(private readonly prisma?: PrismaClient) {}

  async send(msg: EmailMessage): Promise<SendOutcome> {
    if (msg.to.startsWith('fail@')) return { kind: 'permanent', code: 'validation_error', message: 'Mock: rejected' };
    if (msg.to.startsWith('slow@')) return { kind: 'ambiguous', code: 'timeout', message: 'Mock: timeout', safeToRetry: false };
    if (msg.to.startsWith('busy@')) return { kind: 'retryable', code: 'rate_limit_exceeded', message: 'Mock: rate limited' };
    this.sent.push(msg);
    if (this.prisma) {
      await this.prisma.demoOutboxMessage.create({
        data: {
          channel: 'EMAIL',
          recipient: msg.to,
          subject: msg.subject,
          // Never persist magic-link tokens, even in the demo outbox.
          body: msg.text.replace(/#token=[A-Za-z0-9_-]+/g, '#token=[redacted]'),
        },
      });
    }
    return { kind: 'accepted', providerMessageId: `mock-email-${this.sent.length}` };
  }
}

export class DisabledWhatsappAdapter implements WhatsappAdapter {
  readonly kind = 'disabled' as const;
  async sendTemplate(): Promise<SendOutcome> {
    return { kind: 'permanent', code: 'disabled', message: 'WhatsApp integration is disabled' };
  }
}

export class DisabledEmailAdapter implements EmailAdapter {
  readonly kind = 'disabled' as const;
  async send(): Promise<SendOutcome> {
    return { kind: 'permanent', code: 'disabled', message: 'Email integration is disabled' };
  }
}
