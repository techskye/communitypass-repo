import type { CoreContext } from '../context';
import { audit } from '../infra';
import { verifyAndFulfill } from './fulfillment';

/**
 * Pending payment reconciliation: re-verifies pending orders server-side through the same
 * idempotent fulfillment service, and closes out orders that were never paid.
 */
export async function reconcilePendingOrders(ctx: CoreContext, opts: { limit?: number } = {}) {
  const now = ctx.now();
  const orders = await ctx.prisma.order.findMany({
    where: {
      status: 'PENDING',
      createdAt: { lt: new Date(now.getTime() - 2 * 60 * 1000) },
      OR: [{ lastVerifiedAt: null }, { lastVerifiedAt: { lt: new Date(now.getTime() - 5 * 60 * 1000) } }],
    },
    orderBy: { createdAt: 'asc' },
    take: opts.limit ?? 100,
  });
  const summary = { checked: 0, fulfilled: 0, failed: 0, abandoned: 0, held: 0, errors: 0 };
  for (const o of orders) {
    summary.checked++;
    try {
      const r = await verifyAndFulfill(ctx, o.reference, 'RECONCILIATION');
      if (r.outcome === 'fulfilled') summary.fulfilled++;
      else if (r.outcome === 'held_for_review') summary.held++;
      else if (r.outcome === 'not_successful') {
        const fresh = await ctx.prisma.order.findUniqueOrThrow({ where: { id: o.id } });
        if (fresh.status === 'FAILED') summary.failed++;
        else if (now.getTime() - o.createdAt.getTime() > 24 * 3600 * 1000) {
          await ctx.prisma.order.updateMany({
            where: { id: o.id, status: 'PENDING' },
            data: { status: 'ABANDONED', failureReason: `Not paid within 24h (${r.providerStatus})` },
          });
          await audit(ctx.prisma, {
            organizationId: o.organizationId,
            actorType: 'SYSTEM',
            action: 'order.abandoned',
            entityType: 'Order',
            entityId: o.id,
          });
          summary.abandoned++;
        }
      } else if (r.outcome === 'provider_unavailable') {
        summary.errors++;
      }
    } catch (e) {
      summary.errors++;
      ctx.logger.warn({ reference: o.reference, err: (e as Error).message }, 'reconciliation verify failed');
      await ctx.prisma.order.update({
        where: { id: o.id },
        data: { lastVerifiedAt: now, lastVerifyStatus: 'error' },
      });
    }
  }
  return summary;
}
