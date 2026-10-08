import { beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { DAY_MS } from '@communitypass/shared';
import {
  createPendingOrder,
  resetDb,
  seedMember,
  seedOrg,
  successFor,
  testContext,
} from './test-utils/fixtures';
import { fulfillVerifiedTransaction, verifyAndFulfill } from './services/fulfillment';
import { verifyFromCallback } from './services/checkout';
import { processProviderEvent, recordPaystackWebhook } from './services/provider-events';
import { completeTask, evaluateExpiries } from './services/access';

beforeEach(async () => {
  await resetDb();
});

function signPaystack(body: string, key = 'sk_live_testsecret') {
  return createHmac('sha512', key).update(body).digest('hex');
}

async function setup(graceDays = 0) {
  const t = testContext();
  const s = await seedOrg(t.db, { name: 'Alpha', slug: 'alpha', graceDays });
  const { member } = await seedMember(t.db, s.org.id, { email: 'ada@example.com', whatsappConsent: true });
  return { ...t, s, member };
}

describe('Paystack webhook signatures (test 2)', () => {
  it('rejects a missing or invalid signature and persists nothing', async () => {
    const { ctx, db } = await setup();
    const body = Buffer.from(JSON.stringify({ event: 'charge.success', data: { id: 1, reference: 'X' } }));
    expect(await recordPaystackWebhook(ctx, body, undefined)).toEqual({ ok: false, reason: 'invalid_signature' });
    expect(await recordPaystackWebhook(ctx, body, 'deadbeef')).toEqual({ ok: false, reason: 'invalid_signature' });
    expect(await recordPaystackWebhook(ctx, body, signPaystack(body.toString(), 'sk_live_wrong'))).toEqual({
      ok: false,
      reason: 'invalid_signature',
    });
    expect(await db.providerEvent.count()).toBe(0);
  });

  it('verifies against the exact raw body (re-serialized JSON does not match)', async () => {
    const { ctx } = await setup();
    const raw = '{"event":"charge.success",  "data":{"id":7,"reference":"R"}}';
    const reserialized = JSON.stringify(JSON.parse(raw));
    expect((await recordPaystackWebhook(ctx, Buffer.from(raw), signPaystack(reserialized))).ok).toBe(false);
    expect((await recordPaystackWebhook(ctx, Buffer.from(raw), signPaystack(raw))).ok).toBe(true);
  });
});

describe('Duplicate webhooks (test 3)', () => {
  it('a duplicated charge.success webhook extends the membership exactly once', async () => {
    const { ctx, db, s, member, paystack, clock } = await setup();
    const order = await createPendingOrder(db, s, member.id);
    paystack.results.set(order.reference, successFor(order, clock.now()));
    const raw = JSON.stringify({ event: 'charge.success', data: { id: 99, reference: order.reference, status: 'success' } });
    const sig = signPaystack(raw);

    const first = await recordPaystackWebhook(ctx, Buffer.from(raw), sig);
    const second = await recordPaystackWebhook(ctx, Buffer.from(raw), sig);
    expect(first.ok && !first.duplicate).toBe(true);
    expect(second.ok && second.duplicate).toBe(true);
    if (!first.ok || !second.ok) throw new Error();
    expect(await processProviderEvent(ctx, first.eventId)).toBe('fulfilled');
    expect(await processProviderEvent(ctx, second.eventId)).toBe('already_processed');
    // Even a different event delivery for the same reference cannot double-apply:
    expect((await fulfillVerifiedTransaction(ctx, order.reference, await paystack.verify(order.reference), 'WEBHOOK')).outcome).toBe('already_fulfilled');

    const m = await db.membership.findFirstOrThrow();
    expect(m.paidUntil!.getTime()).toBe(clock.now().getTime() + 30 * DAY_MS);
    expect(await db.membershipPaymentApplication.count()).toBe(1);
    expect(await db.payment.count()).toBe(1);
    expect(await db.accessTask.count({ where: { type: 'GRANT' } })).toBe(1);
  });
});

describe('Webhook/callback race (test 4)', () => {
  it('concurrent webhook and callback verification fulfil once', async () => {
    const { ctx, db, s, member, paystack, clock } = await setup();
    const order = await createPendingOrder(db, s, member.id);
    paystack.results.set(order.reference, successFor(order, clock.now()));
    const v = await paystack.verify(order.reference);
    const results = await Promise.all([
      fulfillVerifiedTransaction(ctx, order.reference, v, 'WEBHOOK'),
      verifyAndFulfill(ctx, order.reference, 'CALLBACK'),
      fulfillVerifiedTransaction(ctx, order.reference, v, 'RECONCILIATION'),
    ]);
    const outcomes = results.map((r) => r.outcome).sort();
    expect(outcomes).toEqual(['already_fulfilled', 'already_fulfilled', 'fulfilled']);
    expect(await db.membershipPaymentApplication.count()).toBe(1);
    const m = await db.membership.findFirstOrThrow();
    expect(m.paidUntil!.getTime()).toBe(clock.now().getTime() + 30 * DAY_MS);
  });
});

describe('Amount / currency / subaccount validation (test 5)', () => {
  it('wrong amount is held for review and does not activate', async () => {
    const { ctx, db, s, member, paystack, clock } = await setup();
    const order = await createPendingOrder(db, s, member.id);
    paystack.results.set(order.reference, successFor(order, clock.now(), { amountKobo: order.amountKobo - 100 }));
    const r = await verifyAndFulfill(ctx, order.reference, 'WEBHOOK');
    expect(r).toMatchObject({ outcome: 'held_for_review', kind: 'AMOUNT_MISMATCH' });
    expect(await db.membership.count()).toBe(0);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('NEEDS_REVIEW');
    expect((await db.payment.findFirstOrThrow()).status).toBe('HELD_FOR_REVIEW');
    expect(await db.reconciliationIssue.count({ where: { kind: 'AMOUNT_MISMATCH' } })).toBe(1);
  });

  it('wrong currency is held for review', async () => {
    const { ctx, db, s, member, paystack, clock } = await setup();
    const order = await createPendingOrder(db, s, member.id);
    paystack.results.set(order.reference, successFor(order, clock.now(), { currency: 'USD' }));
    expect(await verifyAndFulfill(ctx, order.reference, 'WEBHOOK')).toMatchObject({ outcome: 'held_for_review', kind: 'CURRENCY_MISMATCH' });
    expect(await db.membership.count()).toBe(0);
  });

  it('non-integer (naira-denominated) amounts are rejected', async () => {
    const { ctx, db, s, member, paystack, clock } = await setup();
    const order = await createPendingOrder(db, s, member.id);
    paystack.results.set(order.reference, successFor(order, clock.now(), { amountKobo: order.amountKobo / 100 + 0.5 }));
    expect((await verifyAndFulfill(ctx, order.reference, 'WEBHOOK')).outcome).toBe('held_for_review');
  });

  it('subaccount mismatch is held for review', async () => {
    const { ctx, db, s, member, paystack, clock } = await setup();
    const order = await createPendingOrder(db, s, member.id);
    paystack.results.set(order.reference, successFor(order, clock.now(), { subaccountCode: 'ACCT_someoneelse' }));
    expect(await verifyAndFulfill(ctx, order.reference, 'WEBHOOK')).toMatchObject({ kind: 'SUBACCOUNT_MISMATCH' });
  });

  it('a test-mode transaction cannot fulfil when the platform is in live mode', async () => {
    const { ctx, db, s, member, paystack, clock } = await setup();
    const order = await createPendingOrder(db, s, member.id);
    paystack.results.set(order.reference, successFor(order, clock.now(), { isLive: false }));
    expect(await verifyAndFulfill(ctx, order.reference, 'WEBHOOK')).toMatchObject({ kind: 'MODE_MISMATCH' });
  });
});

describe('Concurrent early renewals (test 6)', () => {
  it('two concurrent renewals both count — no paid time is lost', async () => {
    const { ctx, db, s, member, paystack, clock } = await setup();
    const first = await createPendingOrder(db, s, member.id);
    paystack.results.set(first.reference, successFor(first, clock.now()));
    await verifyAndFulfill(ctx, first.reference, 'WEBHOOK');
    const start = (await db.membership.findFirstOrThrow()).paidUntil!;

    clock.advanceDays(10); // early renewal with 20 days remaining
    const a = await createPendingOrder(db, s, member.id);
    const b = await createPendingOrder(db, s, member.id);
    paystack.results.set(a.reference, successFor(a, clock.now()));
    paystack.results.set(b.reference, successFor(b, clock.now()));
    const res = await Promise.all([
      verifyAndFulfill(ctx, a.reference, 'WEBHOOK'),
      verifyAndFulfill(ctx, b.reference, 'CALLBACK'),
    ]);
    expect(res.map((r) => r.outcome)).toEqual(['fulfilled', 'fulfilled']);
    const m = await db.membership.findFirstOrThrow();
    expect(m.paidUntil!.getTime()).toBe(start.getTime() + 60 * DAY_MS);
    expect(await db.membershipPaymentApplication.count()).toBe(3);
  });
});

describe('Expired membership renewal (test 7) and stale removal suppression (test 9)', () => {
  it('renewing after expiry starts from payment time; removed member gets a new grant task', async () => {
    const { ctx, db, s, member, paystack, clock, owner } = { ...(await setup()), owner: null } as any;
    const o1 = await createPendingOrder(db, s, member.id);
    paystack.results.set(o1.reference, successFor(o1, clock.now()));
    await verifyAndFulfill(ctx, o1.reference, 'WEBHOOK');
    const grant = await db.accessTask.findFirstOrThrow({ where: { type: 'GRANT' } });
    await completeTask(ctx, { organizationId: s.org.id, userId: s.owner.id }, grant.id);

    clock.advanceDays(31); // expired, no grace
    await evaluateExpiries(ctx);
    const remove = await db.accessTask.findFirstOrThrow({ where: { type: 'REMOVE', status: 'OPEN' } });
    expect((await db.membership.findFirstOrThrow()).accessStatus).toBe('PENDING_REMOVAL');
    await completeTask(ctx, { organizationId: s.org.id, userId: s.owner.id }, remove.id);
    expect((await db.membership.findFirstOrThrow()).accessStatus).toBe('REMOVED');

    clock.advanceDays(5);
    const o2 = await createPendingOrder(db, s, member.id);
    paystack.results.set(o2.reference, successFor(o2, clock.now()));
    const r = await verifyAndFulfill(ctx, o2.reference, 'WEBHOOK');
    expect(r.outcome).toBe('fulfilled');
    const m = await db.membership.findFirstOrThrow();
    expect(m.paidUntil!.getTime()).toBe(clock.now().getTime() + 30 * DAY_MS);
    expect(m.accessStatus).toBe('PENDING_GRANT');
    expect(await db.accessTask.count({ where: { type: 'GRANT', status: 'OPEN', reason: 'RENEWED_AFTER_REMOVAL' } })).toBe(1);
    void owner;
  });

  it('renewal while removal is pending cancels the removal task (no unnecessary grant)', async () => {
    const { ctx, db, s, member, paystack, clock } = await setup();
    const o1 = await createPendingOrder(db, s, member.id);
    paystack.results.set(o1.reference, successFor(o1, clock.now()));
    await verifyAndFulfill(ctx, o1.reference, 'WEBHOOK');
    const grant = await db.accessTask.findFirstOrThrow({ where: { type: 'GRANT' } });
    await completeTask(ctx, { organizationId: s.org.id, userId: s.owner.id }, grant.id);
    clock.advanceDays(30);
    await evaluateExpiries(ctx);
    const remove = await db.accessTask.findFirstOrThrow({ where: { type: 'REMOVE', status: 'OPEN' } });

    const o2 = await createPendingOrder(db, s, member.id);
    paystack.results.set(o2.reference, successFor(o2, clock.now()));
    await verifyAndFulfill(ctx, o2.reference, 'WEBHOOK');

    expect((await db.accessTask.findUniqueOrThrow({ where: { id: remove.id } })).status).toBe('CANCELLED');
    expect((await db.membership.findFirstOrThrow()).accessStatus).toBe('GRANTED');
    expect(await db.accessTask.count({ where: { type: 'GRANT', status: 'OPEN' } })).toBe(0);
  });

  it('completing a removal re-checks entitlement and refuses if the member is paid', async () => {
    const { ctx, db, s, member, paystack, clock } = await setup();
    const o1 = await createPendingOrder(db, s, member.id);
    paystack.results.set(o1.reference, successFor(o1, clock.now()));
    await verifyAndFulfill(ctx, o1.reference, 'WEBHOOK');
    const grant = await db.accessTask.findFirstOrThrow({ where: { type: 'GRANT' } });
    await completeTask(ctx, { organizationId: s.org.id, userId: s.owner.id }, grant.id);
    clock.advanceDays(30);
    await evaluateExpiries(ctx);
    const remove = await db.accessTask.findFirstOrThrow({ where: { type: 'REMOVE', status: 'OPEN' } });
    // Simulate paid time appearing without going through the normal renewal path (e.g. admin fix).
    await db.membership.updateMany({ data: { paidUntil: new Date(clock.now().getTime() + DAY_MS) } });
    const r = await completeTask(ctx, { organizationId: s.org.id, userId: s.owner.id }, remove.id);
    expect(r.outcome).toBe('cancelled_member_renewed');
    expect((await db.membership.findFirstOrThrow()).accessStatus).toBe('GRANTED');
  });
});

describe('Grace period with expiry evaluation (test 8)', () => {
  it('no removal task during grace; removal task exactly when grace ends', async () => {
    const { ctx, db, s, member, paystack, clock } = await setup(3);
    const o = await createPendingOrder(db, s, member.id);
    paystack.results.set(o.reference, successFor(o, clock.now()));
    await verifyAndFulfill(ctx, o.reference, 'WEBHOOK');
    const grant = await db.accessTask.findFirstOrThrow({ where: { type: 'GRANT' } });
    await completeTask(ctx, { organizationId: s.org.id, userId: s.owner.id }, grant.id);
    const paidUntil = (await db.membership.findFirstOrThrow()).paidUntil!;

    clock.t = new Date(paidUntil.getTime()); // exactly at paid_until: grace, not active, not expired
    await evaluateExpiries(ctx);
    expect(await db.accessTask.count({ where: { type: 'REMOVE' } })).toBe(0);

    clock.t = new Date(paidUntil.getTime() + 3 * DAY_MS - 1);
    await evaluateExpiries(ctx);
    expect(await db.accessTask.count({ where: { type: 'REMOVE' } })).toBe(0);

    clock.t = new Date(paidUntil.getTime() + 3 * DAY_MS);
    await evaluateExpiries(ctx);
    expect(await db.accessTask.count({ where: { type: 'REMOVE', status: 'OPEN' } })).toBe(1);
    // Idempotent: re-running does not create another.
    await evaluateExpiries(ctx);
    expect(await db.accessTask.count({ where: { type: 'REMOVE' } })).toBe(1);
  });
});

describe('Callback without verified success (test 12)', () => {
  it('a callback for an unpaid order stays pending and activates nothing', async () => {
    const { ctx, db, s, member, paystack } = await setup();
    const order = await createPendingOrder(db, s, member.id);
    // Provider still reports pending/abandoned — the redirect alone proves nothing.
    paystack.results.set(order.reference, { status: 'abandoned', reference: order.reference });
    const status = await verifyFromCallback(ctx, order.reference);
    expect(status.status).toBe('PENDING');
    expect(status.paidUntil).toBeNull();
    expect(await db.membership.count()).toBe(0);
    expect(paystack.verifyCalls).toBe(1);
  });

  it('a provider-failed payment marks the order failed', async () => {
    const { ctx, db, s, member, paystack } = await setup();
    const order = await createPendingOrder(db, s, member.id);
    paystack.results.set(order.reference, { status: 'failed', reference: order.reference });
    expect((await verifyFromCallback(ctx, order.reference)).status).toBe('FAILED');
    expect(await db.membership.count()).toBe(0);
  });

  it('immutable payment fields cannot be altered in the database', async () => {
    const { ctx, db, s, member, paystack, clock } = await setup();
    const order = await createPendingOrder(db, s, member.id);
    paystack.results.set(order.reference, successFor(order, clock.now()));
    await verifyAndFulfill(ctx, order.reference, 'WEBHOOK');
    await expect(db.payment.updateMany({ data: { amountKobo: 1 } })).rejects.toThrow();
    await expect(db.payment.deleteMany()).rejects.toThrow();
    await expect(db.auditLog.deleteMany()).rejects.toThrow();
  });
});
