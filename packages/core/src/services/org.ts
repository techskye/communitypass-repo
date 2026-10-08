import type { OnboardingInput, PlanInput } from '@communitypass/shared';
import { DEFAULT_REMINDER_SETTINGS } from '@communitypass/shared';
import type { CoreContext } from '../context';
import { audit, DomainError, isUniqueViolation } from '../infra';

export async function completeOnboarding(ctx: CoreContext, userId: string, input: OnboardingInput) {
  const taken = await ctx.prisma.community.findUnique({ where: { slug: input.community.slug } });
  if (taken) throw new DomainError('SLUG_TAKEN', 'That community link is already taken', 409);
  try {
    return await ctx.prisma.$transaction(async (tx) => {
      const org = await tx.organization.create({
        data: {
          name: input.organizationName,
          displayName: input.displayName,
          supportEmail: input.supportEmail,
          onboardingComplete: true,
          isDemo: ctx.config.appMode === 'demo',
          staff: { create: { userId, role: 'OWNER' } },
          paymentConfig: { create: { status: 'NOT_CONFIGURED' } },
          reminderSettings: { create: { ...(input.reminders ?? DEFAULT_REMINDER_SETTINGS) } },
        },
      });
      const community = await tx.community.create({
        data: {
          organizationId: org.id,
          name: input.community.name,
          description: input.community.description,
          slug: input.community.slug,
          imageUrl: input.community.imageUrl ?? null,
          whatsappInviteUrl: input.community.whatsappInviteUrl,
          accessInstructions: input.community.accessInstructions,
          gracePeriodDays: input.community.gracePeriodDays,
          adminApprovalEnabled: input.community.adminApprovalEnabled,
          isPublished: input.community.isPublished,
        },
      });
      for (const p of input.plans) await createPlanTx(tx, org.id, community.id, p);
      await audit(tx, {
        organizationId: org.id,
        actorType: 'USER',
        actorId: userId,
        action: 'organization.onboarded',
        entityType: 'Organization',
        entityId: org.id,
        metadata: { communityId: community.id, plans: input.plans.length, manualAccessAcknowledged: true },
      });
      return { organization: org, community };
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new DomainError('SLUG_TAKEN', 'That community link is already taken', 409);
    throw e;
  }
}

async function createPlanTx(tx: any, organizationId: string, communityId: string, p: PlanInput) {
  return tx.plan.create({
    data: {
      organizationId,
      communityId,
      name: p.name,
      description: p.description ?? null,
      priceKobo: p.priceKobo,
      currency: 'NGN',
      durationDays: p.durationDays,
    },
  });
}

export { createPlanTx };
