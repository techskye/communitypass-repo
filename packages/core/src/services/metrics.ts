import { DAY_MS } from '@communitypass/shared';
import type { CoreContext } from '../context';

/**
 * Dashboard metrics — all derived from the database. "Collections" are provider-confirmed
 * successful charges; this is NOT a settled balance (settlement data is not integrated).
 */
export async function getOrgMetrics(ctx: CoreContext, organizationId: string) {
  const now = ctx.now();
  const since30 = new Date(now.getTime() - 30 * DAY_MS);
  const collectedStatuses = ['SUCCESS', 'REFUND_PENDING', 'REFUNDED', 'PARTIALLY_REFUNDED', 'DISPUTED'] as const;

  const [allTime, last30, refunds, held, entitlement, tasks, failures] = await Promise.all([
    ctx.prisma.payment.aggregate({
      where: { organizationId, status: { in: [...collectedStatuses] } },
      _sum: { amountKobo: true },
      _count: true,
    }),
    ctx.prisma.payment.aggregate({
      where: { organizationId, status: { in: [...collectedStatuses] }, paidAt: { gte: since30 } },
      _sum: { amountKobo: true },
      _count: true,
    }),
    ctx.prisma.payment.aggregate({
      where: { organizationId, refundedAmountKobo: { gt: 0 } },
      _sum: { refundedAmountKobo: true },
      _count: true,
    }),
    ctx.prisma.payment.count({ where: { organizationId, status: 'HELD_FOR_REVIEW' } }),
    ctx.prisma.$queryRaw<{ active: bigint; expiring: bigint; grace: bigint; expired: bigint }[]>`
      SELECT
        COUNT(*) FILTER (WHERE m."paidUntil" > ${now}) AS active,
        COUNT(*) FILTER (WHERE m."paidUntil" > ${now} AND m."paidUntil" <= ${new Date(now.getTime() + 7 * DAY_MS)}) AS expiring,
        COUNT(*) FILTER (WHERE m."paidUntil" <= ${now} AND m."paidUntil" + (c."gracePeriodDays" * INTERVAL '1 day') > ${now}) AS grace,
        COUNT(*) FILTER (WHERE m."paidUntil" + (c."gracePeriodDays" * INTERVAL '1 day') <= ${now}) AS expired
      FROM memberships m JOIN communities c ON c.id = m."communityId"
      WHERE m."organizationId" = ${organizationId} AND m."paidUntil" IS NOT NULL`,
    ctx.prisma.accessTask.groupBy({
      by: ['type'],
      where: { organizationId, status: 'OPEN' },
      _count: true,
    }),
    ctx.prisma.notification.count({
      where: { organizationId, status: { in: ['FAILED', 'NEEDS_REVIEW'] }, createdAt: { gte: since30 } },
    }),
  ]);
  const e = entitlement[0];
  const taskCount = (t: string) => tasks.find((x) => x.type === t)?._count ?? 0;
  const anyLive = await ctx.prisma.payment.count({ where: { organizationId, isLive: true } });
  const anyDemo = await ctx.prisma.payment.count({ where: { organizationId, provider: 'DEMO' } });
  return {
    currency: 'NGN',
    collections: {
      allTimeKobo: allTime._sum.amountKobo ?? 0,
      allTimeCount: allTime._count,
      last30DaysKobo: last30._sum.amountKobo ?? 0,
      last30DaysCount: last30._count,
      includesDemoPayments: anyDemo > 0,
      includesLivePayments: anyLive > 0,
    },
    refunds: { totalKobo: refunds._sum.refundedAmountKobo ?? 0, count: refunds._count },
    paymentsHeldForReview: held,
    memberships: {
      activePaid: Number(e?.active ?? 0),
      expiringIn7Days: Number(e?.expiring ?? 0),
      inGracePeriod: Number(e?.grace ?? 0),
      expired: Number(e?.expired ?? 0),
    },
    tasks: { pendingGrant: taskCount('GRANT'), pendingRemoval: taskCount('REMOVE'), pendingReview: taskCount('REVIEW') },
    notificationFailures30Days: failures,
  };
}
