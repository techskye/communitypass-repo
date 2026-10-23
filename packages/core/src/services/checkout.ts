import type { CheckoutStartInput } from '@communitypass/shared';
import { CURRENT_WHATSAPP_CONSENT_VERSION, WHATSAPP_CONSENT_VERSIONS, getEntitlement } from '@communitypass/shared';
import type { CoreContext } from '../context';
import { audit, DomainError, newPaymentReference, NotFoundError } from '../infra';
import { WHATSAPP_SERVICE_SCOPE } from './notifications';
import { fulfillVerifiedTransaction, verifyAndFulfill } from './fulfillment';
import { applySubscriptionPayment, getOrgEntitlements, memberLimitReached } from './billing';

export async function getPaymentReadiness(ctx: CoreContext, organizationId: string) {
  const org = await ctx.prisma.organization.findUniqueOrThrow({
    where: { id: organizationId },
    include: { paymentConfig: true },
  });
  if (org.status !== 'ACTIVE') return { ready: false, provider: null, reason: 'Organization is suspended' } as const;
  const ent = await getOrgEntitlements(ctx.prisma, organizationId, ctx.now());
  if (!ent.paymentsAllowed) {
    return { ready: false, provider: null, reason: 'This creator is not accepting payments right now' } as const;
  }
  if (ctx.config.appMode === 'demo') return { ready: true, provider: 'DEMO' as const, reason: 'Demo mode' };
  if (org.isDemo) return { ready: false, provider: null, reason: 'Demo organizations cannot take live payments' } as const;
  if (!ctx.adapters.payments.PAYSTACK) return { ready: false, provider: null, reason: 'Payments are not configured on this platform' } as const;
  const pc = org.paymentConfig;
  if (!pc || pc.status !== 'ACTIVE' || !pc.subaccountCode) {
    return { ready: false, provider: null, reason: 'Payment setup for this creator has not been approved yet' } as const;
  }
  return { ready: true, provider: 'PAYSTACK' as const, reason: null };
}

/**
 * Public checkout start: creates a pending order with a full price/plan/settlement snapshot and
 * initializes hosted checkout with server-controlled values only.
 */
export async function startCheckout(ctx: CoreContext, input: CheckoutStartInput) {
  const now = ctx.now();
  const community = await ctx.prisma.community.findUnique({
    where: { slug: input.communitySlug },
    include: { organization: { include: { paymentConfig: true } } },
  });
  if (!community || !community.isPublished) throw new NotFoundError('Community');
  const plan = await ctx.prisma.plan.findFirst({
    where: { id: input.planId, communityId: community.id, isActive: true },
  });
  if (!plan) throw new NotFoundError('Plan');
  const org = community.organization;

  const readiness = await getPaymentReadiness(ctx, org.id);
  if (!readiness.ready || !readiness.provider) {
    throw new DomainError('PAYMENTS_NOT_ENABLED', readiness.reason ?? 'Payments unavailable', 409);
  }
  const provider = readiness.provider;

  // Member identity (org-scoped profile under a global account).
  const account = await ctx.prisma.memberAccount.upsert({
    where: { email: input.email },
    create: { email: input.email },
    update: {},
  });
  let member = await ctx.prisma.member.findUnique({
    where: { organizationId_memberAccountId: { organizationId: org.id, memberAccountId: account.id } },
  });
  const isNewMember = !member;
  if (!member) {
    member = await ctx.prisma.member.create({
      data: {
        organizationId: org.id,
        memberAccountId: account.id,
        fullName: input.fullName,
        email: input.email,
        phoneE164: input.phone,
      },
    });
  }
  // For existing members we never overwrite profile/consent from an unauthenticated form;
  // they can update details from the signed-in member page.

  // Explicit WhatsApp opt-in, recorded separately from the purchase.
  if (input.whatsappOptIn && (isNewMember || member.phoneE164 === input.phone)) {
    const existingConsent = await ctx.prisma.notificationConsent.findUnique({
      where: { memberId_channel_scope: { memberId: member.id, channel: 'WHATSAPP', scope: WHATSAPP_SERVICE_SCOPE } },
    });
    if (!existingConsent) {
      await ctx.prisma.notificationConsent.create({
        data: {
          organizationId: org.id,
          memberId: member.id,
          channel: 'WHATSAPP',
          scope: WHATSAPP_SERVICE_SCOPE,
          status: 'GRANTED',
          phoneE164: member.phoneE164,
          wordingVersion: CURRENT_WHATSAPP_CONSENT_VERSION,
          wordingText: WHATSAPP_CONSENT_VERSIONS[CURRENT_WHATSAPP_CONSENT_VERSION](org.displayName),
          source: 'signup_form',
          grantedAt: now,
        },
      });
    }
  }

  // V1: one current plan per member per community; block switching while paid time remains.
  const membership = await ctx.prisma.membership.findUnique({
    where: { memberId_communityId: { memberId: member.id, communityId: community.id } },
  });
  if (
    membership &&
    membership.planId !== plan.id &&
    getEntitlement(membership.paidUntil, 0, now) === 'active'
  ) {
    throw new DomainError(
      'PLAN_SWITCH_NOT_SUPPORTED',
      'You already have an active membership on a different plan. Switching plans is not available yet — you can renew your current plan.',
      409,
    );
  }

  // Plan limit: block NEW paid members at the active-member limit; current members can still renew.
  const isRenewal = !!membership?.paidUntil && membership.paidUntil.getTime() > now.getTime();
  if (!isRenewal && (await memberLimitReached(ctx.prisma, org.id, now))) {
    throw new DomainError(
      'MEMBER_LIMIT_REACHED',
      'This community is not accepting new members right now. Please contact the creator.',
      409,
    );
  }

  const pc = org.paymentConfig;
  const isPaystack = provider === 'PAYSTACK';
  const platformFeeKobo = isPaystack && pc ? Math.floor((plan.priceKobo * pc.platformFeeBps) / 10000) : 0;
  const reference = newPaymentReference();
  const order = await ctx.prisma.order.create({
    data: {
      organizationId: org.id,
      communityId: community.id,
      planId: plan.id,
      memberId: member.id,
      reference,
      provider,
      isDemo: provider === 'DEMO',
      planNameSnapshot: plan.name,
      communityNameSnapshot: community.name,
      amountKobo: plan.priceKobo,
      currency: plan.currency,
      durationDays: plan.durationDays,
      subaccountCodeSnapshot: isPaystack ? pc?.subaccountCode ?? null : null,
      platformFeeKobo,
      feeBearerSnapshot: isPaystack ? pc?.feeBearer ?? null : null,
    },
  });
  await audit(ctx.prisma, {
    organizationId: org.id,
    actorType: 'MEMBER',
    actorId: member.id,
    action: 'order.created',
    entityType: 'Order',
    entityId: order.id,
    metadata: { reference, amountKobo: order.amountKobo, durationDays: order.durationDays, provider },
  });

  const adapter = ctx.adapters.payments[provider]!;
  const init = await adapter.initialize({
    reference,
    email: member.email,
    amountKobo: order.amountKobo,
    currency: order.currency,
    callbackUrl: `${ctx.config.webBaseUrl}/payment/callback?reference=${encodeURIComponent(reference)}`,
    subaccountCode: order.subaccountCodeSnapshot,
    platformFeeKobo,
    feeBearer: order.feeBearerSnapshot,
    metadata: { orderId: order.id, organizationId: org.id, communityId: community.id },
  });
  await ctx.prisma.order.update({
    where: { id: order.id },
    data: { checkoutUrl: init.checkoutUrl, providerAccessCode: init.accessCode },
  });
  return { reference, checkoutUrl: init.checkoutUrl, isDemo: provider === 'DEMO' };
}

/** Public order status — returns no private data (never the invite link). */
export async function getPublicOrderStatus(ctx: CoreContext, reference: string) {
  const order = await ctx.prisma.order.findUnique({
    where: { reference },
    include: { application: true, community: { select: { name: true, slug: true } } },
  });
  if (!order) throw new NotFoundError('Order');
  return {
    reference: order.reference,
    status: order.status,
    isDemo: order.isDemo,
    communityName: order.community.name,
    communitySlug: order.community.slug,
    planName: order.planNameSnapshot,
    amountKobo: order.amountKobo,
    durationDays: order.durationDays,
    paidUntil: order.application?.newPaidUntil ?? null,
  };
}

/**
 * Payment callback: the browser redirect only tells us WHICH order to check. We then verify
 * server-side with the provider. Until verification succeeds, the status stays pending.
 */
export async function verifyFromCallback(ctx: CoreContext, reference: string) {
  const order = await ctx.prisma.order.findUnique({ where: { reference } });
  if (!order) throw new NotFoundError('Order');
  if (order.status === 'PENDING') {
    // Avoid hammering the provider when the page polls.
    const recentlyChecked = order.lastVerifiedAt && ctx.now().getTime() - order.lastVerifiedAt.getTime() < 3000;
    if (!recentlyChecked) {
      try {
        await verifyAndFulfill(ctx, reference, 'CALLBACK');
      } catch (e) {
        ctx.logger.warn({ reference, err: (e as Error).message }, 'callback verification failed');
      }
    }
  }
  return getPublicOrderStatus(ctx, reference);
}

/**
 * DEMO ONLY: simulates the outcome of the hosted checkout page. Also fires a simulated
 * webhook through the same idempotent fulfillment service.
 */
export async function simulateDemoCheckout(
  ctx: CoreContext,
  reference: string,
  outcome: 'success' | 'failed' | 'wrong_amount',
) {
  if (ctx.config.appMode !== 'demo') throw new DomainError('DEMO_ONLY', 'Demo checkout is disabled', 403);
  if (reference.startsWith('SUB-')) return simulateDemoSubscriptionCheckout(ctx, reference, outcome);
  const order = await ctx.prisma.order.findUnique({ where: { reference } });
  if (!order || order.provider !== 'DEMO') throw new NotFoundError('Demo order');
  const tx = await ctx.prisma.demoTransaction.findUnique({ where: { reference } });
  if (!tx) throw new NotFoundError('Demo transaction');
  if (tx.status !== 'pending') return { status: tx.status };
  await ctx.prisma.demoTransaction.update({
    where: { reference },
    data: {
      status: outcome === 'failed' ? 'failed' : 'success',
      paidAt: outcome === 'failed' ? null : ctx.now(),
      amountKobo: outcome === 'wrong_amount' ? tx.amountKobo - 5000 : tx.amountKobo,
    },
  });
  // Simulated provider webhook (persisted like a real one, then processed).
  const v = await ctx.adapters.payments.DEMO!.verify(reference);
  await ctx.prisma.providerEvent.upsert({
    where: { dedupeKey: `demo:charge:${reference}:${v.status}` },
    create: {
      source: 'DEMO',
      eventType: v.status === 'success' ? 'charge.success' : 'charge.failed',
      dedupeKey: `demo:charge:${reference}:${v.status}`,
      payload: { reference, status: v.status, demo: true },
    },
    update: {},
  });
  await fulfillVerifiedTransaction(ctx, reference, v, 'WEBHOOK');
  return { status: v.status, returnUrl: `/payment/callback?reference=${encodeURIComponent(reference)}` };
}

async function simulateDemoSubscriptionCheckout(ctx: CoreContext, reference: string, outcome: 'success' | 'failed' | 'wrong_amount') {
  const inv = await ctx.prisma.subscriptionInvoice.findUnique({ where: { reference } });
  const t = await ctx.prisma.demoTransaction.findUnique({ where: { reference } });
  if (!inv || inv.provider !== 'DEMO' || !t) throw new NotFoundError('Demo invoice');
  const returnUrl = `/creator/billing?reference=${encodeURIComponent(reference)}`;
  if (t.status !== 'pending') return { status: t.status, returnUrl };
  await ctx.prisma.demoTransaction.update({
    where: { reference },
    data: {
      status: outcome === 'failed' ? 'failed' : 'success',
      paidAt: outcome === 'failed' ? null : ctx.now(),
      amountKobo: outcome === 'wrong_amount' ? t.amountKobo - 5000 : t.amountKobo,
    },
  });
  const v = await ctx.adapters.payments.DEMO!.verify(reference);
  await applySubscriptionPayment(ctx, reference, v);
  return { status: v.status, returnUrl };
}

/** Demo hosted-checkout page data for either a member order or a creator subscription invoice. */
export async function getDemoCheckout(ctx: CoreContext, reference: string) {
  if (ctx.config.appMode !== 'demo') throw new NotFoundError('Demo checkout');
  const t = await ctx.prisma.demoTransaction.findUnique({ where: { reference } });
  if (reference.startsWith('SUB-')) {
    const inv = await ctx.prisma.subscriptionInvoice.findUnique({ where: { reference } });
    if (!inv || inv.provider !== 'DEMO') throw new NotFoundError('Demo invoice');
    return {
      reference,
      communityName: 'CommunityPass subscription',
      planName: `${inv.tier.charAt(0)}${inv.tier.slice(1).toLowerCase()} plan (1 month)`,
      amountKobo: inv.amountKobo,
      demoStatus: t?.status ?? 'missing',
    };
  }
  const order = await getPublicOrderStatus(ctx, reference);
  if (!order.isDemo) throw new NotFoundError('Demo checkout');
  return { ...order, demoStatus: t?.status ?? 'missing' };
}
