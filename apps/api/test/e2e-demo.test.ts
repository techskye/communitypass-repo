/**
 * End-to-end demo (DEMO MODE, deterministic provider mocks):
 * creator creates community → member pays → membership activates → creator confirms access
 * → reminders run → member renews → expiry extends exactly once.
 *
 * Drives the real HTTP API (Nest app) and the real worker job handlers against PostgreSQL,
 * with a controllable clock.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { DAY_MS } from '@communitypass/shared';
import { resetDb } from '../../../packages/core/src/test-utils/fixtures';
import { claimDueNotifications, deliverNotification, evaluateExpiries, scheduleReminders } from '../../../packages/core/src';
import { agentFor, bootApp, creatorWithOrg } from './helpers';

let app: INestApplication;
let env: Awaited<ReturnType<typeof bootApp>>;

beforeAll(async () => {
  await resetDb();
  env = await bootApp({ mode: 'demo' });
  app = env.app;
  await env.db.whatsappTemplate.createMany({
    data: (['PAYMENT_CONFIRMATION', 'ACCESS_INSTRUCTIONS', 'RENEWAL_REMINDER', 'EXPIRY_NOTICE'] as const).map((purpose) => ({
      purpose,
      name: `cp_${purpose.toLowerCase()}`,
      language: 'en',
      category: 'UTILITY',
      status: 'APPROVED' as const,
    })),
  });
});
afterAll(async () => {
  await app?.close();
});

/** Runs the worker's dispatch + delivery the way BullMQ would. */
async function runWorkerDelivery() {
  const ids = await claimDueNotifications(env.ctx);
  const results = [];
  for (const id of ids) results.push(await deliverNotification(env.ctx, id));
  return results;
}

async function payViaDemoCheckout(pub: Awaited<ReturnType<typeof agentFor>>, startBody: object | null, renewPath?: string) {
  const start = renewPath ? await pub.post(renewPath, {}).expect(200) : await pub.post('/api/public/checkout', startBody!).expect(201);
  const { reference, checkoutUrl, isDemo } = start.body;
  expect(isDemo).toBe(true);
  expect(checkoutUrl).toContain(`/demo-checkout/${reference}`);
  // Before paying, the callback must stay pending.
  expect((await pub.post(`/api/public/orders/${reference}/verify`).expect(200)).body.status).toBe('PENDING');
  // The demo "hosted checkout" completes the payment (and fires a simulated webhook)...
  await pub.post(`/api/public/demo-checkout/${reference}/complete`, { outcome: 'success' }).expect(200);
  // ...and the browser lands on the callback, which re-verifies through the same idempotent service.
  const cb = await pub.post(`/api/public/orders/${reference}/verify`).expect(200);
  expect(cb.body.status).toBe('PAID');
  return { reference, paidUntil: new Date(cb.body.paidUntil) };
}

describe('E2E demo flow', () => {
  it('runs the full membership lifecycle with exactly-once extension', async () => {
    env.clock.set('2026-01-20T09:00:00Z'); // 10:00 Lagos

    // 1. Creator signs up and creates a community (onboarding).
    const creator = await creatorWithOrg(app, 'e2e-fit', 'E2E Coach');
    const pubPage = await (await agentFor(app)).get('/api/public/communities/e2e-fit').expect(200);
    expect(pubPage.body.checkoutAvailable).toBe(true);
    expect(pubPage.body.isDemoCheckout).toBe(true);
    expect(JSON.stringify(pubPage.body)).not.toContain('chat.whatsapp.com');
    const planId = pubPage.body.plans[0].id;

    // 2. Member pays (demo provider) with explicit WhatsApp opt-in.
    const visitor = await agentFor(app);
    const first = await payViaDemoCheckout(visitor, {
      communitySlug: 'e2e-fit',
      planId,
      fullName: 'Ada Obi',
      email: 'ada.e2e@example.com',
      phone: '08031234567',
      whatsappOptIn: true,
      acceptTerms: true,
    });

    // 3. Membership is active for exactly 30 days from the verified payment time.
    expect(first.paidUntil.toISOString()).toBe(new Date(env.clock.now().getTime() + 30 * DAY_MS).toISOString());
    const payment = await env.db.payment.findFirstOrThrow();
    expect(payment.provider).toBe('DEMO');
    expect(payment.isLive).toBe(false); // demo payments are never "live verified"

    // Receipt + access instructions are delivered by the worker (mock adapters only).
    const delivered = await runWorkerDelivery();
    expect(delivered.filter((r) => r.result === 'sent')).toHaveLength(4); // 2 types × (email + WhatsApp)
    expect(env.whatsapp.sent.map((m) => m.templateName).sort()).toEqual(['cp_access_instructions', 'cp_payment_confirmation']);

    // 4. Creator sees the grant task and confirms access.
    const tasks = await creator.get('/api/org/tasks').expect(200);
    expect(tasks.body.items).toHaveLength(1);
    expect(tasks.body.items[0]).toMatchObject({ type: 'GRANT', reason: 'NEW_PAID_MEMBER' });
    expect(tasks.body.items[0].member.phoneE164).toBe('+2348031234567');
    await creator.post(`/api/org/tasks/${tasks.body.items[0].id}/complete`, {}).expect(200);
    const members = await creator.get('/api/org/members').expect(200);
    expect(members.body.items[0]).toMatchObject({ accessStatus: 'GRANTED', entitlement: 'active' });

    // Member signs in (demo magic link) and sees access instructions.
    const member = await agentFor(app);
    const ml = await member.post('/api/member/auth/magic-link', { email: 'ada.e2e@example.com' }).expect(200);
    const token = /#token=([A-Za-z0-9_-]+)/.exec(ml.body.demoLink)![1];
    await member.post('/api/member/auth/verify', { token }).expect(200);
    const [mine] = (await member.get('/api/member/memberships').expect(200)).body;
    expect(mine.entitlement).toBe('active');
    const detail = (await member.get(`/api/member/memberships/${mine.id}`).expect(200)).body;
    expect(detail.access.inviteUrl).toContain('chat.whatsapp.com');

    // 5. Reminders run: 3 days before expiry (crosses into February — fixed 30 days, not a month).
    env.clock.t = new Date(first.paidUntil.getTime() - 3 * DAY_MS);
    await scheduleReminders(env.ctx);
    await scheduleReminders(env.ctx); // idempotent
    const r3 = await runWorkerDelivery();
    expect(r3.filter((r) => r.result === 'sent')).toHaveLength(2); // email + WhatsApp, once each
    expect(env.whatsapp.sent.at(-1)!.templateName).toBe('cp_renewal_reminder');
    expect(await env.db.notification.count({ where: { reminderKey: 'before_3d' } })).toBe(2);

    // 6. Member renews early (2 days before expiry); callback + simulated webhook race on the same payment.
    env.clock.t = new Date(first.paidUntil.getTime() - 2 * DAY_MS);
    // (member sessions last 14 days, so the member signs in again first)
    await member.get('/api/member/memberships').expect(401);
    const ml2 = await member.post('/api/member/auth/magic-link', { email: 'ada.e2e@example.com' }).expect(200);
    await member.post('/api/member/auth/verify', { token: /#token=([A-Za-z0-9_-]+)/.exec(ml2.body.demoLink)![1] }).expect(200);
    const renewal = await payViaDemoCheckout(member, null, `/api/member/memberships/${mine.id}/renew`);

    // 7. Expiry extends exactly once, preserving the remaining 2 days.
    expect(renewal.paidUntil.toISOString()).toBe(new Date(first.paidUntil.getTime() + 30 * DAY_MS).toISOString());
    // Re-verifying again (duplicate callback/webhook/reconciliation) never extends further.
    await member.post(`/api/public/orders/${renewal.reference}/verify`).expect(200);
    await member.post(`/api/public/demo-checkout/${renewal.reference}/complete`, { outcome: 'success' }).expect(200);
    const ms = await env.db.membership.findUniqueOrThrow({ where: { id: mine.id } });
    expect(ms.paidUntil!.toISOString()).toBe(renewal.paidUntil.toISOString());
    expect(await env.db.membershipPaymentApplication.count({ where: { membershipId: mine.id } })).toBe(2);
    expect(ms.accessStatus).toBe('GRANTED'); // still in the group → no unnecessary grant task
    expect(await env.db.accessTask.count({ where: { type: 'GRANT', status: 'OPEN' } })).toBe(0);

    // Renewal receipts go out (no access-instructions message: the member is still in the group).
    const receipts = await runWorkerDelivery();
    expect(receipts.filter((r) => r.result === 'sent')).toHaveLength(2);
    expect(env.whatsapp.sent.at(-1)!.templateName).toBe('cp_payment_confirmation');

    // The stale 1-day reminder and expiry notice for the OLD paid_until never go out.
    env.clock.t = new Date(first.paidUntil.getTime() + 60_000);
    await scheduleReminders(env.ctx);
    await evaluateExpiries(env.ctx);
    const after = await runWorkerDelivery();
    expect(after.filter((r) => r.result === 'sent')).toHaveLength(0);
    expect(await env.db.accessTask.count({ where: { type: 'REMOVE' } })).toBe(0);
    const stale = await env.db.notification.findMany({ where: { paidUntilSnapshot: first.paidUntil, type: { in: ['RENEWAL_REMINDER', 'EXPIRY_NOTICE'] } } });
    expect(stale.every((n) => n.status !== 'SENT' || n.reminderKey === 'before_3d')).toBe(true);

    // Dashboard metrics are database-derived. (Creator sessions last 7 days: sign in again.)
    await creator.post('/api/auth/login', { email: 'e2e-fit@creator.test', password: 'correct-horse-battery' }).expect(200);
    const dash = await creator.get('/api/org/dashboard').expect(200);
    expect(dash.body.metrics.collections.allTimeKobo).toBe(1000000);
    expect(dash.body.metrics.collections.includesDemoPayments).toBe(true);
    expect(dash.body.metrics.memberships.activePaid).toBe(1);

    // Audit trail captured both applications.
    expect(await env.db.auditLog.count({ where: { action: 'membership.payment_applied', entityId: mine.id } })).toBe(2);
  });
});
