import type { AccessTaskReason, AccessTaskType, Membership } from '@prisma/client';
import { getEntitlement, hasAccessEntitlement } from '@communitypass/shared';
import type { CoreContext } from '../context';
import { audit, DomainError, NotFoundError, Tx } from '../infra';

/**
 * Locks a membership row for the duration of the transaction. Every write to a membership's
 * paid time, access status or access tasks happens under this lock, which serializes
 * concurrent renewals, webhook/callback races, expiry evaluation and creator actions.
 */
export async function lockMembership(tx: Tx, membershipId: string): Promise<Membership> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM memberships WHERE id = ${membershipId} FOR UPDATE`;
  if (!rows.length) throw new NotFoundError('Membership');
  return tx.membership.findUniqueOrThrow({ where: { id: membershipId } });
}

export async function openTaskIfAbsent(
  tx: Tx,
  m: Membership,
  type: AccessTaskType,
  reason: AccessTaskReason,
  reasonDetail?: string,
): Promise<string | null> {
  // Safe check-then-insert: callers hold the membership lock; the partial unique index
  // (one OPEN task per type per membership) is the final backstop.
  const existing = await tx.accessTask.findFirst({
    where: { membershipId: m.id, type, status: 'OPEN' },
    select: { id: true },
  });
  if (existing) return null;
  const t = await tx.accessTask.create({
    data: {
      organizationId: m.organizationId,
      communityId: m.communityId,
      membershipId: m.id,
      memberId: m.memberId,
      type,
      reason,
      reasonDetail,
    },
  });
  await audit(tx, {
    organizationId: m.organizationId,
    actorType: 'SYSTEM',
    action: 'access_task.created',
    entityType: 'AccessTask',
    entityId: t.id,
    metadata: { type, reason, membershipId: m.id },
  });
  return t.id;
}

export async function cancelOpenTasks(
  tx: Tx,
  m: Membership,
  type: AccessTaskType,
  reason: string,
): Promise<number> {
  const open = await tx.accessTask.findMany({
    where: { membershipId: m.id, type, status: 'OPEN' },
    select: { id: true },
  });
  for (const t of open) {
    await tx.accessTask.update({
      where: { id: t.id },
      data: { status: 'CANCELLED', cancelledReason: reason },
    });
    await audit(tx, {
      organizationId: m.organizationId,
      actorType: 'SYSTEM',
      action: 'access_task.cancelled',
      entityType: 'AccessTask',
      entityId: t.id,
      metadata: { reason },
    });
  }
  return open.length;
}

async function setAccessStatus(tx: Tx, m: Membership, status: Membership['accessStatus'], now: Date) {
  if (m.accessStatus === status) return;
  await tx.membership.update({
    where: { id: m.id },
    data: { accessStatus: status, accessStatusUpdatedAt: now },
  });
  m.accessStatus = status;
}

/**
 * Applies the access consequences of a membership that has just become (or remains) paid:
 * - pending removal -> cancel stale removal task, back to granted (they are still in the group)
 * - removed / never granted -> create a grant task
 * - granted / pending grant -> nothing to do
 */
export async function onMembershipPaid(tx: Tx, m: Membership, now: Date): Promise<{ grantTaskId: string | null }> {
  switch (m.accessStatus) {
    case 'PENDING_REMOVAL': {
      await cancelOpenTasks(tx, m, 'REMOVE', 'Member renewed before removal — do not remove');
      await setAccessStatus(tx, m, 'GRANTED', now);
      return { grantTaskId: null };
    }
    case 'REMOVED':
    case 'NOT_GRANTED': {
      const reason = m.accessStatus === 'REMOVED' ? 'RENEWED_AFTER_REMOVAL' : 'NEW_PAID_MEMBER';
      const id = await openTaskIfAbsent(tx, m, 'GRANT', reason);
      await setAccessStatus(tx, m, 'PENDING_GRANT', now);
      return { grantTaskId: id };
    }
    default:
      return { grantTaskId: null };
  }
}

/**
 * Expiry evaluation for one membership (locked). Creates removal tasks only when the
 * member is fully expired (grace period over), never for active or grace members.
 */
export async function evaluateMembershipExpiry(
  tx: Tx,
  membershipId: string,
  now: Date,
): Promise<'remove_task' | 'grant_cancelled' | 'none'> {
  const m = await lockMembership(tx, membershipId);
  const community = await tx.community.findUniqueOrThrow({ where: { id: m.communityId } });
  const ent = getEntitlement(m.paidUntil, community.gracePeriodDays, now);
  if (ent !== 'expired') return 'none';
  if (m.accessStatus === 'GRANTED') {
    if (
      m.removalDismissedForPaidUntil &&
      m.paidUntil &&
      m.removalDismissedForPaidUntil.getTime() === m.paidUntil.getTime()
    ) {
      return 'none';
    }
    await openTaskIfAbsent(tx, m, 'REMOVE', 'MEMBERSHIP_EXPIRED');
    await setAccessStatus(tx, m, 'PENDING_REMOVAL', now);
    return 'remove_task';
  }
  if (m.accessStatus === 'PENDING_GRANT') {
    await cancelOpenTasks(tx, m, 'GRANT', 'Membership expired before access was granted');
    await setAccessStatus(tx, m, 'NOT_GRANTED', now);
    return 'grant_cancelled';
  }
  return 'none';
}

export async function evaluateExpiries(ctx: CoreContext, limit = 500) {
  const now = ctx.now();
  // Candidates: paid time is over and creator-confirmed access exists or is pending.
  const candidates = await ctx.prisma.membership.findMany({
    where: { paidUntil: { lte: now }, accessStatus: { in: ['GRANTED', 'PENDING_GRANT'] } },
    select: { id: true },
    take: limit,
    orderBy: { paidUntil: 'asc' },
  });
  const result = { checked: candidates.length, removeTasks: 0, grantsCancelled: 0 };
  for (const c of candidates) {
    const r = await ctx.prisma.$transaction((tx) => evaluateMembershipExpiry(tx, c.id, now), {
      timeout: 15000,
    });
    if (r === 'remove_task') result.removeTasks++;
    if (r === 'grant_cancelled') result.grantsCancelled++;
  }
  return result;
}

// ─────────────────────────── Creator task actions ───────────────────────────

interface TaskActor {
  organizationId: string;
  userId: string;
}

async function loadTaskForOrg(tx: Tx, actor: TaskActor, taskId: string) {
  const task = await tx.accessTask.findFirst({
    where: { id: taskId, organizationId: actor.organizationId },
  });
  if (!task) throw new NotFoundError('Task');
  return task;
}

export type CompleteTaskResult =
  | { outcome: 'completed' }
  | { outcome: 'cancelled_member_renewed' };

export async function completeTask(
  ctx: CoreContext,
  actor: TaskActor,
  taskId: string,
  note?: string,
): Promise<CompleteTaskResult> {
  const now = ctx.now();
  return ctx.prisma.$transaction(async (tx) => {
    const pre = await loadTaskForOrg(tx, actor, taskId);
    const m = await lockMembership(tx, pre.membershipId);
    const task = await tx.accessTask.findUniqueOrThrow({ where: { id: taskId } });
    if (task.status !== 'OPEN') throw new DomainError('TASK_NOT_OPEN', 'This task is no longer open', 409);
    const community = await tx.community.findUniqueOrThrow({ where: { id: m.communityId } });
    const ent = getEntitlement(m.paidUntil, community.gracePeriodDays, now);

    if (note) {
      await tx.accessTaskNote.create({ data: { taskId, authorUserId: actor.userId, body: note } });
    }

    if (task.type === 'REMOVE' && hasAccessEntitlement(ent)) {
      // Re-check before removal: the member has since renewed (or is within grace). Never remove.
      await tx.accessTask.update({
        where: { id: taskId },
        data: { status: 'CANCELLED', cancelledReason: 'Member is paid up — do not remove' },
      });
      await setAccessStatus(tx, m, 'GRANTED', now);
      await audit(tx, {
        organizationId: actor.organizationId,
        actorType: 'USER',
        actorId: actor.userId,
        action: 'access_task.removal_blocked_member_paid',
        entityType: 'AccessTask',
        entityId: taskId,
      });
      return { outcome: 'cancelled_member_renewed' as const };
    }

    if (task.type === 'GRANT' && !hasAccessEntitlement(ent)) {
      throw new DomainError(
        'MEMBERSHIP_NOT_PAID',
        'This membership is no longer paid. Dismiss the task instead of granting access.',
        409,
      );
    }

    await tx.accessTask.update({
      where: { id: taskId },
      data: { status: 'COMPLETED', completedAt: now, completedByUserId: actor.userId },
    });
    if (task.type === 'GRANT') await setAccessStatus(tx, m, 'GRANTED', now);
    if (task.type === 'REMOVE') await setAccessStatus(tx, m, 'REMOVED', now);
    await audit(tx, {
      organizationId: actor.organizationId,
      actorType: 'USER',
      actorId: actor.userId,
      action: `access_task.completed`,
      entityType: 'AccessTask',
      entityId: taskId,
      metadata: { type: task.type, creatorConfirmed: true },
    });
    return { outcome: 'completed' as const };
  }, { timeout: 15000 });
}

export async function dismissTask(ctx: CoreContext, actor: TaskActor, taskId: string, reason: string) {
  const now = ctx.now();
  return ctx.prisma.$transaction(async (tx) => {
    const pre = await loadTaskForOrg(tx, actor, taskId);
    const m = await lockMembership(tx, pre.membershipId);
    const task = await tx.accessTask.findUniqueOrThrow({ where: { id: taskId } });
    if (task.status !== 'OPEN') throw new DomainError('TASK_NOT_OPEN', 'This task is no longer open', 409);
    await tx.accessTask.update({
      where: { id: taskId },
      data: { status: 'DISMISSED', dismissedReason: reason, completedByUserId: actor.userId, completedAt: now },
    });
    if (task.type === 'GRANT') await setAccessStatus(tx, m, 'NOT_GRANTED', now);
    if (task.type === 'REMOVE') {
      // Creator chose to keep this expired member; do not recreate removal for this paid period.
      await tx.membership.update({
        where: { id: m.id },
        data: { removalDismissedForPaidUntil: m.paidUntil },
      });
      await setAccessStatus(tx, m, 'GRANTED', now);
    }
    await audit(tx, {
      organizationId: actor.organizationId,
      actorType: 'USER',
      actorId: actor.userId,
      action: 'access_task.dismissed',
      entityType: 'AccessTask',
      entityId: taskId,
      metadata: { type: task.type, reason },
    });
  }, { timeout: 15000 });
}

export async function reopenTask(ctx: CoreContext, actor: TaskActor, taskId: string) {
  const now = ctx.now();
  return ctx.prisma.$transaction(async (tx) => {
    const pre = await loadTaskForOrg(tx, actor, taskId);
    const m = await lockMembership(tx, pre.membershipId);
    const task = await tx.accessTask.findUniqueOrThrow({ where: { id: taskId } });
    if (task.status === 'OPEN') throw new DomainError('TASK_ALREADY_OPEN', 'Task is already open', 409);
    const otherOpen = await tx.accessTask.findFirst({
      where: { membershipId: m.id, status: 'OPEN', type: { in: task.type === 'REVIEW' ? ['REVIEW'] : ['GRANT', 'REMOVE'] } },
    });
    if (otherOpen) {
      throw new DomainError('CONFLICTING_TASK', 'Another open task exists for this membership', 409);
    }
    const community = await tx.community.findUniqueOrThrow({ where: { id: m.communityId } });
    const ent = getEntitlement(m.paidUntil, community.gracePeriodDays, now);
    if (task.type === 'GRANT') {
      if (!hasAccessEntitlement(ent)) {
        throw new DomainError('MEMBERSHIP_NOT_PAID', 'Membership is not paid; cannot reopen a grant task', 409);
      }
      await setAccessStatus(tx, m, 'PENDING_GRANT', now);
    }
    if (task.type === 'REMOVE') {
      if (ent !== 'expired') {
        throw new DomainError('MEMBERSHIP_PAID', 'Member is paid up; removal is not appropriate', 409);
      }
      await tx.membership.update({ where: { id: m.id }, data: { removalDismissedForPaidUntil: null } });
      await setAccessStatus(tx, m, 'PENDING_REMOVAL', now);
    }
    await tx.accessTask.update({
      where: { id: taskId },
      data: {
        status: 'OPEN',
        completedAt: null,
        completedByUserId: null,
        dismissedReason: null,
        cancelledReason: null,
      },
    });
    await audit(tx, {
      organizationId: actor.organizationId,
      actorType: 'USER',
      actorId: actor.userId,
      action: 'access_task.reopened',
      entityType: 'AccessTask',
      entityId: taskId,
    });
  }, { timeout: 15000 });
}

export async function addTaskNote(ctx: CoreContext, actor: TaskActor, taskId: string, body: string) {
  const task = await ctx.prisma.accessTask.findFirst({
    where: { id: taskId, organizationId: actor.organizationId },
  });
  if (!task) throw new NotFoundError('Task');
  return ctx.prisma.accessTaskNote.create({ data: { taskId, authorUserId: actor.userId, body } });
}
