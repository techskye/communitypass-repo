import {
  CURRENT_WHATSAPP_CONSENT_VERSION,
  WHATSAPP_CONSENT_VERSIONS,
  getEntitlement,
  graceEndsAt,
  hasAccessEntitlement,
} from '@communitypass/shared';
import type { CoreContext } from '../context';
import { audit, NotFoundError } from '../infra';
import { WHATSAPP_SERVICE_SCOPE } from './notifications';

/** Memberships for a signed-in member account, across all creators. */
export async function listMyMemberships(ctx: CoreContext, memberAccountId: string) {
  const now = ctx.now();
  const rows = await ctx.prisma.membership.findMany({
    where: { member: { memberAccountId } },
    include: {
      community: { select: { id: true, name: true, slug: true, imageUrl: true, gracePeriodDays: true } },
      plan: { select: { id: true, name: true, durationDays: true, priceKobo: true, isActive: true } },
      organization: { select: { displayName: true, supportEmail: true, supportWhatsapp: true } },
    },
    orderBy: { paidUntil: 'desc' },
  });
  return rows.map((m) => {
    const ent = getEntitlement(m.paidUntil, m.community.gracePeriodDays, now);
    return {
      id: m.id,
      community: { name: m.community.name, slug: m.community.slug, imageUrl: m.community.imageUrl },
      creator: m.organization,
      plan: m.plan,
      paidUntil: m.paidUntil,
      graceEndsAt: m.paidUntil && m.community.gracePeriodDays ? graceEndsAt(m.paidUntil, m.community.gracePeriodDays) : null,
      entitlement: ent,
      accessStatus: m.accessStatus,
      cancelled: !!m.cancelledAt,
    };
  });
}

/**
 * Membership detail. The WhatsApp invite link is included ONLY for the authenticated owner
 * of a currently entitled (active or grace) membership.
 */
export async function getMyMembership(ctx: CoreContext, memberAccountId: string, membershipId: string) {
  const now = ctx.now();
  const m = await ctx.prisma.membership.findFirst({
    where: { id: membershipId, member: { memberAccountId } },
    include: {
      community: true,
      plan: true,
      organization: { select: { displayName: true, supportEmail: true, supportWhatsapp: true } },
      applications: { include: { payment: true }, orderBy: { createdAt: 'desc' } },
      member: { select: { fullName: true } },
    },
  });
  if (!m) throw new NotFoundError('Membership');
  const ent = getEntitlement(m.paidUntil, m.community.gracePeriodDays, now);
  const eligible = hasAccessEntitlement(ent);
  if (eligible) {
    await audit(ctx.prisma, {
      organizationId: m.organizationId,
      actorType: 'MEMBER',
      actorId: m.memberId,
      action: 'membership.access_instructions_viewed',
      entityType: 'Membership',
      entityId: m.id,
    });
  }
  return {
    id: m.id,
    memberName: m.member.fullName,
    community: {
      name: m.community.name,
      slug: m.community.slug,
      description: m.community.description,
      imageUrl: m.community.imageUrl,
      gracePeriodDays: m.community.gracePeriodDays,
      adminApprovalEnabled: m.community.adminApprovalEnabled,
    },
    creator: m.organization,
    plan: { id: m.plan.id, name: m.plan.name, durationDays: m.plan.durationDays, priceKobo: m.plan.priceKobo, isActive: m.plan.isActive },
    paidUntil: m.paidUntil,
    graceEndsAt: m.paidUntil && m.community.gracePeriodDays ? graceEndsAt(m.paidUntil, m.community.gracePeriodDays) : null,
    entitlement: ent,
    accessStatus: m.accessStatus,
    cancelled: !!m.cancelledAt,
    access: eligible
      ? { inviteUrl: m.community.whatsappInviteUrl, instructions: m.community.accessInstructions }
      : null,
    payments: m.applications.map((a) => ({
      id: a.payment.id,
      reference: a.payment.reference,
      amountKobo: a.payment.amountKobo,
      currency: a.payment.currency,
      paidAt: a.payment.paidAt,
      status: a.payment.status,
      isDemo: a.payment.provider === 'DEMO',
      durationDays: a.durationDays,
      newPaidUntil: a.newPaidUntil,
    })),
  };
}

export async function listMyPayments(ctx: CoreContext, memberAccountId: string) {
  const orders = await ctx.prisma.order.findMany({
    where: { member: { memberAccountId } },
    include: { payment: true, organization: { select: { displayName: true } } },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  return orders.map((o) => ({
    reference: o.reference,
    creator: o.organization.displayName,
    community: o.communityNameSnapshot,
    plan: o.planNameSnapshot,
    amountKobo: o.amountKobo,
    durationDays: o.durationDays,
    orderStatus: o.status,
    paymentStatus: o.payment?.status ?? null,
    isDemo: o.isDemo,
    createdAt: o.createdAt,
    paidAt: o.payment?.paidAt ?? null,
  }));
}

/** Cancellation = no intent to renew. Purchased paid time is kept. */
export async function cancelMyMembership(ctx: CoreContext, memberAccountId: string, membershipId: string, reason?: string) {
  const m = await ctx.prisma.membership.findFirst({ where: { id: membershipId, member: { memberAccountId } } });
  if (!m) throw new NotFoundError('Membership');
  if (m.cancelledAt) return;
  await ctx.prisma.membership.update({ where: { id: m.id }, data: { cancelledAt: ctx.now() } });
  await ctx.prisma.notification.updateMany({
    where: { membershipId: m.id, type: 'RENEWAL_REMINDER', status: { in: ['SCHEDULED', 'QUEUED'] } },
    data: { status: 'SUPPRESSED', suppressedReason: 'member cancelled renewal' },
  });
  await audit(ctx.prisma, {
    organizationId: m.organizationId,
    actorType: 'MEMBER',
    actorId: m.memberId,
    action: 'membership.cancelled_renewal',
    entityType: 'Membership',
    entityId: m.id,
    metadata: { reason: reason ?? null, paidUntilKept: m.paidUntil?.toISOString() ?? null },
  });
}

export async function getMyPreferences(ctx: CoreContext, memberAccountId: string) {
  const members = await ctx.prisma.member.findMany({
    where: { memberAccountId },
    include: {
      organization: { select: { displayName: true } },
      consents: { where: { channel: 'WHATSAPP', scope: WHATSAPP_SERVICE_SCOPE } },
    },
  });
  return members.map((m) => ({
    memberId: m.id,
    creator: m.organization.displayName,
    phone: m.phoneE164,
    emailReminders: m.emailReminders,
    whatsappOptIn: m.consents[0]?.status === 'GRANTED',
    consentWording: WHATSAPP_CONSENT_VERSIONS[CURRENT_WHATSAPP_CONSENT_VERSION](m.organization.displayName),
  }));
}

export async function updateMyPreferences(
  ctx: CoreContext,
  memberAccountId: string,
  memberId: string,
  p: { emailReminders: boolean; whatsappOptIn: boolean; phone?: string },
) {
  const now = ctx.now();
  const m = await ctx.prisma.member.findFirst({
    where: { id: memberId, memberAccountId },
    include: { organization: true },
  });
  if (!m) throw new NotFoundError('Member');
  await ctx.prisma.$transaction(async (tx) => {
    const phoneChanged = !!p.phone && p.phone !== m.phoneE164;
    await tx.member.update({
      where: { id: m.id },
      data: { emailReminders: p.emailReminders, ...(p.phone ? { phoneE164: p.phone } : {}) },
    });
    const phone = p.phone ?? m.phoneE164;
    const existing = await tx.notificationConsent.findUnique({
      where: { memberId_channel_scope: { memberId: m.id, channel: 'WHATSAPP', scope: WHATSAPP_SERVICE_SCOPE } },
    });
    if (p.whatsappOptIn && (existing?.status !== 'GRANTED' || phoneChanged)) {
      const data = {
        status: 'GRANTED' as const,
        phoneE164: phone,
        wordingVersion: CURRENT_WHATSAPP_CONSENT_VERSION,
        wordingText: WHATSAPP_CONSENT_VERSIONS[CURRENT_WHATSAPP_CONSENT_VERSION](m.organization.displayName),
        source: 'member_portal',
        grantedAt: now,
        withdrawnAt: null,
        withdrawSource: null,
      };
      if (existing) await tx.notificationConsent.update({ where: { id: existing.id }, data });
      else
        await tx.notificationConsent.create({
          data: { ...data, organizationId: m.organizationId, memberId: m.id, channel: 'WHATSAPP', scope: WHATSAPP_SERVICE_SCOPE },
        });
    }
    if (!p.whatsappOptIn && existing?.status === 'GRANTED') {
      await tx.notificationConsent.update({
        where: { id: existing.id },
        data: { status: 'WITHDRAWN', withdrawnAt: now, withdrawSource: 'member_portal' },
      });
      await tx.notification.updateMany({
        where: { memberId: m.id, channel: 'WHATSAPP', status: { in: ['SCHEDULED', 'QUEUED'] } },
        data: { status: 'SUPPRESSED', suppressedReason: 'member opted out of WhatsApp' },
      });
    }
    await audit(tx, {
      organizationId: m.organizationId,
      actorType: 'MEMBER',
      actorId: m.id,
      action: 'member.preferences_updated',
      entityType: 'Member',
      entityId: m.id,
      metadata: { emailReminders: p.emailReminders, whatsappOptIn: p.whatsappOptIn, phoneChanged },
    });
  });
}
