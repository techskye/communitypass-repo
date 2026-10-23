import { Queue, Worker } from 'bullmq';
import { createCoreContext, JOBS, markNotificationFailed, QUEUES } from '@communitypass/core';
import { Enqueue, handleDelivery, handleProviderEvent, maintenanceHandlers } from './jobs';

/** Repeating maintenance schedule (BullMQ job schedulers). Times for the digest are Lagos-local. */
const SCHEDULES: { id: string; job: string; every?: number; pattern?: string; tz?: string }[] = [
  { id: 'dispatch', job: JOBS.dispatchDue, every: 30_000 },
  { id: 'reminders', job: JOBS.scheduleReminders, every: 10 * 60_000 },
  { id: 'expiries', job: JOBS.evaluateExpiries, every: 5 * 60_000 },
  { id: 'reconcile', job: JOBS.reconcilePayments, every: 5 * 60_000 },
  { id: 'sweep-events', job: JOBS.sweepEvents, every: 60_000 },
  { id: 'stuck-sends', job: JOBS.flagStuckSends, every: 5 * 60_000 },
  { id: 'subscription-billing', job: JOBS.subscriptionBilling, every: 15 * 60_000 },
  { id: 'digest', job: JOBS.creatorDigest, pattern: '0 7 * * *', tz: 'Africa/Lagos' },
];

async function main() {
  const ctx = createCoreContext({ name: 'worker' });
  const connection = { url: ctx.config.redisUrl, maxRetriesPerRequest: null };
  const notificationsQ = new Queue(QUEUES.notifications, { connection });
  const eventsQ = new Queue(QUEUES.providerEvents, { connection });
  const maintenanceQ = new Queue(QUEUES.maintenance, { connection });

  const enqueue: Enqueue = {
    async delivery(ids, delayMs) {
      if (!ids.length) return;
      await notificationsQ.addBulk(
        ids.map((id) => ({
          name: JOBS.deliverNotification,
          data: { notificationId: id },
          opts: {
            delay: delayMs,
            // Infrastructure failures (DB/Redis down) retry with exponential backoff, bounded.
            attempts: 5,
            backoff: { type: 'exponential', delay: 15_000 },
            removeOnComplete: { age: 24 * 3600, count: 5000 },
            removeOnFail: false, // keep for dead-letter visibility in the admin console
          },
        })),
      );
    },
    async providerEvent(id) {
      await eventsQ.add(JOBS.processProviderEvent, { eventId: id }, {
        jobId: `ev-${id}`,
        attempts: 8,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: { age: 24 * 3600 },
        removeOnFail: false,
      });
    },
  };

  for (const s of SCHEDULES) {
    await maintenanceQ.upsertJobScheduler(
      s.id,
      s.every ? { every: s.every } : { pattern: s.pattern!, tz: s.tz },
      { name: s.job, opts: { removeOnComplete: { count: 100 }, removeOnFail: { count: 500 } } },
    );
  }

  const handlers = maintenanceHandlers(ctx, enqueue);

  const workers = [
    new Worker(
      QUEUES.notifications,
      async (job) => handleDelivery(ctx, enqueue, job.data.notificationId),
      {
        connection,
        concurrency: 5,
        // Conservative platform-wide send rate (WhatsApp Cloud API throughput limits apply).
        limiter: { max: ctx.config.whatsapp.sendsPerSecond, duration: 1000 },
      },
    ),
    new Worker(QUEUES.providerEvents, async (job) => handleProviderEvent(ctx, job.data.eventId), { connection, concurrency: 4 }),
    new Worker(
      QUEUES.maintenance,
      async (job) => {
        const h = handlers[job.name];
        if (!h) throw new Error(`Unknown maintenance job ${job.name}`);
        return h();
      },
      { connection, concurrency: 1 },
    ),
  ];

  workers[0].on('failed', async (job, err) => {
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      await markNotificationFailed(ctx, job.data.notificationId, `Dead-lettered: ${err.message}`).catch(() => undefined);
    }
  });
  for (const w of workers) {
    w.on('failed', (job, err) => ctx.logger.warn({ queue: w.name, job: job?.name, id: job?.id, err: err.message }, 'job failed'));
    w.on('error', (err) => ctx.logger.error({ queue: w.name, err: err.message }, 'worker error'));
  }

  // Heartbeat for the admin integration-health page.
  const beat = async () => {
    await ctx.prisma.integrationStatus
      .upsert({
        where: { id: 'worker' },
        create: { id: 'worker', mode: ctx.config.appMode, enabled: true, configured: true, lastOkAt: ctx.now() },
        update: { mode: ctx.config.appMode, lastOkAt: ctx.now() },
      })
      .catch((e) => ctx.logger.warn({ err: (e as Error).message }, 'heartbeat failed'));
  };
  await beat();
  const hb = setInterval(beat, 60_000);

  ctx.logger.info({ appMode: ctx.config.appMode, schedules: SCHEDULES.map((s) => s.id) }, 'CommunityPass worker started');
  if (ctx.config.appMode === 'demo') ctx.logger.warn('DEMO MODE: mock providers — nothing is really sent.');

  const shutdown = async () => {
    clearInterval(hb);
    await Promise.all(workers.map((w) => w.close()));
    await Promise.all([notificationsQ.close(), eventsQ.close(), maintenanceQ.close()]);
    await ctx.prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => {
  console.error('Worker failed to start:', e instanceof Error ? e.message : e);
  process.exit(1);
});
