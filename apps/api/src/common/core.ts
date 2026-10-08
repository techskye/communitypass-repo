import { Global, Inject, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { CoreContext, JOBS, QUEUES } from '@communitypass/core';

export const CORE = Symbol('CORE');
export const InjectCore = () => Inject(CORE);

/**
 * Thin producer for BullMQ. If queues are disabled (tests) or Redis is unavailable, work is
 * still durable in Postgres and the worker's sweepers pick it up.
 */
@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly queues = new Map<string, Queue>();
  readonly enabled: boolean;

  constructor(@InjectCore() private readonly core: CoreContext) {
    this.enabled = process.env.QUEUE_DISABLED !== 'true';
  }

  private queue(name: string): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: { url: this.core.config.redisUrl, maxRetriesPerRequest: 1 } });
      q.on('error', () => undefined);
      this.queues.set(name, q);
    }
    return q;
  }

  async enqueueNotifications(ids: string[]) {
    if (!this.enabled || !ids.length) return;
    await this.queue(QUEUES.notifications).addBulk(
      ids.map((id) => ({ name: JOBS.deliverNotification, data: { notificationId: id }, opts: { jobId: `n-${id}-${Date.now()}` } })),
    );
  }

  async enqueueProviderEvent(eventId: string) {
    if (!this.enabled) return;
    await this.queue(QUEUES.providerEvents).add(
      JOBS.processProviderEvent,
      { eventId },
      { jobId: `ev-${eventId}`, attempts: 8, backoff: { type: 'exponential', delay: 10_000 } },
    );
  }

  /** For the admin "failed jobs" page. */
  async failedJobs(limit = 50) {
    if (!this.enabled) return [];
    const out: { queue: string; id: string | undefined; name: string; failedReason: string; attemptsMade: number; finishedOn?: number }[] = [];
    for (const name of Object.values(QUEUES)) {
      try {
        const jobs = await this.queue(name).getFailed(0, limit - 1);
        for (const j of jobs) {
          out.push({
            queue: name,
            id: j.id,
            name: j.name,
            failedReason: (j.failedReason ?? '').slice(0, 300),
            attemptsMade: j.attemptsMade,
            finishedOn: j.finishedOn,
          });
        }
      } catch {
        out.push({ queue: name, id: undefined, name: 'redis-unavailable', failedReason: 'Could not reach Redis', attemptsMade: 0 });
      }
    }
    return out;
  }

  async retryFailed(queue: string, id: string) {
    if (!this.enabled || !Object.values(QUEUES).includes(queue as any)) return false;
    const job = await this.queue(queue).getJob(id);
    if (!job) return false;
    await job.retry('failed');
    return true;
  }

  async onModuleDestroy() {
    await Promise.all([...this.queues.values()].map((q) => q.close().catch(() => undefined)));
  }
}

export function coreModuleFor(core: CoreContext) {
  @Global()
  @Module({
    providers: [{ provide: CORE, useValue: core }, QueueService],
    exports: [CORE, QueueService],
  })
  class CoreModule {}
  return CoreModule;
}
