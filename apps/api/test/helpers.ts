import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/app';
import { testContext } from '../../../packages/core/src/test-utils/fixtures';

export type Agent = ReturnType<typeof request.agent>;

export async function bootApp(opts: Parameters<typeof testContext>[0] = {}) {
  const t = testContext(opts);
  const app = await createApp(t.ctx as any, { logger: false, throttle: false });
  await app.init();
  return { ...t, app };
}

/** Agent with a CSRF cookie and a helper that adds the matching header. */
export async function agentFor(app: INestApplication) {
  const agent = request.agent(app.getHttpServer());
  await agent.get('/api/auth/csrf').expect(200);
  const origin = 'http://localhost:3000';
  // The API rotates the CSRF cookie on login/signup; always echo the current cookie value,
  // exactly like the browser client does.
  const csrf = (): string => {
    const jar = (agent as any).jar;
    const all = jar.getCookies({ domain: '127.0.0.1', path: '/', secure: false, script: false });
    const c = all.find((x: any) => x.name === 'cp_csrf');
    return c?.value ?? '';
  };
  const send = (t: request.Test, body?: object) => t.set('x-csrf-token', csrf()).set('Origin', origin).send(body ?? {});
  return {
    agent,
    get csrf() {
      return csrf();
    },
    get: (url: string) => agent.get(url),
    post: (url: string, body?: object) => send(agent.post(url), body),
    put: (url: string, body?: object) => send(agent.put(url), body),
    del: (url: string) => send(agent.delete(url)),
  };
}

export const onboardingBody = (slug: string, name: string, tier: 'STARTER' | 'GROWTH' | 'PRO' = 'STARTER') => ({
  organizationName: `${name} Ltd`,
  displayName: name,
  supportEmail: `${slug}@example.com`,
  community: {
    name: `${name} Community`,
    description: 'A test community',
    slug,
    whatsappInviteUrl: `https://chat.whatsapp.com/${slug.replace(/-/g, '')}SECRET123`,
    accessInstructions: 'Request to join, then wait for approval.',
    gracePeriodDays: 1,
    adminApprovalEnabled: true,
    isPublished: true,
  },
  plans: [{ name: '30-day membership', priceKobo: 500000, durationDays: 30 }],
  tier,
  acknowledgeManualAccess: true,
});

export async function creatorWithOrg(app: INestApplication, slug: string, name: string, tier: 'STARTER' | 'GROWTH' | 'PRO' = 'STARTER') {
  const a = await agentFor(app);
  await a.post('/api/auth/signup', { name, email: `${slug}@creator.test`, password: 'correct-horse-battery' }).expect(201);
  const r = await a.post('/api/org/onboarding', onboardingBody(slug, name, tier)).expect(201);
  return { ...a, organizationId: r.body.organizationId as string, communityId: r.body.communityId as string };
}
