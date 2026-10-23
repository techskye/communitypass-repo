import type { PrismaClient } from '@prisma/client';
import type { AppConfig } from '../config';
import { DomainError, hmacHex, timingSafeEqualHex } from '../infra';

export type ProviderTxStatus =
  | 'success'
  | 'failed'
  | 'abandoned'
  | 'pending'
  | 'reversed'
  | 'not_found'
  | 'unknown';

/** Result of a server-side verification call. Never derived from browser input. */
export interface VerifiedTransaction {
  provider: 'PAYSTACK' | 'DEMO';
  status: ProviderTxStatus;
  reference: string;
  amountKobo: number;
  currency: string;
  paidAt: Date | null;
  providerTransactionId: string;
  /** Subaccount code reported by the provider, when the provider exposes it. */
  subaccountCode: string | null;
  /** True only for real Paystack live-mode transactions. */
  isLive: boolean;
  channel: string | null;
  feesKobo: number | null;
  /** Reusable card authorization (for creator subscription renewals), when the provider returns one. */
  authorization?: CardAuthorization | null;
}

export interface CardAuthorization {
  code: string;
  reusable: boolean;
  brand: string | null;
  last4: string | null;
  expiry: string | null;
}

export interface InitializeParams {
  reference: string;
  email: string;
  amountKobo: number;
  currency: string;
  callbackUrl: string;
  subaccountCode: string | null;
  platformFeeKobo: number;
  feeBearer: 'ACCOUNT' | 'SUBACCOUNT' | null;
  metadata: Record<string, string>;
  /** Restrict payment channels (e.g. ['card'] so a reusable authorization is created). */
  channels?: string[];
}

export interface ChargeAuthorizationParams {
  reference: string;
  email: string;
  amountKobo: number;
  currency: string;
  authorizationCode: string;
  metadata: Record<string, string>;
}

export interface InitializeResult {
  checkoutUrl: string;
  accessCode: string | null;
}

export interface PaymentAdapter {
  readonly provider: 'PAYSTACK' | 'DEMO';
  initialize(p: InitializeParams): Promise<InitializeResult>;
  verify(reference: string): Promise<VerifiedTransaction>;
  /** Charges a saved card authorization (recurring creator subscription). */
  chargeAuthorization(p: ChargeAuthorizationParams): Promise<VerifiedTransaction>;
}

export class ProviderUnavailableError extends DomainError {
  constructor(message: string) {
    super('PROVIDER_UNAVAILABLE', message, 503);
  }
}

/**
 * Paystack webhook signature: HMAC-SHA512 of the exact raw request body, keyed with the
 * secret key, hex encoded in the `x-paystack-signature` header. Constant-time comparison.
 */
export function verifyPaystackSignature(
  rawBody: Buffer | undefined,
  signature: string | undefined,
  secretKey: string | null,
): boolean {
  if (!rawBody || !signature || !secretKey) return false;
  const expected = hmacHex('sha512', secretKey, rawBody);
  return timingSafeEqualHex(expected, signature.trim().toLowerCase());
}

function mapPaystackStatus(s: unknown): ProviderTxStatus {
  switch (s) {
    case 'success':
      return 'success';
    case 'failed':
      return 'failed';
    case 'abandoned':
      return 'abandoned';
    case 'reversed':
      return 'reversed';
    case 'ongoing':
    case 'pending':
    case 'processing':
    case 'queued':
      return 'pending';
    default:
      return 'unknown';
  }
}

/**
 * Live Paystack adapter (hosted checkout). Uses the platform secret key server-side only.
 * Endpoints: POST /transaction/initialize, GET /transaction/verify/:reference.
 */
export class PaystackAdapter implements PaymentAdapter {
  readonly provider = 'PAYSTACK' as const;
  constructor(
    private readonly cfg: AppConfig['paystack'],
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 15000,
  ) {}

  private async call(path: string, init: RequestInit): Promise<any> {
    if (!this.cfg.secretKey) throw new ProviderUnavailableError('Paystack is not configured');
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.cfg.baseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.cfg.secretKey}`,
          'Content-Type': 'application/json',
          ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new ProviderUnavailableError('Could not reach Paystack');
    }
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      /* non-JSON */
    }
    if (res.status === 404) return { __notFound: true, json };
    if (!res.ok || !json?.status) {
      throw new ProviderUnavailableError(
        `Paystack error ${res.status}${json?.message ? `: ${String(json.message).slice(0, 200)}` : ''}`,
      );
    }
    return json;
  }

  async initialize(p: InitializeParams): Promise<InitializeResult> {
    const body: Record<string, unknown> = {
      email: p.email,
      amount: p.amountKobo, // integer kobo
      currency: p.currency,
      reference: p.reference,
      callback_url: p.callbackUrl,
      metadata: p.metadata,
    };
    if (p.channels?.length) body.channels = p.channels;
    if (p.subaccountCode) {
      body.subaccount = p.subaccountCode;
      // Explicit flat platform fee (kobo) to the main account; overrides the subaccount's
      // default percentage split so no fee is ever deducted implicitly.
      body.transaction_charge = p.platformFeeKobo;
      if (p.feeBearer) body.bearer = p.feeBearer === 'SUBACCOUNT' ? 'subaccount' : 'account';
    }
    const json = await this.call('/transaction/initialize', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const url = json?.data?.authorization_url;
    if (typeof url !== 'string' || !url.startsWith('https://')) {
      throw new ProviderUnavailableError('Paystack did not return a checkout URL');
    }
    return { checkoutUrl: url, accessCode: json.data.access_code ?? null };
  }

  async verify(reference: string): Promise<VerifiedTransaction> {
    const json = await this.call(`/transaction/verify/${encodeURIComponent(reference)}`, {
      method: 'GET',
    });
    if (json.__notFound) {
      return {
        provider: 'PAYSTACK',
        status: 'not_found',
        reference,
        amountKobo: 0,
        currency: '',
        paidAt: null,
        providerTransactionId: '',
        subaccountCode: null,
        isLive: false,
        channel: null,
        feesKobo: null,
      };
    }
    return mapPaystackTransaction(json.data ?? {});
  }

  /** POST /transaction/charge_authorization — charge a reusable card authorization. */
  async chargeAuthorization(p: ChargeAuthorizationParams): Promise<VerifiedTransaction> {
    const json = await this.call('/transaction/charge_authorization', {
      method: 'POST',
      body: JSON.stringify({
        email: p.email,
        amount: p.amountKobo,
        currency: p.currency,
        authorization_code: p.authorizationCode,
        reference: p.reference,
        metadata: p.metadata,
      }),
    });
    if (json.__notFound) throw new ProviderUnavailableError('Paystack charge endpoint not found');
    return mapPaystackTransaction(json.data ?? {});
  }
}

function mapPaystackTransaction(d: any): VerifiedTransaction {
  const paidAtRaw = d.paid_at ?? d.paidAt ?? d.transaction_date ?? null;
  const auth = d.authorization;
  return {
    provider: 'PAYSTACK',
    status: mapPaystackStatus(d.status),
    reference: String(d.reference ?? ''),
    amountKobo: Number.isInteger(d.amount) ? d.amount : Number.NaN,
    currency: String(d.currency ?? ''),
    paidAt: paidAtRaw ? new Date(paidAtRaw) : null,
    providerTransactionId: d.id !== undefined ? String(d.id) : '',
    subaccountCode: typeof d.subaccount?.subaccount_code === 'string' ? d.subaccount.subaccount_code : null,
    isLive: d.domain === 'live',
    channel: typeof d.channel === 'string' ? d.channel : null,
    feesKobo: Number.isInteger(d.fees) ? d.fees : null,
    authorization:
      auth && typeof auth.authorization_code === 'string'
        ? {
            code: auth.authorization_code,
            reusable: auth.reusable === true,
            brand: typeof auth.brand === 'string' ? auth.brand : typeof auth.card_type === 'string' ? auth.card_type : null,
            last4: typeof auth.last4 === 'string' ? auth.last4 : null,
            expiry: auth.exp_month && auth.exp_year ? `${auth.exp_month}/${String(auth.exp_year).slice(-2)}` : null,
          }
        : null,
  };
}

/**
 * Deterministic demo payment provider. The "hosted checkout" is a clearly-labelled demo
 * page in the web app; state lives in demo_transactions. Never live, never real money.
 */
export class DemoPaymentAdapter implements PaymentAdapter {
  readonly provider = 'DEMO' as const;
  constructor(
    private readonly prisma: PrismaClient,
    private readonly webBaseUrl: string,
  ) {}

  async initialize(p: InitializeParams): Promise<InitializeResult> {
    await this.prisma.demoTransaction.create({
      data: { reference: p.reference, amountKobo: p.amountKobo, currency: p.currency },
    });
    return {
      checkoutUrl: `${this.webBaseUrl}/demo-checkout/${encodeURIComponent(p.reference)}`,
      accessCode: null,
    };
  }

  async verify(reference: string): Promise<VerifiedTransaction> {
    const t = await this.prisma.demoTransaction.findUnique({ where: { reference } });
    if (!t) {
      return {
        provider: 'DEMO',
        status: 'not_found',
        reference,
        amountKobo: 0,
        currency: '',
        paidAt: null,
        providerTransactionId: '',
        subaccountCode: null,
        isLive: false,
        channel: null,
        feesKobo: null,
      };
    }
    return {
      provider: 'DEMO',
      status: (['success', 'failed', 'abandoned', 'pending'].includes(t.status)
        ? t.status
        : 'unknown') as ProviderTxStatus,
      reference: t.reference,
      amountKobo: t.amountKobo,
      currency: t.currency,
      paidAt: t.paidAt,
      providerTransactionId: `demo_${t.id}`,
      subaccountCode: null,
      isLive: false,
      channel: 'demo',
      feesKobo: 0,
      authorization:
        t.status === 'success'
          ? { code: `AUTH_demo_${t.id}`, reusable: true, brand: 'visa', last4: '4081', expiry: '12/30' }
          : null,
    };
  }

  /** Demo: saved-card charges succeed unless the amount ends in 99 kobo (deterministic failure). */
  async chargeAuthorization(p: ChargeAuthorizationParams): Promise<VerifiedTransaction> {
    const ok = p.amountKobo % 100 !== 99;
    await this.prisma.demoTransaction.create({
      data: {
        reference: p.reference,
        amountKobo: p.amountKobo,
        currency: p.currency,
        status: ok ? 'success' : 'failed',
        paidAt: ok ? new Date() : null,
      },
    });
    return this.verify(p.reference);
  }
}
