import {
  claimDueNotifications,
  CoreContext,
  deliverNotification,
  evaluateExpiries,
  findUnprocessedEvents,
  flagStuckSends,
  JOBS,
  processProviderEvent,
  reconcilePendingOrders,
  scheduleCreatorDigests,
  scheduleReminders,
} from '@communitypass/core';

export interface Enqueue {
  delivery(ids: string[], delayMs?: number): Promise<void>;
  providerEvent(id: string): Promise<void>;
}

/**
 * Maintenance job handlers. Each is idempotent and safe to run concurrently with the API:
 * correctness is enforced by Postgres locks and unique constraints, not by job scheduling.
 */
export function maintenanceHandlers(ctx: CoreContext, enqueue: Enqueue): Record<string, () => Promise<unknown>> {
  return {
    [JOBS.dispatchDue]: async () => {
      const ids = await claimDueNotifications(ctx);
      await enqueue.delivery(ids);
      return { dispatched: ids.length };
    },
    [JOBS.scheduleReminders]: () => scheduleReminders(ctx),
    [JOBS.evaluateExpiries]: () => evaluateExpiries(ctx),
    [JOBS.reconcilePayments]: () => reconcilePendingOrders(ctx),
    [JOBS.creatorDigest]: () => scheduleCreatorDigests(ctx),
    [JOBS.sweepEvents]: async () => {
      const events = await findUnprocessedEvents(ctx);
      for (const e of events) await enqueue.providerEvent(e.id);
      return { requeued: events.length };
    },
    [JOBS.flagStuckSends]: async () => ({ flagged: await flagStuckSends(ctx) }),
  };
}

export async function handleDelivery(ctx: CoreContext, enqueue: Enqueue, notificationId: string) {
  const r = await deliverNotification(ctx, notificationId);
  if (r.result === 'retry') {
    // Core records the attempt and decides the bounded backoff; schedule the next try.
    await enqueue.delivery([notificationId], r.delayMs);
  }
  return r;
}

export async function handleProviderEvent(ctx: CoreContext, eventId: string) {
  return processProviderEvent(ctx, eventId);
}
