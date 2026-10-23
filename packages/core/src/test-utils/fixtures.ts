import { PrismaClient } from '@prisma/client';
import type { AppConfig } from '../config';
import { loadConfig } from '../config';
import type { CoreContext } from '../context';
import { createLogger, newPaymentReference } from '../infra';
import { DemoPaymentAdapter, PaymentAdapter, ProviderUnavailableError, VerifiedTransaction } from '../adapters/payment';
import { MockEmailAdapter, MockWhatsappAdapter } from '../adapters/messaging';

let prisma: PrismaClient | null = null;
export function testPrisma(): PrismaClient {
  prisma ??= new PrismaClient();
  return prisma;
}

/** TRUNCATE bypasses the append-only row triggers, so test resets are possible. */
export async function resetDb(db = testPrisma()) {
  const tables = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await db.$executeRawUnsafe(
    `TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`,
  );
}

export class Clock {
  constructor(public t: Date) {}
  now = () => new Date(this.t.getTime());
  set(iso: string) {
    this.t = new Date(iso);
  }
  advanceDays(d: number) {
    this.t = new Date(this.t.getTime() + d * 86400000);
  }
}

/** Fake Paystack adapter: verification result is set per reference by the test. */
export class FakePaystack implements PaymentAdapter {
  readonly provider = 'PAYSTACK' as const;
  results = new Map<string, Partial<VerifiedTransaction>>();
  verifyCalls = 0;
  async initialize(p: { reference: string }) {
    return { checkoutUrl: `https://checkout.paystack.test/${p.reference}`, accessCode: 'ac_test' };
  }
  /** Saved-card charges: result per reference may be preset in `charges`; default success. */
  charges: { reference: string; amountKobo: number; authorizationCode: string }[] = [];
  chargeResult: 'success' | 'failed' | 'throw' = 'success';
  async chargeAuthorization(p: { reference: string; amountKobo: number; authorizationCode: string; currency: string }): Promise<VerifiedTransaction> {
    this.charges.push(p);
    if (this.chargeResult === 'throw') throw new ProviderUnavailableError('timeout');
    const r: Partial<VerifiedTransaction> = {
      status: this.chargeResult,
      reference: p.reference,
      amountKobo: p.amountKobo,
      currency: p.currency,
      paidAt: new Date(),
      providerTransactionId: `tx_${p.reference}`,
      isLive: true,
      authorization: { code: p.authorizationCode, reusable: true, brand: 'visa', last4: '4081', expiry: '12/30' },
    };
    this.results.set(p.reference, r);
    return this.verify(p.reference);
  }
  async verify(reference: string): Promise<VerifiedTransaction> {
    this.verifyCalls++;
    const r = this.results.get(reference);
    return {
      provider: 'PAYSTACK',
      status: 'pending',
      reference,
      amountKobo: 0,
      currency: 'NGN',
      paidAt: null,
      providerTransactionId: '',
      subaccountCode: null,
      isLive: true,
      channel: 'card',
      feesKobo: 0,
      ...r,
    } as VerifiedTransaction;
  }
}

export function testContext(opts: { clock?: Clock; mode?: 'demo' | 'live'; config?: Partial<AppConfig> } = {}) {
  const db = testPrisma();
  const base = loadConfig({
    ...process.env,
    APP_MODE: 'demo',
    WEB_BASE_URL: 'http://localhost:3000',
  });
  const config: AppConfig = {
    ...base,
    appMode: opts.mode ?? 'live',
    paystack: { secretKey: 'sk_live_testsecret', liveMode: true, baseUrl: 'http://paystack.invalid' },
    whatsapp: { ...base.whatsapp, enabled: true, appSecret: 'meta_app_secret', verifyToken: 'verify_me' },
    ...opts.config,
  };
  const paystack = new FakePaystack();
  const whatsapp = new MockWhatsappAdapter();
  const email = new MockEmailAdapter();
  const clock = opts.clock ?? new Clock(new Date('2026-03-10T10:00:00Z'));
  const ctx: CoreContext = {
    prisma: db,
    config,
    adapters: {
      payments: { PAYSTACK: paystack, DEMO: new DemoPaymentAdapter(db, config.webBaseUrl) },
      whatsapp,
      email,
    },
    logger: createLogger('test'),
    now: clock.now,
  };
  return { ctx, db, paystack, whatsapp, email, clock };
}

export async function seedOrg(
  db: PrismaClient,
  p: { name: string; slug: string; graceDays?: number; priceKobo?: number; durationDays?: number; tier?: 'STARTER' | 'GROWTH' | 'PRO' },
) {
  const owner = await db.user.create({
    data: { email: `${p.slug}-owner@example.com`, name: `${p.name} Owner`, passwordHash: 'x' },
  });
  const org = await db.organization.create({
    data: {
      name: p.name,
      displayName: p.name,
      supportEmail: `${p.slug}@example.com`,
      onboardingComplete: true,
      staff: { create: { userId: owner.id, role: 'OWNER' } },
      paymentConfig: {
        create: { status: 'ACTIVE', subaccountCode: `ACCT_${p.slug.replace(/-/g, '')}`, platformFeeBps: 500, feeBearer: 'SUBACCOUNT' },
      },
      reminderSettings: { create: { sendWindowStartHour: 0, sendWindowEndHour: 24, maxMessagesPerMemberPerDay: 5 } },
      // Paid Growth subscription well beyond any test clock, so billing doesn't interfere.
      subscription: {
        create: {
          tier: p.tier ?? 'GROWTH',
          status: 'ACTIVE',
          trialEndsAt: new Date('2026-01-01T00:00:00Z'),
          currentPeriodEnd: new Date('2030-01-01T00:00:00Z'),
        },
      },
    },
  });
  const community = await db.community.create({
    data: {
      organizationId: org.id,
      name: `${p.name} Community`,
      slug: p.slug,
      whatsappInviteUrl: 'https://chat.whatsapp.com/SECRETinvite12345',
      gracePeriodDays: p.graceDays ?? 0,
    },
  });
  const plan = await db.plan.create({
    data: {
      organizationId: org.id,
      communityId: community.id,
      name: 'Monthly',
      priceKobo: p.priceKobo ?? 500000,
      durationDays: p.durationDays ?? 30,
    },
  });
  return { owner, org, community, plan };
}

export async function seedMember(
  db: PrismaClient,
  orgId: string,
  p: { email: string; phone?: string; whatsappConsent?: boolean },
) {
  const account = await db.memberAccount.upsert({ where: { email: p.email }, create: { email: p.email }, update: {} });
  const member = await db.member.create({
    data: {
      organizationId: orgId,
      memberAccountId: account.id,
      fullName: 'Ada Obi',
      email: p.email,
      phoneE164: p.phone ?? '+2348031234567',
    },
  });
  if (p.whatsappConsent) {
    await db.notificationConsent.create({
      data: {
        organizationId: orgId,
        memberId: member.id,
        channel: 'WHATSAPP',
        scope: 'membership_service',
        status: 'GRANTED',
        phoneE164: member.phoneE164,
        wordingVersion: 'wa-v1',
        wordingText: 'test',
        source: 'test',
        grantedAt: new Date(),
      },
    });
  }
  return { account, member };
}

export async function createPendingOrder(
  db: PrismaClient,
  s: { org: { id: string }; community: { id: string; name: string }; plan: { id: string; name: string; priceKobo: number; durationDays: number } },
  memberId: string,
  provider: 'PAYSTACK' | 'DEMO' = 'PAYSTACK',
) {
  return db.order.create({
    data: {
      organizationId: s.org.id,
      communityId: s.community.id,
      planId: s.plan.id,
      memberId,
      reference: newPaymentReference(),
      provider,
      isDemo: provider === 'DEMO',
      planNameSnapshot: s.plan.name,
      communityNameSnapshot: s.community.name,
      amountKobo: s.plan.priceKobo,
      currency: 'NGN',
      durationDays: s.plan.durationDays,
      subaccountCodeSnapshot: provider === 'PAYSTACK' ? `ACCT_${s.community.name.split(' ')[0].toLowerCase()}` : null,
    },
  });
}

export function successFor(
  order: { reference: string; amountKobo: number },
  paidAt: Date,
  overrides: Partial<VerifiedTransaction> = {},
): Partial<VerifiedTransaction> {
  return {
    status: 'success',
    reference: order.reference,
    amountKobo: order.amountKobo,
    currency: 'NGN',
    paidAt,
    providerTransactionId: `tx_${order.reference}`,
    isLive: true,
    ...overrides,
  };
}
