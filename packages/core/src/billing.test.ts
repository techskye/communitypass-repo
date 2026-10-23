import { beforeEach, describe, expect, it } from 'vitest';
import { DAY_MS, addMonthsUtc, getSubscriptionAccess } from '@communitypass/shared';
import { createPendingOrder, resetDb, seedMember, seedOrg, successFor, testContext } from './test-utils/fixtures';
import {
  applySubscriptionPayment,
  assertCanAddCommunity,
  changePlan,
  getBillingOverview,
  getOrgEntitlements,
  processSubscriptionRenewals,
  reconcileSubscriptionInvoices,
  refreshSubscriptionStatuses,
  startSubscriptionCheckout,
} from './services/billing';
import { getPaymentReadiness, startCheckout } from './services/checkout';
import { verifyAndFulfill } from './services/fulfillment';
import { eligibleChannels } from './services/notifications';

beforeEach(async () => {
  await resetDb();
});

const d = (s: string) => new Date(s);

describe('subscription access rules (pure)', () => {
  const trialEndsAt = d('2026-03-24T10:00:00Z');
  it('trial → grace (7 days) → paused, computed from dates', () => {
    const s = { trialEndsAt, currentPeriodEnd: null, cancelAtPeriodEnd: false };
    expect(getSubscriptionAccess(s, d('2026-03-24T09:59:59Z'))).toBe('trialing');
    expect(getSubscriptionAccess(s, trialEndsAt)).toBe('past_due');
    expect(getSubscriptionAccess(s, new Date(trialEndsAt.getTime() + 7 * DAY_MS - 1))).toBe('past_due');
    expect(getSubscriptionAccess(s, new Date(trialEndsAt.getTime() + 7 * DAY_MS))).toBe('paused');
  });
  it('paid period → active; cancelled stops at period end with no grace', () => {
    const s = { trialEndsAt, currentPeriodEnd: d('2026-04-24T10:00:00Z'), cancelAtPeriodEnd: true };
    expect(getSubscriptionAccess(s, d('2026-04-01T00:00:00Z'))).toBe('active');
    expect(getSubscriptionAccess(s, d('2026-04-24T10:00:00Z'))).toBe('cancelled');
  });
  it('monthly periods clamp to month end', () => {
    expect(addMonthsUtc(d('2026-01-31T08:00:00Z'), 1).toISOString()).toBe('2026-02-28T08:00:00.000Z');
    expect(addMonthsUtc(d('2027-12-15T08:00:00Z'), 1).toISOString()).toBe('2028-01-15T08:00:00.000Z');
  });
});

async function trialOrg(tier: 'STARTER' | 'GROWTH' | 'PRO' = 'STARTER', mode: 'demo' | 'live' = 'live') {
  const t = testContext({ mode });
  const s = await seedOrg(t.db, { name: 'Gamma', slug: 'gamma' });
  // Replace the fixture's comp subscription with a fresh trial.
  await t.db.organizationSubscription.update({
    where: { organizationId: s.org.id },
    data: { tier, status: 'TRIALING', trialEndsAt: new Date(t.clock.now().getTime() + 14 * DAY_MS), currentPeriodEnd: null },
  });
  return { ...t, s };
}

describe('checkout: save card + pay a month', () => {
  it('paying during the trial starts the month at trial end, saves the card, and applies exactly once', async () => {
    const { ctx, db, s, paystack, clock } = await trialOrg('GROWTH');
    const trialEnd = new Date(clock.now().getTime() + 14 * DAY_MS);
    const { reference } = await startSubscriptionCheckout(ctx, s.org.id, { id: s.owner.id, email: s.owner.email });
    const inv = await db.subscriptionInvoice.findUniqueOrThrow({ where: { reference } });
    expect(inv.amountKobo).toBe(1_500_000);
    paystack.results.set(reference, {
      ...successFor({ reference, amountKobo: inv.amountKobo }, clock.now()),
      authorization: { code: 'AUTH_x', reusable: true, brand: 'visa', last4: '4081', expiry: '12/30' },
    });
    const v = await paystack.verify(reference);
    const results = await Promise.all([
      applySubscriptionPayment(ctx, reference, v),
      applySubscriptionPayment(ctx, reference, v),
    ]);
    expect(results.sort()).toEqual(['already_paid', 'paid']);
    const sub = await db.organizationSubscription.findUniqueOrThrow({ where: { organizationId: s.org.id } });
    expect(sub.currentPeriodStart!.toISOString()).toBe(trialEnd.toISOString());
    expect(sub.currentPeriodEnd!.toISOString()).toBe(addMonthsUtc(trialEnd, 1).toISOString());
    expect(sub.authorizationCode).toBe('AUTH_x');
    expect(sub.cardLast4).toBe('4081');
    // Subscription money goes to the platform: no subaccount in the checkout.
    expect((await getBillingOverview(ctx, s.org.id)).subscription.autoRenew).toBe(true);
  });

  it('wrong amount is not applied and is flagged for review', async () => {
    const { ctx, db, s, paystack, clock } = await trialOrg();
    const { reference } = await startSubscriptionCheckout(ctx, s.org.id, { id: s.owner.id, email: s.owner.email });
    paystack.results.set(reference, successFor({ reference, amountKobo: 100 }, clock.now()));
    expect(await applySubscriptionPayment(ctx, reference, await paystack.verify(reference))).toBe('mismatch');
    const sub = await db.organizationSubscription.findUniqueOrThrow({ where: { organizationId: s.org.id } });
    expect(sub.currentPeriodEnd).toBeNull();
    expect(await db.reconciliationIssue.count({ where: { kind: 'AMOUNT_MISMATCH' } })).toBe(1);
  });
});

describe('auto-renewal', () => {
  async function paidOrg() {
    const t = await trialOrg('STARTER');
    const { reference } = await startSubscriptionCheckout(t.ctx, t.s.org.id, { id: t.s.owner.id, email: t.s.owner.email });
    t.paystack.results.set(reference, {
      ...successFor({ reference, amountKobo: 500_000 }, t.clock.now()),
      authorization: { code: 'AUTH_card', reusable: true, brand: 'visa', last4: '4081', expiry: '12/30' },
    });
    await applySubscriptionPayment(t.ctx, reference, await t.paystack.verify(reference));
    const sub = await t.db.organizationSubscription.findUniqueOrThrow({ where: { organizationId: t.s.org.id } });
    return { ...t, periodEnd: sub.currentPeriodEnd! };
  }

  it('charges the saved card once per period even if the job runs repeatedly', async () => {
    const { ctx, db, s, paystack, clock, periodEnd } = await paidOrg();
    clock.t = new Date(periodEnd.getTime() + 60_000);
    await processSubscriptionRenewals(ctx);
    await processSubscriptionRenewals(ctx);
    await processSubscriptionRenewals(ctx);
    expect(paystack.charges).toHaveLength(1);
    expect(paystack.charges[0]).toMatchObject({ amountKobo: 500_000, authorizationCode: 'AUTH_card' });
    const sub = await db.organizationSubscription.findUniqueOrThrow({ where: { organizationId: s.org.id } });
    expect(sub.currentPeriodEnd!.toISOString()).toBe(addMonthsUtc(clock.now(), 1).toISOString());
    expect(await db.subscriptionInvoice.count({ where: { status: 'PAID' } })).toBe(2);
  });

  it('a scheduled downgrade is charged at the lower price on renewal', async () => {
    const t = await trialOrg('GROWTH');
    const { reference } = await startSubscriptionCheckout(t.ctx, t.s.org.id, { id: t.s.owner.id, email: t.s.owner.email });
    t.paystack.results.set(reference, {
      ...successFor({ reference, amountKobo: 1_500_000 }, t.clock.now()),
      authorization: { code: 'AUTH_card', reusable: true, brand: 'visa', last4: '4081', expiry: '12/30' },
    });
    await applySubscriptionPayment(t.ctx, reference, await t.paystack.verify(reference));
    t.clock.advanceDays(20); // trial over, inside the paid month
    expect((await changePlan(t.ctx, t.s.org.id, t.s.owner.id, 'STARTER')).effective).toBe('next_renewal');
    expect((await getOrgEntitlements(t.db, t.s.org.id, t.clock.now())).tier.tier).toBe('GROWTH');
    const sub = await t.db.organizationSubscription.findUniqueOrThrow({ where: { organizationId: t.s.org.id } });
    t.clock.t = new Date(sub.currentPeriodEnd!.getTime() + 1000);
    await processSubscriptionRenewals(t.ctx);
    expect(t.paystack.charges[0].amountKobo).toBe(500_000);
    expect((await getOrgEntitlements(t.db, t.s.org.id, t.clock.now())).tier.tier).toBe('STARTER');
  });

  it('failed charges retry daily; after the grace period member payments pause but paid time is kept', async () => {
    const { ctx, db, s, paystack, clock, periodEnd } = await paidOrg();
    const { member } = await seedMember(db, s.org.id, { email: 'kept@example.com' });
    // An existing member paid before the creator's subscription lapsed.
    const order = await createPendingOrder(db, s, member.id);
    paystack.results.set(order.reference, successFor(order, clock.now(), { subaccountCode: null }));
    await verifyAndFulfill(ctx, order.reference, 'WEBHOOK');
    const memberPaidUntil = (await db.membership.findFirstOrThrow()).paidUntil!;

    paystack.chargeResult = 'failed';
    clock.t = new Date(periodEnd.getTime() + 1000);
    await processSubscriptionRenewals(ctx);
    await processSubscriptionRenewals(ctx); // same day: no extra attempt
    expect(paystack.charges).toHaveLength(1);
    let sub = await db.organizationSubscription.findUniqueOrThrow({ where: { organizationId: s.org.id } });
    expect(sub.status).toBe('PAST_DUE');
    expect((await getPaymentReadiness(ctx, s.org.id)).ready).toBe(true); // still within grace

    clock.advanceDays(1.01);
    await processSubscriptionRenewals(ctx);
    expect(paystack.charges).toHaveLength(2);

    clock.t = new Date(periodEnd.getTime() + 7 * DAY_MS);
    await refreshSubscriptionStatuses(ctx);
    sub = await db.organizationSubscription.findUniqueOrThrow({ where: { organizationId: s.org.id } });
    expect(sub.status).toBe('PAUSED');
    const readiness = await getPaymentReadiness(ctx, s.org.id);
    expect(readiness.ready).toBe(false);
    expect((await db.membership.findFirstOrThrow()).paidUntil!.toISOString()).toBe(memberPaidUntil.toISOString());
    expect(await db.notification.count({ where: { type: 'CREATOR_BILLING', reminderKey: 'paused' } })).toBe(1);
  });

  it('an ambiguous charge (timeout) is never repeated; reconciliation resolves it', async () => {
    const { ctx, db, paystack, clock, periodEnd } = await paidOrg();
    paystack.chargeResult = 'throw';
    clock.t = new Date(periodEnd.getTime() + 1000);
    await processSubscriptionRenewals(ctx);
    clock.advanceDays(2);
    await processSubscriptionRenewals(ctx);
    expect(paystack.charges).toHaveLength(1); // pending invoice blocks another charge
    const pending = await db.subscriptionInvoice.findFirstOrThrow({ where: { status: 'PENDING', kind: 'RENEWAL' } });
    paystack.results.set(pending.reference, successFor({ reference: pending.reference, amountKobo: pending.amountKobo }, clock.now()));
    await reconcileSubscriptionInvoices(ctx);
    expect((await db.subscriptionInvoice.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe('PAID');
  });
});

describe('plan limits', () => {
  it('Starter allows 1 community; downgrade is refused when usage exceeds the lower plan', async () => {
    const { ctx, db, s } = await trialOrg('STARTER');
    await expect(assertCanAddCommunity(ctx, s.org.id)).rejects.toMatchObject({ code: 'PLAN_LIMIT_COMMUNITIES' });
    await changePlan(ctx, s.org.id, s.owner.id, 'GROWTH');
    await expect(assertCanAddCommunity(ctx, s.org.id)).resolves.toBeUndefined();
    await db.community.create({ data: { organizationId: s.org.id, name: 'Second', slug: 'gamma-two', whatsappInviteUrl: 'https://chat.whatsapp.com/SECRETinvite12345' } });
    await expect(changePlan(ctx, s.org.id, s.owner.id, 'STARTER')).rejects.toMatchObject({ code: 'DOWNGRADE_BLOCKED' });
  });

  it('at the active-member limit new members are blocked but existing members can renew', async () => {
    const { ctx, db, s, clock } = await trialOrg('STARTER');
    // Fill the Starter plan's 100 active paid members.
    for (let i = 0; i < 100; i++) {
      const { member } = await seedMember(db, s.org.id, { email: `m${i}@example.com`, phone: '+2348031234567' });
      await db.membership.create({
        data: { organizationId: s.org.id, communityId: s.community.id, memberId: member.id, planId: s.plan.id, paidUntil: new Date(clock.now().getTime() + 10 * DAY_MS) },
      });
    }
    const base = { communitySlug: 'gamma', planId: s.plan.id, fullName: 'New Person', phone: '08031234567', whatsappOptIn: false, acceptTerms: true as const };
    await expect(startCheckout(ctx, { ...base, email: 'newcomer@example.com' })).rejects.toMatchObject({ code: 'MEMBER_LIMIT_REACHED' });
    const renewal = await startCheckout(ctx, { ...base, email: 'm5@example.com' });
    expect(renewal.reference).toMatch(/^CP-/);
  });
});

describe('WhatsApp is a Growth/Pro feature', () => {
  it('Starter creators get email only; Growth includes WhatsApp', async () => {
    const { db, s, clock } = await trialOrg('STARTER');
    const { member } = await seedMember(db, s.org.id, { email: 'wa@example.com', whatsappConsent: true });
    const now = clock.now();
    expect(await eligibleChannels(db, { organizationId: s.org.id, memberId: member.id, kind: 'transactional', now })).toEqual(['EMAIL']);
    await db.organizationSubscription.update({ where: { organizationId: s.org.id }, data: { tier: 'GROWTH' } });
    expect(await eligibleChannels(db, { organizationId: s.org.id, memberId: member.id, kind: 'transactional', now })).toEqual(['EMAIL', 'WHATSAPP']);
  });
});
