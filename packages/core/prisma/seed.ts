/**
 * DEMO SEED — isolated demo data for local development and demos only.
 * Refuses to run unless APP_MODE=demo. Every payment created here goes through the demo
 * provider and the real fulfillment service, and is flagged isLive=false.
 */
import { PrismaClient } from '@prisma/client';
import { DAY_MS, DEFAULT_REMINDER_SETTINGS } from '@communitypass/shared';
import { loadConfig } from '../src/config';
import { buildAdapters, CoreContext } from '../src/context';
import { createLogger, newPaymentReference } from '../src/infra';
import { hashPassword } from '../src/services/auth';
import { fulfillVerifiedTransaction } from '../src/services/fulfillment';
import { evaluateExpiries, completeTask } from '../src/services/access';

const DEMO_PASSWORD = 'demo-password-123';

async function main() {
  const config = loadConfig();
  if (config.appMode !== 'demo') {
    throw new Error('Refusing to seed: the demo seed only runs with APP_MODE=demo');
  }
  const prisma = new PrismaClient();
  const realNow = new Date();
  let clock = realNow;
  const ctx: CoreContext = {
    prisma,
    config,
    adapters: buildAdapters(config, prisma),
    logger: createLogger('seed'),
    now: () => clock,
  };

  if (await prisma.organization.count()) {
    console.log('Database already has organizations — skipping seed (reset the DB to reseed).');
    await prisma.$disconnect();
    return;
  }

  const pw = await hashPassword(DEMO_PASSWORD);
  const admin = await prisma.user.create({
    data: { email: 'admin@communitypass.test', name: 'Platform Admin', passwordHash: pw, isPlatformAdmin: true },
  });

  // WhatsApp template configuration (demo: marked approved; the mock adapter never sends).
  await prisma.whatsappTemplate.createMany({
    data: [
      { purpose: 'PAYMENT_CONFIRMATION', name: 'cp_payment_confirmation', language: 'en', category: 'UTILITY', status: 'APPROVED' },
      { purpose: 'ACCESS_INSTRUCTIONS', name: 'cp_access_instructions', language: 'en', category: 'UTILITY', status: 'APPROVED' },
      { purpose: 'RENEWAL_REMINDER', name: 'cp_renewal_reminder', language: 'en', category: 'UTILITY', status: 'PENDING' },
      { purpose: 'EXPIRY_NOTICE', name: 'cp_expiry_notice', language: 'en', category: 'UTILITY', status: 'APPROVED' },
    ],
  });

  async function makeOrg(p: {
    name: string;
    display: string;
    ownerEmail: string;
    ownerName: string;
    staffEmail?: string;
    community: { name: string; slug: string; description: string; grace: number; invite: string; instructions: string };
    plans: { name: string; priceKobo: number; durationDays: number }[];
  }) {
    const owner = await prisma.user.create({ data: { email: p.ownerEmail, name: p.ownerName, passwordHash: pw } });
    const org = await prisma.organization.create({
      data: {
        name: p.name,
        displayName: p.display,
        supportEmail: p.ownerEmail.replace('@', '+support@'),
        isDemo: true,
        onboardingComplete: true,
        staff: { create: [{ userId: owner.id, role: 'OWNER' }] },
        paymentConfig: { create: { status: 'NOT_CONFIGURED', notes: 'Demo organization — demo payments only' } },
        reminderSettings: { create: { ...DEFAULT_REMINDER_SETTINGS } },
      },
    });
    if (p.staffEmail) {
      const staff = await prisma.user.create({ data: { email: p.staffEmail, name: 'Demo Staff', passwordHash: pw } });
      await prisma.organizationStaff.create({ data: { organizationId: org.id, userId: staff.id, role: 'STAFF' } });
    }
    const community = await prisma.community.create({
      data: {
        organizationId: org.id,
        name: p.community.name,
        slug: p.community.slug,
        description: p.community.description,
        whatsappInviteUrl: p.community.invite,
        accessInstructions: p.community.instructions,
        gracePeriodDays: p.community.grace,
        adminApprovalEnabled: true,
      },
    });
    const plans = [];
    for (const pl of p.plans) {
      plans.push(
        await prisma.plan.create({
          data: { organizationId: org.id, communityId: community.id, currency: 'NGN', ...pl },
        }),
      );
    }
    return { owner, org, community, plans };
  }

  const fit = await makeOrg({
    name: 'Chioma Fitness Ltd',
    display: 'Coach Chioma',
    ownerEmail: 'chioma@demo.communitypass.test',
    ownerName: 'Chioma Eze',
    staffEmail: 'staff@demo.communitypass.test',
    community: {
      name: 'Fit Fam Lagos',
      slug: 'fit-fam-lagos',
      description: 'Daily home workouts, meal plans and accountability check-ins with Coach Chioma.',
      grace: 2,
      invite: 'https://chat.whatsapp.com/DemoFitFamInvite01',
      instructions: 'Tap the invite link, then "Request to join". Coach Chioma approves requests every evening.',
    },
    plans: [
      { name: 'Weekly pass', priceKobo: 150000, durationDays: 7 },
      { name: '30-day membership', priceKobo: 500000, durationDays: 30 },
      { name: '90-day membership', priceKobo: 1350000, durationDays: 90 },
    ],
  });
  const tech = await makeOrg({
    name: 'Lagos Founders Network',
    display: 'Emeka Okafor',
    ownerEmail: 'emeka@demo.communitypass.test',
    ownerName: 'Emeka Okafor',
    community: {
      name: 'Lagos Tech Founders',
      slug: 'lagos-tech-founders',
      description: 'A private circle for early-stage founders: weekly AMAs, intros and hiring threads.',
      grace: 0,
      invite: 'https://chat.whatsapp.com/DemoFoundersInvite02',
      instructions: 'Use the link below and send a short intro once you are approved.',
    },
    plans: [
      { name: '30-day membership', priceKobo: 1000000, durationDays: 30 },
      { name: '365-day membership', priceKobo: 10000000, durationDays: 365 },
    ],
  });

  async function member(orgId: string, email: string, name: string, phone: string, consent: boolean) {
    const acc = await prisma.memberAccount.upsert({ where: { email }, create: { email }, update: {} });
    const m = await prisma.member.create({
      data: { organizationId: orgId, memberAccountId: acc.id, fullName: name, email, phoneE164: phone },
    });
    if (consent) {
      await prisma.notificationConsent.create({
        data: {
          organizationId: orgId,
          memberId: m.id,
          channel: 'WHATSAPP',
          scope: 'membership_service',
          status: 'GRANTED',
          phoneE164: phone,
          wordingVersion: 'wa-v1',
          wordingText: 'Demo consent',
          source: 'signup_form',
          grantedAt: clock,
        },
      });
    }
    return m;
  }

  /** Pay through the demo provider + real fulfillment service at a past moment. */
  async function pay(o: typeof fit, memberId: string, planIdx: number, daysAgo: number) {
    const plan = o.plans[planIdx];
    clock = new Date(realNow.getTime() - daysAgo * DAY_MS);
    const reference = newPaymentReference();
    await prisma.order.create({
      data: {
        organizationId: o.org.id,
        communityId: o.community.id,
        planId: plan.id,
        memberId,
        reference,
        provider: 'DEMO',
        isDemo: true,
        planNameSnapshot: plan.name,
        communityNameSnapshot: o.community.name,
        amountKobo: plan.priceKobo,
        currency: 'NGN',
        durationDays: plan.durationDays,
        createdAt: clock,
      },
    });
    await prisma.demoTransaction.create({
      data: { reference, status: 'success', amountKobo: plan.priceKobo, currency: 'NGN', paidAt: clock },
    });
    const v = await ctx.adapters.payments.DEMO!.verify(reference);
    await fulfillVerifiedTransaction(ctx, reference, v, 'WEBHOOK');
    clock = realNow;
  }

  async function grant(o: typeof fit, memberId: string, daysAgo: number) {
    clock = new Date(realNow.getTime() - daysAgo * DAY_MS);
    const task = await prisma.accessTask.findFirst({ where: { memberId, type: 'GRANT', status: 'OPEN' } });
    if (task) await completeTask(ctx, { organizationId: o.org.id, userId: o.owner.id }, task.id);
    clock = realNow;
  }

  // ── Fit Fam scenarios ──
  const amaka = await member(fit.org.id, 'amaka@demo.communitypass.test', 'Amaka Nwosu', '+2348031110001', true);
  await pay(fit, amaka.id, 1, 10); // active, granted
  await grant(fit, amaka.id, 9);

  const bayo = await member(fit.org.id, 'bayo@demo.communitypass.test', 'Bayo Adeyemi', '+2348031110002', true);
  await pay(fit, bayo.id, 0, 5); // 7-day plan, expires in 2 days
  await grant(fit, bayo.id, 5);

  const ngozi = await member(fit.org.id, 'ngozi@demo.communitypass.test', 'Ngozi Okeke', '+2348031110003', false);
  await pay(fit, ngozi.id, 0, 8); // expired 1 day ago, inside 2-day grace
  await grant(fit, ngozi.id, 8);

  const tobi = await member(fit.org.id, 'tobi@demo.communitypass.test', 'Tobi Bello', '+2348031110004', true);
  await pay(fit, tobi.id, 0, 12); // fully expired -> removal task
  await grant(fit, tobi.id, 12);

  const ife = await member(fit.org.id, 'ife@demo.communitypass.test', 'Ifeoma Uche', '+2348031110005', true);
  await pay(fit, ife.id, 1, 0); // new paid member -> pending grant task

  const kunle = await member(fit.org.id, 'kunle@demo.communitypass.test', 'Kunle Ajayi', '+2348030000999', true);
  await pay(fit, kunle.id, 2, 3); // WhatsApp number that deterministically fails in the mock
  await grant(fit, kunle.id, 3);

  // ── Lagos Tech Founders scenarios (amaka is a member of BOTH creators) ──
  const amakaT = await member(tech.org.id, 'amaka@demo.communitypass.test', 'Amaka Nwosu', '+2348031110001', true);
  await pay(tech, amakaT.id, 1, 40);
  await grant(tech, amakaT.id, 39);
  const dayo = await member(tech.org.id, 'dayo@demo.communitypass.test', 'Dayo Lawal', '+2348031110006', true);
  await pay(tech, dayo.id, 0, 20);
  await pay(tech, dayo.id, 0, 2); // early renewal keeps remaining time
  await grant(tech, dayo.id, 19);

  await evaluateExpiries(ctx);

  await prisma.saasBillingRecord.create({
    data: {
      organizationId: fit.org.id,
      periodStart: new Date(realNow.getTime() - 30 * DAY_MS),
      periodEnd: realNow,
      amountKobo: 0,
      status: 'WAIVED',
      note: 'Demo: pilot period (recorded manually)',
      recordedByUserId: admin.id,
    },
  });

  console.log('Demo seed complete. All demo accounts use the password:', DEMO_PASSWORD);
  console.log('  Platform admin : admin@communitypass.test');
  console.log('  Creator A      : chioma@demo.communitypass.test  (community /c/fit-fam-lagos)');
  console.log('  Creator A staff: staff@demo.communitypass.test');
  console.log('  Creator B      : emeka@demo.communitypass.test   (community /c/lagos-tech-founders)');
  console.log('  Member (both)  : amaka@demo.communitypass.test  (magic link appears in the demo outbox)');
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
