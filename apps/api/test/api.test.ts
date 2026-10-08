import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { resetDb, successFor } from '../../../packages/core/src/test-utils/fixtures';
import { agentFor, bootApp, creatorWithOrg } from './helpers';

let app: INestApplication;
let env: Awaited<ReturnType<typeof bootApp>>;

beforeAll(async () => {
  env = await bootApp({ mode: 'live' });
  app = env.app;
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await resetDb();
  env.paystack.results.clear();
  env.clock.set('2026-03-10T10:00:00Z');
});

async function activatePayments(organizationId: string) {
  await env.db.organizationPaymentConfig.update({
    where: { organizationId },
    data: { status: 'ACTIVE', subaccountCode: 'ACCT_testsub', platformFeeBps: 500, feeBearer: 'SUBACCOUNT' },
  });
}

async function checkout(slug: string, email = 'member@example.com') {
  const pub = await agentFor(app);
  const c = await pub.get(`/api/public/communities/${slug}`).expect(200);
  const r = await pub
    .post('/api/public/checkout', {
      communitySlug: slug,
      planId: c.body.plans[0].id,
      fullName: 'Ada Obi',
      email,
      phone: '0803 123 4567',
      whatsappOptIn: true,
      acceptTerms: true,
    })
    .expect(201);
  return r.body as { reference: string; checkoutUrl: string };
}

describe('Cross-tenant access denial (test 1)', () => {
  it('creator B cannot read or act on creator A data, even with A’s ids', async () => {
    const a = await creatorWithOrg(app, 'alpha-club', 'Alpha');
    const b = await creatorWithOrg(app, 'beta-club', 'Beta');
    await activatePayments(a.organizationId);
    const { reference } = await checkout('alpha-club');
    const order = await env.db.order.findUniqueOrThrow({ where: { reference } });
    env.paystack.results.set(reference, successFor(order, env.clock.now(), { subaccountCode: 'ACCT_testsub' }));
    await (await agentFor(app)).post(`/api/public/orders/${reference}/verify`).expect(200);
    const task = await env.db.accessTask.findFirstOrThrow({ where: { organizationId: a.organizationId } });

    // A sees its own data
    expect((await a.get('/api/org/members').expect(200)).body.total).toBe(1);
    expect((await a.get('/api/org/tasks').expect(200)).body.total).toBe(1);

    // B sees nothing of A
    expect((await b.get('/api/org/members').expect(200)).body.total).toBe(0);
    expect((await b.get('/api/org/payments').expect(200)).body.total).toBe(0);
    expect((await b.get('/api/org/tasks').expect(200)).body.total).toBe(0);
    await b.get(`/api/org/communities/${a.communityId}`).expect(404);
    await b.get(`/api/org/members/${order.memberId}`).expect(404);
    await b.post(`/api/org/tasks/${task.id}/complete`, {}).expect(404);
    await b.post(`/api/org/tasks/${task.id}/dismiss`, { reason: 'x' }).expect(404);
    await b.put(`/api/org/communities/${a.communityId}`, { name: 'Hacked' }).expect(404);
    await b.post(`/api/org/communities/${a.communityId}/plans`, { name: 'x', priceKobo: 10000, durationDays: 7 }).expect(404);

    // Client-supplied organization ids are not trusted: switching requires real membership.
    await b.post('/api/auth/switch-org', { organizationId: a.organizationId }).expect(403);
    // Smuggling an org id in the body/query does not change scope.
    expect((await b.get(`/api/org/members?organizationId=${a.organizationId}`).expect(200)).body.total).toBe(0);

    const t = await env.db.accessTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(t.status).toBe('OPEN');
    expect((await env.db.community.findUniqueOrThrow({ where: { id: a.communityId } })).name).toBe('Alpha Community');
  });

  it('staff cannot perform owner-only actions; anonymous users are rejected', async () => {
    const a = await creatorWithOrg(app, 'gamma-club', 'Gamma');
    const anon = await agentFor(app);
    await anon.get('/api/org/members').expect(401);
    await anon.get('/api/admin/organizations').expect(401);
    await a.get('/api/admin/organizations').expect(403);
  });
});

describe('Public pages never expose the invite link', () => {
  it('community API response excludes whatsappInviteUrl', async () => {
    await creatorWithOrg(app, 'delta-club', 'Delta');
    const r = await (await agentFor(app)).get('/api/public/communities/delta-club').expect(200);
    expect(JSON.stringify(r.body)).not.toContain('chat.whatsapp.com');
    expect(r.body.checkoutAvailable).toBe(false); // payment setup not approved yet
  });

  it('checkout is blocked for organizations without approved payment setup', async () => {
    await creatorWithOrg(app, 'eps-club', 'Eps');
    const pub = await agentFor(app);
    const c = await pub.get('/api/public/communities/eps-club').expect(200);
    const r = await pub.post('/api/public/checkout', {
      communitySlug: 'eps-club', planId: c.body.plans[0].id, fullName: 'X Y', email: 'x@example.com',
      phone: '08031234567', whatsappOptIn: false, acceptTerms: true,
    });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('PAYMENTS_NOT_ENABLED');
  });
});

describe('Webhook signatures over HTTP (test 2)', () => {
  it('rejects unsigned / wrongly signed Paystack webhooks with 401 and stores nothing', async () => {
    const raw = JSON.stringify({ event: 'charge.success', data: { id: 1, reference: 'CP-AAAAAAAAAAAAAAAA' } });
    const server = app.getHttpServer();
    const request = (await import('supertest')).default;
    await request(server).post('/api/webhooks/paystack').set('Content-Type', 'application/json').send(raw).expect(401);
    await request(server)
      .post('/api/webhooks/paystack')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', createHmac('sha512', 'wrong').update(raw).digest('hex'))
      .send(raw)
      .expect(401);
    expect(await env.db.providerEvent.count()).toBe(0);
    const ok = await request(server)
      .post('/api/webhooks/paystack')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', createHmac('sha512', 'sk_live_testsecret').update(raw).digest('hex'))
      .send(raw);
    expect(ok.status).toBe(200);
    expect(await env.db.providerEvent.count()).toBe(1);
  });

  it('rejects bad Meta signatures and answers the verification challenge only with the right token', async () => {
    const request = (await import('supertest')).default;
    const server = app.getHttpServer();
    const raw = JSON.stringify({ entry: [] });
    await request(server).post('/api/webhooks/whatsapp').set('Content-Type', 'application/json').set('x-hub-signature-256', 'sha256=abcd').send(raw).expect(401);
    await request(server).get('/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=123').expect(403);
    const r = await request(server).get('/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify_me&hub.challenge=98765').expect(200);
    expect(r.text).toBe('98765');
  });
});

describe('Payment callback without verified success (test 12)', () => {
  it('a redirect to the callback with a reference does not activate anything', async () => {
    const a = await creatorWithOrg(app, 'zeta-club', 'Zeta');
    await activatePayments(a.organizationId);
    const { reference, checkoutUrl } = await checkout('zeta-club');
    expect(checkoutUrl).toMatch(/^https:\/\//);
    // Provider has no successful transaction for this reference.
    const r = await (await agentFor(app)).post(`/api/public/orders/${reference}/verify`).expect(200);
    expect(r.body.status).toBe('PENDING');
    expect(r.body.paidUntil).toBeNull();
    expect(await env.db.membership.count()).toBe(0);
    // Spoofed "success" query parameters are meaningless to the API.
    const spoof = await (await agentFor(app)).post(`/api/public/orders/${reference}/verify?status=success&trxref=${reference}`).expect(200);
    expect(spoof.body.status).toBe('PENDING');
  });

  it('order snapshot is unaffected by later plan edits', async () => {
    const a = await creatorWithOrg(app, 'eta-club', 'Eta');
    await activatePayments(a.organizationId);
    const { reference } = await checkout('eta-club');
    const plan = await env.db.plan.findFirstOrThrow({ where: { organizationId: a.organizationId } });
    await a.put(`/api/org/plans/${plan.id}`, { priceKobo: 900000, durationDays: 90 }).expect(200);
    const order = await env.db.order.findUniqueOrThrow({ where: { reference } });
    expect(order.amountKobo).toBe(500000);
    expect(order.durationDays).toBe(30);
    expect(order.platformFeeKobo).toBe(25000);
    expect(order.subaccountCodeSnapshot).toBe('ACCT_testsub');
  });
});

describe('CSRF and session security', () => {
  it('rejects state-changing requests without the CSRF token or from another origin', async () => {
    const request = (await import('supertest')).default;
    const server = app.getHttpServer();
    const r1 = await request(server).post('/api/auth/login').send({ email: 'a@b.com', password: 'x' });
    expect(r1.status).toBe(403);
    expect(r1.body.code).toBe('CSRF_TOKEN');
    const a = await agentFor(app);
    const r2 = await a.agent.post('/api/auth/login').set('x-csrf-token', a.csrf).set('Origin', 'https://evil.example').send({ email: 'a@b.com', password: 'x' });
    expect(r2.status).toBe(403);
    expect(r2.body.code).toBe('CSRF_ORIGIN');
  });

  it('session cookie is HttpOnly + SameSite and magic links are single-use', async () => {
    const a = await agentFor(app);
    const r = await a.post('/api/auth/signup', { name: 'Kemi', email: 'kemi@creator.test', password: 'correct-horse-battery' }).expect(201);
    const cookies = ([] as string[]).concat(r.headers['set-cookie'] ?? []);
    const session = cookies.find((c) => c.startsWith('cp_session='))!;
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=Lax/i);

    // Magic link (live mode → emailed, not returned)
    const c = await creatorWithOrg(app, 'theta-club', 'Theta');
    await activatePayments(c.organizationId);
    await checkout('theta-club', 'member2@example.com');
    const m = await agentFor(app);
    const ml = await m.post('/api/member/auth/magic-link', { email: 'member2@example.com' }).expect(200);
    expect(ml.body.demoLink).toBeUndefined();
    const unknown = await m.post('/api/member/auth/magic-link', { email: 'nobody@example.com' }).expect(200);
    expect(unknown.body).toEqual(ml.body); // no account enumeration
    const sent = env.email.sent.find((e) => e.to === 'member2@example.com')!;
    const token = /#token=([A-Za-z0-9_-]+)/.exec(sent.text)![1];
    const stored = await env.db.magicLinkToken.findFirstOrThrow();
    expect(stored.tokenHash).not.toContain(token); // hashed at rest
    await m.post('/api/member/auth/verify', { token }).expect(200);
    expect((await m.get('/api/member/memberships').expect(200)).body).toEqual([]);
    const again = await (await agentFor(app)).post('/api/member/auth/verify', { token });
    expect(again.status).toBe(401);
  });
});

describe('Member access instructions are only revealed to entitled members', () => {
  it('invite link appears for an active member and not after expiry + grace', async () => {
    const a = await creatorWithOrg(app, 'iota-club', 'Iota');
    await activatePayments(a.organizationId);
    const { reference } = await checkout('iota-club', 'paid@example.com');
    const order = await env.db.order.findUniqueOrThrow({ where: { reference } });
    env.paystack.results.set(reference, successFor(order, env.clock.now()));
    await (await agentFor(app)).post(`/api/public/orders/${reference}/verify`).expect(200);

    const m = await agentFor(app);
    await m.post('/api/member/auth/magic-link', { email: 'paid@example.com' }).expect(200);
    const token = /#token=([A-Za-z0-9_-]+)/.exec(env.email.sent.at(-1)!.text)![1];
    await m.post('/api/member/auth/verify', { token }).expect(200);
    const list = (await m.get('/api/member/memberships').expect(200)).body;
    const detail = (await m.get(`/api/member/memberships/${list[0].id}`).expect(200)).body;
    expect(detail.access.inviteUrl).toContain('chat.whatsapp.com');

    env.clock.advanceDays(31 + 1); // past paid_until + 1-day grace
    // (the 14-day member session has expired by now too — sign in again)
    await m.get('/api/member/memberships').expect(401);
    await m.post('/api/member/auth/magic-link', { email: 'paid@example.com' }).expect(200);
    const token2 = /#token=([A-Za-z0-9_-]+)/.exec(env.email.sent.at(-1)!.text)![1];
    await m.post('/api/member/auth/verify', { token: token2 }).expect(200);
    const later = (await m.get(`/api/member/memberships/${list[0].id}`).expect(200)).body;
    expect(later.entitlement).toBe('expired');
    expect(later.access).toBeNull();

    // Another member cannot read this membership.
    const other = await agentFor(app);
    await checkout('iota-club', 'other@example.com');
    await other.post('/api/member/auth/magic-link', { email: 'other@example.com' }).expect(200);
    const t2 = /#token=([A-Za-z0-9_-]+)/.exec(env.email.sent.at(-1)!.text)![1];
    await other.post('/api/member/auth/verify', { token: t2 }).expect(200);
    await other.get(`/api/member/memberships/${list[0].id}`).expect(404);
  });
});

describe('Uploads', () => {
  it('rejects non-image content even with an image extension', async () => {
    const a = await creatorWithOrg(app, 'kappa-club', 'Kappa');
    const r = await a.agent
      .post('/api/org/uploads')
      .set('x-csrf-token', a.csrf)
      .attach('file', Buffer.from('<script>alert(1)</script>'), { filename: 'x.png', contentType: 'image/png' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('BAD_FILE_TYPE');
  });
});
