import { beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { DAY_MS } from '@communitypass/shared';
import { createPendingOrder, resetDb, seedMember, seedOrg, successFor, testContext } from './test-utils/fixtures';
import { verifyAndFulfill } from './services/fulfillment';
import {
  claimDueNotifications,
  deliverNotification,
  scheduleReminders,
} from './services/notifications';
import { processProviderEvent, recordWhatsappWebhook } from './services/provider-events';

beforeEach(async () => {
  await resetDb();
});

async function setupPaid(opts: { consent?: boolean; graceDays?: number; phone?: string } = {}) {
  const t = testContext();
  const s = await seedOrg(t.db, { name: 'Beta', slug: 'beta', graceDays: opts.graceDays ?? 2 });
  const { member } = await seedMember(t.db, s.org.id, {
    email: 'tunde@example.com',
    phone: opts.phone,
    whatsappConsent: opts.consent ?? true,
  });
  await t.db.whatsappTemplate.createMany({
    data: [
      { purpose: 'PAYMENT_CONFIRMATION', name: 'cp_payment_confirmation', language: 'en', category: 'UTILITY', status: 'APPROVED' },
      { purpose: 'ACCESS_INSTRUCTIONS', name: 'cp_access_instructions', language: 'en', category: 'UTILITY', status: 'APPROVED' },
      { purpose: 'RENEWAL_REMINDER', name: 'cp_renewal_reminder', language: 'en', category: 'UTILITY', status: 'APPROVED' },
      { purpose: 'EXPIRY_NOTICE', name: 'cp_expiry_notice', language: 'en', category: 'UTILITY', status: 'APPROVED' },
    ],
  });
  const order = await createPendingOrder(t.db, s, member.id);
  t.paystack.results.set(order.reference, successFor(order, t.clock.now()));
  await verifyAndFulfill(t.ctx, order.reference, 'WEBHOOK');
  const membership = await t.db.membership.findFirstOrThrow();
  return { ...t, s, member, membership };
}

async function deliverAllDue(ctx: Parameters<typeof deliverNotification>[0]) {
  const ids = await claimDueNotifications(ctx);
  const results = [];
  for (const id of ids) results.push(await deliverNotification(ctx, id));
  return results;
}

describe('Transactional notifications', () => {
  it('queues receipt + access instructions on both consented channels and sends them', async () => {
    const { ctx, db, whatsapp, email } = await setupPaid();
    expect(await db.notification.count()).toBe(4);
    const results = await deliverAllDue(ctx);
    expect(results.every((r) => r.result === 'sent')).toBe(true);
    expect(whatsapp.sent.map((m) => m.templateName).sort()).toEqual(['cp_access_instructions', 'cp_payment_confirmation']);
    expect(email.sent).toHaveLength(2);
    // The private invite link is never placed in messages.
    expect(JSON.stringify([whatsapp.sent, email.sent])).not.toContain('chat.whatsapp.com');
  });

  it('no WhatsApp without consent', async () => {
    const { db } = await setupPaid({ consent: false });
    expect(await db.notification.count({ where: { channel: 'WHATSAPP' } })).toBe(0);
  });
});

describe('Reminder deduplication (test 10)', () => {
  it('running the scheduler repeatedly creates one notification per dedupe key', async () => {
    const { ctx, db, clock, membership } = await setupPaid();
    clock.t = new Date(membership.paidUntil!.getTime() - 3 * DAY_MS - 3600_000);
    await scheduleReminders(ctx);
    await scheduleReminders(ctx);
    await scheduleReminders(ctx);
    const rows = await db.notification.findMany({ where: { type: 'RENEWAL_REMINDER' } });
    expect(rows.map((r) => `${r.channel}:${r.reminderKey}`).sort()).toEqual(['EMAIL:before_3d', 'WHATSAPP:before_3d']);
    expect(rows[0].dedupeKey).toContain(membership.paidUntil!.toISOString());
  });

  it('renewal suppresses stale reminders and new reminders use the new paid_until', async () => {
    const { ctx, db, clock, membership, s, member, paystack } = await setupPaid();
    clock.t = new Date(membership.paidUntil!.getTime() - 3 * DAY_MS);
    await scheduleReminders(ctx);
    const order = await createPendingOrder(db, s, member.id);
    paystack.results.set(order.reference, successFor(order, clock.now()));
    await verifyAndFulfill(ctx, order.reference, 'WEBHOOK');
    const stale = await db.notification.findMany({ where: { type: 'RENEWAL_REMINDER' } });
    expect(stale.every((n) => n.status === 'SUPPRESSED')).toBe(true);
    // An expiry notice for the old paid_until is also suppressed at delivery time.
    clock.t = new Date(membership.paidUntil!.getTime() + 60_000);
    await scheduleReminders(ctx);
    expect(await db.notification.count({ where: { type: 'EXPIRY_NOTICE' } })).toBe(0);
  });

  it('delivery re-checks state: an expiry notice is suppressed if the member renewed', async () => {
    const { ctx, db, clock, membership } = await setupPaid();
    await deliverAllDue(ctx);
    clock.t = new Date(membership.paidUntil!.getTime() + 1000);
    await scheduleReminders(ctx);
    // Renew "behind the scheduler's back" so the stale-suppression in fulfillment is not what saves us.
    await db.membership.update({ where: { id: membership.id }, data: { paidUntil: new Date(clock.now().getTime() + 30 * DAY_MS) } });
    const results = await deliverAllDue(ctx);
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.result === 'suppressed')).toBe(true);
  });
});

describe('Opt-out suppression (test 11)', () => {
  function signMeta(body: string) {
    return 'sha256=' + createHmac('sha256', 'meta_app_secret').update(body).digest('hex');
  }

  it('STOP via signed WhatsApp webhook suppresses queued WhatsApp messages but keeps membership and email', async () => {
    const { ctx, db, whatsapp, clock, membership, member } = await setupPaid();
    clock.t = new Date(membership.paidUntil!.getTime() - 1 * DAY_MS);
    await scheduleReminders(ctx);
    const queued = await claimDueNotifications(ctx);
    expect(queued.length).toBeGreaterThan(0);

    const raw = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ value: { messages: [{ id: 'wamid.in1', from: member.phoneE164.slice(1), type: 'text', text: { body: ' Stop ' } }] } }] }],
    });
    expect((await recordWhatsappWebhook(ctx, Buffer.from(raw), 'sha256=00')).ok).toBe(false);
    const rec = await recordWhatsappWebhook(ctx, Buffer.from(raw), signMeta(raw));
    if (!rec.ok) throw new Error('should record');
    await processProviderEvent(ctx, rec.eventId);

    whatsapp.sent.length = 0;
    for (const id of queued) await deliverNotification(ctx, id);
    expect(whatsapp.sent).toHaveLength(0);
    const wa = await db.notification.findMany({ where: { channel: 'WHATSAPP', type: 'RENEWAL_REMINDER' } });
    expect(wa.every((n) => n.status === 'SUPPRESSED')).toBe(true);
    const em = await db.notification.findMany({ where: { channel: 'EMAIL', type: 'RENEWAL_REMINDER' } });
    expect(em.every((n) => n.status === 'SENT')).toBe(true);
    // Membership untouched
    const m = await db.membership.findUniqueOrThrow({ where: { id: membership.id } });
    expect(m.paidUntil!.getTime()).toBe(membership.paidUntil!.getTime());
    expect(m.cancelledAt).toBeNull();
    expect((await db.notificationConsent.findFirstOrThrow()).status).toBe('WITHDRAWN');
  });

  it('consent is re-checked immediately before sending even if the row was already queued', async () => {
    const { ctx, db, whatsapp, clock, membership } = await setupPaid();
    clock.t = new Date(membership.paidUntil!.getTime() - 1 * DAY_MS);
    await scheduleReminders(ctx);
    const ids = await claimDueNotifications(ctx);
    // Withdraw directly (e.g. via member page) without touching the queued notifications.
    await db.notificationConsent.updateMany({ data: { status: 'WITHDRAWN' } });
    whatsapp.sent.length = 0;
    const results = [];
    for (const id of ids) results.push(await deliverNotification(ctx, id));
    expect(whatsapp.sent).toHaveLength(0);
    expect(results.some((r) => r.result === 'suppressed' && r.reason.includes('consent'))).toBe(true);
  });
});

describe('Ambiguous and retryable send outcomes', () => {
  it('a timeout is flagged for review and never blindly resent', async () => {
    const { ctx, db } = await setupPaid({ phone: '+2348030000998' });
    const results = await deliverAllDue(ctx);
    expect(results.filter((r) => r.result === 'needs_review')).toHaveLength(2);
    const flagged = await db.notification.findFirstOrThrow({ where: { status: 'NEEDS_REVIEW' } });
    // Even if something re-queues it, delivery refuses because the earlier attempt is ambiguous.
    await db.notification.update({ where: { id: flagged.id }, data: { status: 'QUEUED' } });
    expect((await deliverNotification(ctx, flagged.id)).result).toBe('needs_review');
  });

  it('rate-limited sends retry with backoff, then fail after the bounded attempts', async () => {
    const { ctx, db } = await setupPaid({ phone: '+2348030000997' });
    const n = await db.notification.findFirstOrThrow({ where: { channel: 'WHATSAPP', type: 'PAYMENT_RECEIPT' } });
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await deliverNotification(ctx, n.id);
      seen.push(r.result);
      if (r.result !== 'retry') break;
    }
    expect(seen.slice(0, 4)).toEqual(['retry', 'retry', 'retry', 'retry']);
    expect(seen[4]).toBe('failed');
    expect(await db.notificationAttempt.count({ where: { notificationId: n.id } })).toBe(5);
  });
});
