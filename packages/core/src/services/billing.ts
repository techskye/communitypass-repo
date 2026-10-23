import type { OrganizationSubscription, Prisma, SubscriptionTier } from '@prisma/client';
import {
  DAY_MS,
  SUBSCRIPTION_GRACE_DAYS,
  SUBSCRIPTION_MAX_RENEWAL_ATTEMPTS,
  SUBSCRIPTION_TIERS,
  SUBSCRIPTION_TRIAL_DAYS,
  addMonthsUtc,
  getSubscriptionAccess,
  isTierUpgrade,
  subscriptionAllowsPayments,
  subscriptionPaidThrough,
} from '@communitypass/shared';
import type { CoreContext } from '../context';
import { audit, Db, DomainError, newPaymentReference, NotFoundError, Tx } from '../infra';
import type { PaymentAdapter, VerifiedTransaction } from '../adapters/payment';
import { ProviderUnavailableError } from '../adapters/payment';

/**
 * Creator subscriptions (CommunityPass SaaS billing).
 *
 * - Paid to the PLATFORM's own Paystack account (no subaccount split) — never mixed with member
 *   payments, which settle 100% to the creator's subaccount.
 * - Card is saved on the first checkout (Paystack reusable authorization) and charged monthly
 *   with charge_authorization. Each invoice is applied exactly once (row lock + status check).
 * - Access is derived from dates: trial / paid period, then a 7-day grace, then paused.
 */

export async function ensureSubscription(db: Tx | Db, organizationId: string, now: Date, tier: SubscriptionTier = 'GROWTH') {
  const existing = await db.organizationSubscription.findUnique({ where: { organizationId } });
  if (existing) return existing;
  return db.organizationSubscription.upsert({
    where: { organizationId },
    create: {
      organizationId,
      tier,
      status: 'TRIALING',
      trialEndsAt: new Date(now.getTime() + SUBSCRIPTION_TRIAL_DAYS * DAY_MS),
    },
    update: {},
  });
}

export async function getOrgEntitlements(db: Tx | Db, organizationId: string, now: Date) {
  const sub = await ensureSubscription(db, organizationId, now);
  const access = getSubscriptionAccess(sub, now);
  const tier = SUBSCRIPTION_TIERS[sub.tier];
  return {
    subscription: sub,
    access,
    tier,
    paymentsAllowed: subscriptionAllowsPayments(access),
    // Paid features (WhatsApp) require the tier AND a subscription in good standing.
    whatsappAllowed: tier.whatsappReminders && subscriptionAllowsPayments(access),
  };
}

export async function getOrgUsage(db: Tx | Db, organizationId: string, now: Date) {
  const [communities, activeMembers] = await Promise.all([
    db.community.count({ where: { organizationId } }),
    db.membership.count({ where: { organizationId, paidUntil: { gt: now } } }),
  ]);
  return { communities, activeMembers };
}

/** Throws if adding another community would exceed the plan. */
export async function assertCanAddCommunity(ctx: CoreContext, organizationId: string) {
  const now = ctx.now();
  const { tier } = await getOrgEntitlements(ctx.prisma, organizationId, now);
  const { communities } = await getOrgUsage(ctx.prisma, organizationId, now);
  if (tier.maxCommunities !== null && communities >= tier.maxCommunities) {
    throw new DomainError(
      'PLAN_LIMIT_COMMUNITIES',
      `Your ${tier.name} plan allows ${tier.maxCommunities} ${tier.maxCommunities === 1 ? 'community' : 'communities'}. Upgrade your plan to add more.`,
      403,
    );
  }
}

/** Whether a NEW (not currently paid) member may join, given the active-member limit. */
export async function memberLimitReached(db: Tx | Db, organizationId: string, now: Date): Promise<boolean> {
  const { tier } = await getOrgEntitlements(db, organizationId, now);
  if (tier.maxActiveMembers === null) return false;
  const { activeMembers } = await getOrgUsage(db, organizationId, now);
  return activeMembers >= tier.maxActiveMembers;
}

// ───────────────────────── Overview ─────────────────────────

export async function getBillingOverview(ctx: CoreContext, organizationId: string) {
  const now = ctx.now();
  const ent = await getOrgEntitlements(ctx.prisma, organizationId, now);
  const usage = await getOrgUsage(ctx.prisma, organizationId, now);
  const invoices = await ctx.prisma.subscriptionInvoice.findMany({
    where: { organizationId },
    orderBy: { createdAt: 'desc' },
    take: 24,
    select: {
      id: true, kind: true, tier: true, amountKobo: true, status: true, reference: true, provider: true,
      periodStart: true, periodEnd: true, paidAt: true, failureReason: true, createdAt: true,
    },
  });
  const s = ent.subscription;
  const paidThrough = subscriptionPaidThrough(s);
  return {
    tiers: Object.values(SUBSCRIPTION_TIERS),
    subscription: {
      tier: s.tier,
      pendingTier: s.pendingTier,
      access: ent.access,
      trialEndsAt: s.trialEndsAt,
      currentPeriodEnd: s.currentPeriodEnd,
      paidThrough,
      graceEndsAt: new Date(paidThrough.getTime() + SUBSCRIPTION_GRACE_DAYS * DAY_MS),
      cancelAtPeriodEnd: s.cancelAtPeriodEnd,
      autoRenew: !!s.authorizationCode && !s.cancelAtPeriodEnd,
      card: s.cardLast4 ? { brand: s.cardBrand, last4: s.cardLast4, expiry: s.cardExpiry } : null,
      failedAttempts: s.failedAttempts,
      nextRetryAt: s.nextRetryAt,
      priceKobo: SUBSCRIPTION_TIERS[s.pendingTier ?? s.tier].priceKobo,
    },
    usage,
    limits: { maxCommunities: ent.tier.maxCommunities, maxActiveMembers: ent.tier.maxActiveMembers },
    paymentsAllowed: ent.paymentsAllowed,
    whatsappAllowed: ent.whatsappAllowed,
    invoices,
  };
}

// ───────────────────────── Plan changes ─────────────────────────

/**
 * Upgrades apply immediately (new price from the next renewal). Downgrades are scheduled for the
 * next renewal and are refused if current usage exceeds the lower plan's limits.
 */
export async function changePlan(ctx: CoreContext, organizationId: string, userId: string, target: SubscriptionTier) {
  const now = ctx.now();
  const sub = await ensureSubscription(ctx.prisma, organizationId, now);
  const def = SUBSCRIPTION_TIERS[target];
  if (target === sub.tier) {
    if (sub.pendingTier) {
      await ctx.prisma.organizationSubscription.update({ where: { id: sub.id }, data: { pendingTier: null } });
    }
    return { effective: 'unchanged' as const };
  }
  const usage = await getOrgUsage(ctx.prisma, organizationId, now);
  if (def.maxCommunities !== null && usage.communities > def.maxCommunities) {
    throw new DomainError('DOWNGRADE_BLOCKED', `You have ${usage.communities} communities; the ${def.name} plan allows ${def.maxCommunities}.`, 409);
  }
  if (def.maxActiveMembers !== null && usage.activeMembers > def.maxActiveMembers) {
    throw new DomainError('DOWNGRADE_BLOCKED', `You have ${usage.activeMembers} active paid members; the ${def.name} plan allows ${def.maxActiveMembers}.`, 409);
  }
  const upgrade = isTierUpgrade(sub.tier, target);
  const access = getSubscriptionAccess(sub, now);
  // During the trial (or with no paid period yet) any change applies immediately.
  const immediate = upgrade || access === 'trialing' || !sub.currentPeriodEnd;
  await ctx.prisma.organizationSubscription.update({
    where: { id: sub.id },
    data: immediate ? { tier: target, pendingTier: null } : { pendingTier: target },
  });
  await audit(ctx.prisma, {
    organizationId,
    actorType: 'USER',
    actorId: userId,
    action: immediate ? 'subscription.plan_changed' : 'subscription.downgrade_scheduled',
    entityType: 'OrganizationSubscription',
    entityId: sub.id,
    metadata: { from: sub.tier, to: target },
  });
  return { effective: immediate ? ('now' as const) : ('next_renewal' as const) };
}

export async function setCancelAtPeriodEnd(ctx: CoreContext, organizationId: string, userId: string, cancel: boolean) {
  const sub = await ensureSubscription(ctx.prisma, organizationId, ctx.now());
  await ctx.prisma.organizationSubscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: cancel } });
  await audit(ctx.prisma, {
    organizationId,
    actorType: 'USER',
    actorId: userId,
    action: cancel ? 'subscription.cancel_requested' : 'subscription.resumed',
    entityType: 'OrganizationSubscription',
    entityId: sub.id,
  });
}

// ───────────────────────── Checkout (save card + pay a month) ─────────────────────────

function platformAdapter(ctx: CoreContext): { adapter: PaymentAdapter; provider: 'PAYSTACK' | 'DEMO' } {
  if (ctx.config.appMode === 'demo') return { adapter: ctx.adapters.payments.DEMO!, provider: 'DEMO' };
  const a = ctx.adapters.payments.PAYSTACK;
  if (!a) throw new DomainError('PAYMENTS_NOT_CONFIGURED', 'Subscription payments are not configured yet', 503);
  return { adapter: a, provider: 'PAYSTACK' };
}

/** Starts a card checkout for one month of the current (or scheduled) plan. Saves the card for auto-renewal. */
export async function startSubscriptionCheckout(ctx: CoreContext, organizationId: string, user: { id: string; email: string }) {
  const now = ctx.now();
  const sub = await ensureSubscription(ctx.prisma, organizationId, now);
  const tier = sub.pendingTier ?? sub.tier;
  const { adapter, provider } = platformAdapter(ctx);
  const reference = newPaymentReference('SUB');
  const invoice = await ctx.prisma.subscriptionInvoice.create({
    data: {
      organizationId,
      kind: 'CHECKOUT',
      tier,
      amountKobo: SUBSCRIPTION_TIERS[tier].priceKobo,
      reference,
      provider,
      createdAt: now,
    },
  });
  const init = await adapter.initialize({
    reference,
    email: sub.billingEmail ?? user.email,
    amountKobo: invoice.amountKobo,
    currency: 'NGN',
    callbackUrl: `${ctx.config.webBaseUrl}/creator/billing?reference=${encodeURIComponent(reference)}`,
    // No subaccount: subscription money goes to the platform's own account.
    subaccountCode: null,
    platformFeeKobo: 0,
    feeBearer: null,
    metadata: { kind: 'subscription', organizationId, invoiceId: invoice.id, tier },
    channels: ['card'],
  });
  await ctx.prisma.subscriptionInvoice.update({ where: { id: invoice.id }, data: { checkoutUrl: init.checkoutUrl } });
  if (!sub.billingEmail) {
    await ctx.prisma.organizationSubscription.update({ where: { id: sub.id }, data: { billingEmail: user.email } });
  }
  await audit(ctx.prisma, {
    organizationId,
    actorType: 'USER',
    actorId: user.id,
    action: 'subscription.checkout_started',
    entityType: 'SubscriptionInvoice',
    entityId: invoice.id,
    metadata: { tier, amountKobo: invoice.amountKobo },
  });
  return { reference, checkoutUrl: init.checkoutUrl };
}

export type InvoiceOutcome = 'paid' | 'already_paid' | 'not_successful' | 'mismatch' | 'unknown_reference';

/**
 * Applies a verified subscription payment exactly once. Paid time stacks: a month starts at the
 * later of now and the current paid-through date, so paying early or twice never loses time.
 */
export async function applySubscriptionPayment(ctx: CoreContext, reference: string, v: VerifiedTransaction): Promise<InvoiceOutcome> {
  const now = ctx.now();
  const outcome = await ctx.prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM subscription_invoices WHERE reference = ${reference} FOR UPDATE`;
    if (!rows.length) return 'unknown_reference' as const;
    const inv = await tx.subscriptionInvoice.findUniqueOrThrow({ where: { id: rows[0].id } });
    if (inv.status === 'PAID') return 'already_paid' as const;
    if (v.status !== 'success') {
      if (v.status === 'failed' || v.status === 'reversed') {
        await tx.subscriptionInvoice.update({ where: { id: inv.id }, data: { status: 'FAILED', failureReason: `Provider status: ${v.status}` } });
      }
      return 'not_successful' as const;
    }
    const expectedLive = inv.provider === 'PAYSTACK' ? ctx.config.paystack.liveMode : false;
    if (
      v.reference !== inv.reference ||
      v.provider !== inv.provider ||
      v.amountKobo !== inv.amountKobo ||
      v.currency !== inv.currency ||
      v.isLive !== expectedLive
    ) {
      await tx.subscriptionInvoice.update({ where: { id: inv.id }, data: { status: 'FAILED', failureReason: 'Verification mismatch (amount/currency/mode)' } });
      await tx.reconciliationIssue.create({
        data: {
          organizationId: inv.organizationId,
          reference,
          kind: v.amountKobo !== inv.amountKobo ? 'AMOUNT_MISMATCH' : v.currency !== inv.currency ? 'CURRENCY_MISMATCH' : 'MODE_MISMATCH',
          details: { kind: 'subscription', expectedKobo: inv.amountKobo, gotKobo: v.amountKobo, currency: v.currency, isLive: v.isLive },
        },
      });
      return 'mismatch' as const;
    }

    await tx.$queryRaw`SELECT id FROM organization_subscriptions WHERE "organizationId" = ${inv.organizationId} FOR UPDATE`;
    const sub = await tx.organizationSubscription.findUniqueOrThrow({ where: { organizationId: inv.organizationId } });
    const paidThrough = subscriptionPaidThrough(sub);
    const periodStart = paidThrough.getTime() > now.getTime() ? paidThrough : now;
    const periodEnd = addMonthsUtc(periodStart, 1);
    const auth = v.authorization;
    await tx.subscriptionInvoice.update({
      where: { id: inv.id },
      data: {
        status: 'PAID',
        paidAt: v.paidAt ?? now,
        providerTransactionId: v.providerTransactionId || null,
        isLive: v.isLive,
        periodStart,
        periodEnd,
        failureReason: null,
      },
    });
    await tx.organizationSubscription.update({
      where: { id: sub.id },
      data: {
        tier: inv.tier,
        pendingTier: sub.pendingTier === inv.tier ? null : sub.pendingTier,
        status: 'ACTIVE',
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        failedAttempts: 0,
        nextRetryAt: null,
        cancelAtPeriodEnd: inv.kind === 'CHECKOUT' ? false : sub.cancelAtPeriodEnd,
        ...(auth && auth.reusable
          ? { authorizationCode: auth.code, cardBrand: auth.brand, cardLast4: auth.last4, cardExpiry: auth.expiry }
          : {}),
      },
    });
    await audit(tx, {
      organizationId: inv.organizationId,
      actorType: 'PROVIDER',
      action: 'subscription.payment_applied',
      entityType: 'SubscriptionInvoice',
      entityId: inv.id,
      metadata: { tier: inv.tier, amountKobo: inv.amountKobo, periodStart: periodStart.toISOString(), periodEnd: periodEnd.toISOString(), kind: inv.kind },
    });
    await queueBillingNotice(tx, inv.organizationId, 'payment_receipt', `${inv.id}`, now);
    return 'paid' as const;
  }, { timeout: 20000 });
  return outcome;
}

/** Callback / reconciliation path: verify server-side then apply. */
export async function verifySubscriptionPayment(ctx: CoreContext, organizationId: string | null, reference: string) {
  const inv = await ctx.prisma.subscriptionInvoice.findUnique({ where: { reference } });
  if (!inv || (organizationId && inv.organizationId !== organizationId)) throw new NotFoundError('Invoice');
  if (inv.status !== 'PENDING') return { status: inv.status };
  const adapter = ctx.adapters.payments[inv.provider];
  if (!adapter) return { status: inv.status };
  const v = await adapter.verify(reference);
  await applySubscriptionPayment(ctx, reference, v);
  const fresh = await ctx.prisma.subscriptionInvoice.findUniqueOrThrow({ where: { reference } });
  return { status: fresh.status };
}

// ───────────────────────── Renewals & status maintenance (worker) ─────────────────────────

/**
 * Charges saved cards for subscriptions whose paid period has ended. At most one charge attempt
 * per period per retry slot (unique renewalKey); a pending (ambiguous) attempt blocks new ones.
 */
export async function processSubscriptionRenewals(ctx: CoreContext) {
  const now = ctx.now();
  const due = await ctx.prisma.organizationSubscription.findMany({
    where: {
      authorizationCode: { not: null },
      cancelAtPeriodEnd: false,
      currentPeriodEnd: { lte: now },
      failedAttempts: { lt: SUBSCRIPTION_MAX_RENEWAL_ATTEMPTS },
      OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
    },
    take: 100,
  });
  const summary = { checked: due.length, charged: 0, failed: 0, pending: 0, skipped: 0 };
  for (const sub of due) {
    try {
      const r = await renewOne(ctx, sub, now);
      summary[r]++;
    } catch (e) {
      summary.pending++;
      ctx.logger.warn({ org: sub.organizationId, err: (e as Error).message }, 'subscription renewal error');
    }
  }
  return summary;
}

async function renewOne(ctx: CoreContext, sub: OrganizationSubscription, now: Date): Promise<'charged' | 'failed' | 'pending' | 'skipped'> {
  const paidThrough = subscriptionPaidThrough(sub);
  if (paidThrough.getTime() > now.getTime()) return 'skipped';
  const open = await ctx.prisma.subscriptionInvoice.findFirst({
    where: { organizationId: sub.organizationId, status: 'PENDING', kind: 'RENEWAL', renewalFor: paidThrough },
  });
  if (open) return 'pending'; // outcome of an earlier attempt is still unknown — never double-charge
  const { adapter, provider } = platformAdapter(ctx);
  const tier = sub.pendingTier ?? sub.tier;
  const attempt = sub.failedAttempts + 1;
  const reference = newPaymentReference('SUB');
  let invoiceId: string;
  try {
    const inv = await ctx.prisma.subscriptionInvoice.create({
      data: {
        organizationId: sub.organizationId,
        kind: 'RENEWAL',
        tier,
        amountKobo: SUBSCRIPTION_TIERS[tier].priceKobo,
        reference,
        provider,
        renewalFor: paidThrough,
        createdAt: now,
        renewalKey: `${sub.organizationId}:${paidThrough.toISOString()}:${attempt}`,
      },
    });
    invoiceId = inv.id;
  } catch {
    return 'skipped'; // another worker created this attempt already
  }
  let v: VerifiedTransaction;
  try {
    v = await adapter.chargeAuthorization({
      reference,
      email: sub.billingEmail ?? '',
      amountKobo: SUBSCRIPTION_TIERS[tier].priceKobo,
      currency: 'NGN',
      authorizationCode: sub.authorizationCode!,
      metadata: { kind: 'subscription_renewal', organizationId: sub.organizationId, invoiceId },
    });
  } catch (e) {
    if (e instanceof ProviderUnavailableError) {
      // Unknown outcome: leave PENDING; reconciliation verifies by reference.
      return 'pending';
    }
    throw e;
  }
  const out = await applySubscriptionPayment(ctx, reference, v);
  if (out === 'paid' || out === 'already_paid') return 'charged';
  if (v.status === 'pending' || v.status === 'unknown') return 'pending';
  await markRenewalFailed(ctx, sub.organizationId, invoiceId, `Card charge ${v.status}`, now);
  return 'failed';
}

async function markRenewalFailed(ctx: CoreContext, organizationId: string, invoiceId: string, reason: string, now: Date) {
  await ctx.prisma.$transaction(async (tx) => {
    await tx.subscriptionInvoice.update({ where: { id: invoiceId }, data: { status: 'FAILED', failureReason: reason } });
    const sub = await tx.organizationSubscription.update({
      where: { organizationId },
      data: { failedAttempts: { increment: 1 }, nextRetryAt: new Date(now.getTime() + DAY_MS), status: 'PAST_DUE' },
    });
    await audit(tx, {
      organizationId,
      actorType: 'PROVIDER',
      action: 'subscription.renewal_failed',
      entityType: 'SubscriptionInvoice',
      entityId: invoiceId,
      metadata: { reason, attempt: sub.failedAttempts },
    });
    await queueBillingNotice(tx, organizationId, 'payment_failed', subscriptionPaidThrough(sub).toISOString(), now);
  });
}

/** Verifies pending subscription invoices (ambiguous charges, abandoned checkouts). */
export async function reconcileSubscriptionInvoices(ctx: CoreContext) {
  const now = ctx.now();
  const pending = await ctx.prisma.subscriptionInvoice.findMany({
    where: { status: 'PENDING', createdAt: { lt: new Date(now.getTime() - 2 * 60 * 1000) } },
    take: 100,
  });
  let resolved = 0;
  for (const inv of pending) {
    const adapter = ctx.adapters.payments[inv.provider];
    if (!adapter) continue;
    try {
      const v = await adapter.verify(inv.reference);
      const out = await applySubscriptionPayment(ctx, inv.reference, v);
      if (out === 'paid') resolved++;
      else if (out === 'not_successful') {
        const old = now.getTime() - inv.createdAt.getTime() > DAY_MS;
        if (inv.kind === 'RENEWAL' && (v.status === 'failed' || v.status === 'not_found' || old)) {
          await markRenewalFailed(ctx, inv.organizationId, inv.id, `Renewal ${v.status}`, now);
          resolved++;
        } else if (inv.kind === 'CHECKOUT' && old) {
          await ctx.prisma.subscriptionInvoice.updateMany({ where: { id: inv.id, status: 'PENDING' }, data: { status: 'EXPIRED' } });
          resolved++;
        }
      }
    } catch (e) {
      ctx.logger.warn({ reference: inv.reference, err: (e as Error).message }, 'subscription invoice verify failed');
    }
  }
  return { checked: pending.length, resolved };
}

/** Keeps the status snapshot current and queues creator notices (trial ending, paused). */
export async function refreshSubscriptionStatuses(ctx: CoreContext) {
  const now = ctx.now();
  const subs = await ctx.prisma.organizationSubscription.findMany();
  let changed = 0;
  for (const s of subs) {
    const access = getSubscriptionAccess(s, now);
    const status = ({ trialing: 'TRIALING', active: 'ACTIVE', past_due: 'PAST_DUE', paused: 'PAUSED', cancelled: 'CANCELLED' } as const)[access];
    const paidThrough = subscriptionPaidThrough(s);
    if (access === 'trialing' && !s.authorizationCode && paidThrough.getTime() - now.getTime() <= 3 * DAY_MS) {
      await queueBillingNotice(ctx.prisma, s.organizationId, 'trial_ending', paidThrough.toISOString(), now);
    }
    if (access === 'past_due' && !s.authorizationCode) {
      await queueBillingNotice(ctx.prisma, s.organizationId, 'payment_due', paidThrough.toISOString(), now);
    }
    if (status !== s.status) {
      await ctx.prisma.organizationSubscription.update({ where: { id: s.id }, data: { status } });
      changed++;
      if (status === 'PAUSED' || status === 'CANCELLED') {
        await queueBillingNotice(ctx.prisma, s.organizationId, status === 'PAUSED' ? 'paused' : 'cancelled', paidThrough.toISOString(), now);
        await audit(ctx.prisma, {
          organizationId: s.organizationId,
          actorType: 'SYSTEM',
          action: `subscription.${status.toLowerCase()}`,
          entityType: 'OrganizationSubscription',
          entityId: s.id,
        });
      }
    }
  }
  return { checked: subs.length, changed };
}

/** Billing emails go to every owner of the organization (deduplicated per event). */
export async function queueBillingNotice(db: Tx | Db, organizationId: string, key: string, discriminator: string, now: Date) {
  const owners = await db.organizationStaff.findMany({ where: { organizationId, role: 'OWNER' }, select: { userId: true } });
  if (!owners.length) return;
  const rows: Prisma.NotificationCreateManyInput[] = owners.map((o) => ({
    organizationId,
    recipientUserId: o.userId,
    channel: 'EMAIL',
    type: 'CREATOR_BILLING',
    reminderKey: key,
    dedupeKey: `${organizationId}:billing:${key}:${discriminator}:${o.userId}`,
    scheduledFor: now,
  }));
  await db.notification.createMany({ data: rows, skipDuplicates: true });
}

/** Admin: change tier or extend the trial (e.g. complimentary access). */
export async function adminAdjustSubscription(
  ctx: CoreContext,
  organizationId: string,
  adminId: string,
  p: { tier?: SubscriptionTier; extendTrialDays?: number },
) {
  const now = ctx.now();
  const sub = await ensureSubscription(ctx.prisma, organizationId, now);
  const data: Prisma.OrganizationSubscriptionUpdateInput = {};
  if (p.tier) {
    data.tier = p.tier;
    data.pendingTier = null;
  }
  if (p.extendTrialDays) {
    const base = Math.max(sub.trialEndsAt.getTime(), now.getTime());
    data.trialEndsAt = new Date(base + p.extendTrialDays * DAY_MS);
  }
  const updated = await ctx.prisma.organizationSubscription.update({ where: { id: sub.id }, data });
  await audit(ctx.prisma, {
    organizationId,
    actorType: 'ADMIN',
    actorId: adminId,
    action: 'subscription.admin_adjusted',
    entityType: 'OrganizationSubscription',
    entityId: sub.id,
    metadata: { ...p },
  });
  return updated;
}
