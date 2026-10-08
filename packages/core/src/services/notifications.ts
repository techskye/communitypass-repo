import type {
  Notification,
  NotificationChannel,
  NotificationType,
  Prisma,
  ReminderSettings,
} from '@prisma/client';
import {
  DAY_MS,
  DEFAULT_REMINDER_SETTINGS,
  WHATSAPP_OPT_OUT_KEYWORDS,
  adjustToSendingWindow,
  getEntitlement,
  graceEndsAt,
  isWithinSendingWindow,
  notificationDedupeKey,
  planReminders,
} from '@communitypass/shared';
import type { CoreContext } from '../context';
import { audit, Db, Tx } from '../infra';
import { buildDigestEmail, buildMemberMessage } from '../messages';
import type { SendOutcome } from '../adapters/messaging';

export const WHATSAPP_SERVICE_SCOPE = 'membership_service';
export const MAX_SEND_ATTEMPTS = 5;
const REMINDER_TYPES: NotificationType[] = ['RENEWAL_REMINDER', 'EXPIRY_NOTICE', 'GRACE_ENDED'];

type SettingsLike = Pick<
  ReminderSettings,
  | 'beforeExpiryDays'
  | 'onExpiry'
  | 'graceEnd'
  | 'sendWindowStartHour'
  | 'sendWindowEndHour'
  | 'maxMessagesPerMemberPerDay'
  | 'creatorDigestEnabled'
  | 'whatsappEnabled'
  | 'emailEnabled'
>;

export async function getReminderSettings(db: Tx | Db, organizationId: string): Promise<SettingsLike> {
  const s = await db.reminderSettings.findUnique({ where: { organizationId } });
  return s ?? { ...DEFAULT_REMINDER_SETTINGS, whatsappEnabled: true, emailEnabled: true };
}

async function hasWhatsappConsent(db: Tx | Db, memberId: string): Promise<boolean> {
  const c = await db.notificationConsent.findUnique({
    where: { memberId_channel_scope: { memberId, channel: 'WHATSAPP', scope: WHATSAPP_SERVICE_SCOPE } },
  });
  return c?.status === 'GRANTED';
}

/** Channels allowed for a member right now (re-checked again immediately before delivery). */
export async function eligibleChannels(
  db: Tx | Db,
  p: { organizationId: string; memberId: string; kind: 'transactional' | 'reminder' },
): Promise<NotificationChannel[]> {
  const settings = await getReminderSettings(db, p.organizationId);
  const member = await db.member.findUniqueOrThrow({ where: { id: p.memberId } });
  const out: NotificationChannel[] = [];
  if (settings.emailEnabled && (p.kind === 'transactional' || member.emailReminders)) out.push('EMAIL');
  if (settings.whatsappEnabled && (await hasWhatsappConsent(db, p.memberId))) out.push('WHATSAPP');
  return out;
}

/**
 * Creates notifications idempotently (unique dedupe key). Returns ids of rows that exist for
 * the given keys (new or pre-existing) that are still SCHEDULED.
 */
export async function createNotifications(
  db: Tx | Db,
  rows: Prisma.NotificationCreateManyInput[],
): Promise<string[]> {
  if (!rows.length) return [];
  await db.notification.createMany({ data: rows, skipDuplicates: true });
  const created = await db.notification.findMany({
    where: { dedupeKey: { in: rows.map((r) => r.dedupeKey) }, status: 'SCHEDULED' },
    select: { id: true },
  });
  return created.map((r) => r.id);
}

/** Receipt + (when a grant task was created) access instructions, after a verified payment. */
export async function queuePaymentNotifications(
  tx: Tx,
  p: {
    organizationId: string;
    memberId: string;
    membershipId: string;
    orderId: string;
    paidUntil: Date;
    includeAccessInstructions: boolean;
    now: Date;
  },
): Promise<string[]> {
  const channels = await eligibleChannels(tx, { ...p, kind: 'transactional' });
  const rows: Prisma.NotificationCreateManyInput[] = [];
  const types: NotificationType[] = ['PAYMENT_RECEIPT'];
  if (p.includeAccessInstructions) types.push('ACCESS_INSTRUCTIONS');
  for (const channel of channels) {
    for (const type of types) {
      const reminderKey = type === 'PAYMENT_RECEIPT' ? 'receipt' : 'access_instructions';
      rows.push({
        organizationId: p.organizationId,
        memberId: p.memberId,
        membershipId: p.membershipId,
        orderId: p.orderId,
        channel,
        type,
        reminderKey,
        paidUntilSnapshot: p.paidUntil,
        dedupeKey: notificationDedupeKey({
          organizationId: p.organizationId,
          membershipId: p.membershipId,
          channel,
          reminderType: reminderKey,
          paidUntil: p.paidUntil,
        }),
        scheduledFor: p.now,
      });
    }
  }
  return createNotifications(tx, rows);
}

/** Suppresses scheduled reminders that refer to an old paid-until value (after renewal). */
export async function suppressStaleReminders(tx: Tx, membershipId: string, currentPaidUntil: Date) {
  const r = await tx.notification.updateMany({
    where: {
      membershipId,
      status: { in: ['SCHEDULED', 'QUEUED'] },
      type: { in: REMINDER_TYPES },
      NOT: { paidUntilSnapshot: currentPaidUntil },
    },
    data: { status: 'SUPPRESSED', suppressedReason: 'stale: membership renewed' },
  });
  return r.count;
}

/**
 * Reminder scheduling job. Idempotent: running it any number of times creates at most one
 * notification per (organization, membership, channel, reminder type, paid_until).
 */
export async function scheduleReminders(ctx: CoreContext, opts: { lookaheadHours?: number } = {}) {
  const now = ctx.now();
  const lookahead = now.getTime() + (opts.lookaheadHours ?? 36) * 3600 * 1000;
  const memberships = await ctx.prisma.membership.findMany({
    where: {
      paidUntil: { gt: new Date(now.getTime() - 15 * DAY_MS), lt: new Date(now.getTime() + 31 * DAY_MS) },
    },
    include: { community: true, organization: true },
  });
  let created = 0;
  for (const m of memberships) {
    if (!m.paidUntil || !m.lastPaymentAt) continue;
    const settings = await getReminderSettings(ctx.prisma, m.organizationId);
    const planned = planReminders({
      paidUntil: m.paidUntil,
      purchasedAt: m.lastPaymentAt,
      gracePeriodDays: m.community.gracePeriodDays,
      settings,
      timeZone: m.organization.timezone,
    });
    const channels = await eligibleChannels(ctx.prisma, {
      organizationId: m.organizationId,
      memberId: m.memberId,
      kind: 'reminder',
    });
    const rows: Prisma.NotificationCreateManyInput[] = [];
    for (const r of planned) {
      if (r.dueAt.getTime() > lookahead) continue;
      // Don't send reminders that are badly out of date (e.g. after a long outage).
      if (now.getTime() - r.dueAt.getTime() > DAY_MS) continue;
      if (r.kind === 'RENEWAL_REMINDER' && m.cancelledAt) continue;
      for (const channel of channels) {
        rows.push({
          organizationId: m.organizationId,
          memberId: m.memberId,
          membershipId: m.id,
          channel,
          type: r.kind,
          reminderKey: r.key,
          paidUntilSnapshot: m.paidUntil,
          dedupeKey: notificationDedupeKey({
            organizationId: m.organizationId,
            membershipId: m.id,
            channel,
            reminderType: r.key,
            paidUntil: m.paidUntil,
          }),
          scheduledFor: r.dueAt,
        });
      }
    }
    if (rows.length) {
      const res = await ctx.prisma.notification.createMany({ data: rows, skipDuplicates: true });
      created += res.count;
    }
  }
  return { membershipsScanned: memberships.length, created };
}

/** Moves due notifications to QUEUED and returns their ids (for the delivery queue). */
export async function claimDueNotifications(ctx: CoreContext, limit = 200): Promise<string[]> {
  const now = ctx.now();
  const due = await ctx.prisma.notification.findMany({
    where: { status: 'SCHEDULED', scheduledFor: { lte: now } },
    select: { id: true },
    orderBy: { scheduledFor: 'asc' },
    take: limit,
  });
  if (!due.length) return [];
  await ctx.prisma.notification.updateMany({
    where: { id: { in: due.map((d) => d.id) }, status: 'SCHEDULED' },
    data: { status: 'QUEUED' },
  });
  return due.map((d) => d.id);
}

/** Notifications stuck mid-send (worker crash) have an unknown outcome: flag, never resend. */
export async function flagStuckSends(ctx: CoreContext, olderThanMinutes = 10) {
  const cutoff = new Date(ctx.now().getTime() - olderThanMinutes * 60 * 1000);
  const r = await ctx.prisma.notification.updateMany({
    where: { status: 'SENDING', updatedAt: { lt: cutoff } },
    data: { status: 'NEEDS_REVIEW', lastError: 'Send outcome unknown (worker interrupted). Not resent automatically.' },
  });
  // QUEUED rows whose queue job was lost (e.g. Redis restart) were never attempted: safe to reschedule.
  const lostCutoff = new Date(ctx.now().getTime() - 60 * 60 * 1000);
  await ctx.prisma.notification.updateMany({
    where: { status: 'QUEUED', updatedAt: { lt: lostCutoff } },
    data: { status: 'SCHEDULED' },
  });
  return r.count;
}

export type DeliveryResult =
  | { result: 'sent'; providerMessageId: string | null }
  | { result: 'suppressed'; reason: string }
  | { result: 'rescheduled'; until: Date; reason: string }
  | { result: 'retry'; delayMs: number; error: string }
  | { result: 'failed'; error: string }
  | { result: 'needs_review'; error: string }
  | { result: 'skipped'; reason: string };

async function suppress(db: Db, id: string, reason: string): Promise<DeliveryResult> {
  await db.notification.update({
    where: { id },
    data: { status: 'SUPPRESSED', suppressedReason: reason },
  });
  return { result: 'suppressed', reason };
}

async function reschedule(db: Db, id: string, until: Date, reason: string): Promise<DeliveryResult> {
  await db.notification.update({
    where: { id },
    data: { status: 'SCHEDULED', scheduledFor: until, attemptCount: { decrement: 1 } },
  });
  return { result: 'rescheduled', until, reason };
}

/**
 * Delivers one notification. Re-checks membership state, consent, preferences, templates,
 * sending window and daily limits immediately before sending. Records every attempt.
 */
export async function deliverNotification(ctx: CoreContext, notificationId: string): Promise<DeliveryResult> {
  const db = ctx.prisma;
  const now = ctx.now();

  // Atomic claim: only one worker may send a given notification.
  const claimed = await db.notification.updateMany({
    where: { id: notificationId, status: { in: ['SCHEDULED', 'QUEUED'] }, scheduledFor: { lte: now } },
    data: { status: 'SENDING', attemptCount: { increment: 1 } },
  });
  if (claimed.count === 0) return { result: 'skipped', reason: 'not claimable' };
  const n = await db.notification.findUniqueOrThrow({ where: { id: notificationId } });

  // An earlier attempt whose outcome is unknown must not be blindly repeated.
  const unknown = await db.notificationAttempt.findFirst({
    where: { notificationId, outcome: { in: ['IN_FLIGHT', 'AMBIGUOUS'] } },
  });
  if (unknown) {
    await db.notification.update({
      where: { id: n.id },
      data: { status: 'NEEDS_REVIEW', lastError: 'Previous attempt outcome unknown' },
    });
    return { result: 'needs_review', error: 'Previous attempt outcome unknown' };
  }

  if (n.type === 'CREATOR_DIGEST') return deliverDigest(ctx, n);

  const org = await db.organization.findUniqueOrThrow({ where: { id: n.organizationId } });
  const settings = await getReminderSettings(db, n.organizationId);
  if (!n.memberId || !n.membershipId) return suppress(db, n.id, 'missing recipient');
  const member = await db.member.findUniqueOrThrow({ where: { id: n.memberId } });
  const membership = await db.membership.findUniqueOrThrow({
    where: { id: n.membershipId },
    include: { community: true },
  });

  // ── State re-checks ──
  const isReminder = REMINDER_TYPES.includes(n.type);
  if (isReminder) {
    if (!membership.paidUntil || !n.paidUntilSnapshot || membership.paidUntil.getTime() !== n.paidUntilSnapshot.getTime()) {
      return suppress(db, n.id, 'stale: membership renewed or changed');
    }
    const ent = getEntitlement(membership.paidUntil, membership.community.gracePeriodDays, now);
    if (n.type === 'RENEWAL_REMINDER' && (ent !== 'active' || membership.cancelledAt)) {
      return suppress(db, n.id, membership.cancelledAt ? 'member cancelled renewal' : 'no longer active');
    }
    if (n.type === 'EXPIRY_NOTICE' && ent === 'active') return suppress(db, n.id, 'stale: membership active');
    if (n.type === 'GRACE_ENDED' && ent !== 'expired') return suppress(db, n.id, 'stale: not expired');
  }

  // ── Channel/preference/consent re-checks ──
  if (n.channel === 'EMAIL') {
    if (!settings.emailEnabled) return suppress(db, n.id, 'email disabled by creator');
    if (isReminder && !member.emailReminders) return suppress(db, n.id, 'member turned off email reminders');
  } else {
    if (!settings.whatsappEnabled) return suppress(db, n.id, 'whatsapp disabled by creator');
    if (!(await hasWhatsappConsent(db, member.id))) return suppress(db, n.id, 'no whatsapp consent (opted out)');
    if (ctx.adapters.whatsapp.kind === 'disabled') return suppress(db, n.id, 'whatsapp integration disabled');
  }

  // ── Sending window and per-member daily cap (reminders only; receipts go immediately) ──
  if (isReminder) {
    if (!isWithinSendingWindow(now, settings.sendWindowStartHour, settings.sendWindowEndHour, org.timezone)) {
      const next = adjustToSendingWindow(now, settings.sendWindowStartHour, settings.sendWindowEndHour, org.timezone);
      return reschedule(db, n.id, next, 'outside sending window');
    }
    const sentToday = await db.notification.count({
      where: {
        memberId: member.id,
        channel: n.channel,
        type: { in: REMINDER_TYPES },
        status: { in: ['ACCEPTED', 'SENT', 'DELIVERED', 'READ'] },
        sentAt: { gte: new Date(now.getTime() - DAY_MS) },
      },
    });
    if (sentToday >= settings.maxMessagesPerMemberPerDay) {
      return reschedule(db, n.id, new Date(now.getTime() + 6 * 3600 * 1000), 'daily limit reached');
    }
  }

  const msg = buildMemberMessage(n.type as Exclude<NotificationType, 'CREATOR_DIGEST'>, {
    memberName: member.fullName.split(' ')[0] || member.fullName,
    creatorName: org.displayName,
    communityName: membership.community.name,
    amountKobo: n.orderId
      ? (await db.order.findUnique({ where: { id: n.orderId }, select: { amountKobo: true } }))?.amountKobo
      : undefined,
    paidUntil: membership.paidUntil,
    graceEndsAt:
      membership.paidUntil && membership.community.gracePeriodDays > 0
        ? graceEndsAt(membership.paidUntil, membership.community.gracePeriodDays)
        : null,
    portalUrl: `${ctx.config.webBaseUrl}/member`,
    supportEmail: org.supportEmail,
    timezone: org.timezone,
  });

  let template: { name: string; language: string } | null = null;
  if (n.channel === 'WHATSAPP') {
    template = await db.whatsappTemplate.findFirst({
      where: { purpose: msg.templatePurpose, status: 'APPROVED' },
      select: { name: true, language: true },
    });
    if (!template) return suppress(db, n.id, `no approved template for ${msg.templatePurpose}`);
  }

  const attempt = await db.notificationAttempt.create({
    data: { notificationId: n.id, attemptNo: n.attemptCount, outcome: 'IN_FLIGHT' },
  });

  let outcome: SendOutcome;
  try {
    outcome =
      n.channel === 'WHATSAPP'
        ? await ctx.adapters.whatsapp.sendTemplate({
            toE164: member.phoneE164,
            templateName: template!.name,
            language: template!.language,
            bodyParams: msg.whatsappParams,
            previewText: msg.whatsappPreview,
          })
        : await ctx.adapters.email.send({
            to: member.email,
            subject: msg.email.subject,
            text: msg.email.text,
            html: msg.email.html,
            idempotencyKey: n.dedupeKey,
          });
  } catch (e) {
    outcome = { kind: 'ambiguous', code: 'exception', message: (e as Error).message.slice(0, 200), safeToRetry: false };
  }
  return recordOutcome(ctx, n, attempt.id, outcome);
}

async function recordOutcome(
  ctx: CoreContext,
  n: Notification,
  attemptId: string,
  outcome: SendOutcome,
): Promise<DeliveryResult> {
  const db = ctx.prisma;
  const now = ctx.now();
  const finish = (data: Prisma.NotificationAttemptUpdateInput) =>
    db.notificationAttempt.update({ where: { id: attemptId }, data: { ...data, finishedAt: now } });

  if (outcome.kind === 'accepted') {
    await finish({ outcome: 'ACCEPTED', providerMessageId: outcome.providerMessageId });
    await db.notification.update({
      where: { id: n.id },
      data: {
        // WhatsApp "accepted" is only acceptance; sent/delivered/read arrive via webhook.
        status: n.channel === 'WHATSAPP' ? 'ACCEPTED' : 'SENT',
        providerMessageId: outcome.providerMessageId,
        sentAt: now,
        lastError: null,
      },
    });
    return { result: 'sent', providerMessageId: outcome.providerMessageId };
  }
  const retryable = outcome.kind === 'retryable' || (outcome.kind === 'ambiguous' && outcome.safeToRetry);
  if (retryable) {
    await finish({ outcome: 'RETRYABLE_ERROR', errorCode: outcome.code, errorMessage: outcome.message });
    if (n.attemptCount >= MAX_SEND_ATTEMPTS) {
      await db.notification.update({
        where: { id: n.id },
        data: { status: 'FAILED', lastError: `Gave up after ${n.attemptCount} attempts: ${outcome.message}` },
      });
      return { result: 'failed', error: outcome.message };
    }
    const delayMs =
      (outcome.kind === 'retryable' && outcome.retryAfterMs) || Math.min(30_000 * 2 ** (n.attemptCount - 1), 30 * 60_000);
    await db.notification.update({
      where: { id: n.id },
      data: { status: 'QUEUED', lastError: outcome.message },
    });
    return { result: 'retry', delayMs, error: outcome.message };
  }
  if (outcome.kind === 'ambiguous') {
    await finish({ outcome: 'AMBIGUOUS', errorCode: outcome.code, errorMessage: outcome.message });
    await db.notification.update({
      where: { id: n.id },
      data: { status: 'NEEDS_REVIEW', lastError: `Outcome unknown: ${outcome.message}. Not resent automatically.` },
    });
    return { result: 'needs_review', error: outcome.message };
  }
  await finish({ outcome: 'PERMANENT_ERROR', errorCode: outcome.code, errorMessage: outcome.message });
  await db.notification.update({
    where: { id: n.id },
    data: { status: 'FAILED', lastError: outcome.message },
  });
  return { result: 'failed', error: outcome.message };
}

/** Marks a notification permanently failed (e.g. dead-lettered by the queue). */
export async function markNotificationFailed(ctx: CoreContext, id: string, error: string) {
  await ctx.prisma.notification.updateMany({
    where: { id, status: { in: ['QUEUED', 'SCHEDULED'] } },
    data: { status: 'FAILED', lastError: error.slice(0, 300) },
  });
}

/** Creator retries a failed / needs-review notification after checking it was not received. */
export async function retryNotification(ctx: CoreContext, organizationId: string, id: string, userId: string) {
  const n = await ctx.prisma.notification.findFirst({ where: { id, organizationId } });
  if (!n || !['FAILED', 'NEEDS_REVIEW'].includes(n.status)) return false;
  await ctx.prisma.$transaction(async (tx) => {
    await tx.notificationAttempt.updateMany({
      where: { notificationId: id, outcome: { in: ['IN_FLIGHT', 'AMBIGUOUS'] } },
      data: { outcome: 'PERMANENT_ERROR', errorMessage: 'Reviewed by creator; marked not received' },
    });
    await tx.notification.update({
      where: { id },
      data: { status: 'SCHEDULED', scheduledFor: ctx.now(), lastError: null },
    });
    await audit(tx, {
      organizationId,
      actorType: 'USER',
      actorId: userId,
      action: 'notification.retry_requested',
      entityType: 'Notification',
      entityId: id,
    });
  });
  return true;
}

// ───────────────────────── WhatsApp webhooks: statuses & opt-out ─────────────────────────

const STATUS_RANK: Record<string, number> = { ACCEPTED: 1, SENT: 2, DELIVERED: 3, READ: 4 };

export async function applyWhatsappStatus(
  ctx: CoreContext,
  s: { id: string; status: string; timestamp?: string; errors?: { code?: number; title?: string }[] },
) {
  const n = await ctx.prisma.notification.findUnique({ where: { providerMessageId: s.id } });
  if (!n) return 'unknown_message';
  const ts = s.timestamp ? new Date(Number(s.timestamp) * 1000) : ctx.now();
  const target = s.status.toUpperCase();
  if (target === 'FAILED') {
    const err = s.errors?.[0];
    await ctx.prisma.notification.update({
      where: { id: n.id },
      data: { status: 'FAILED', lastError: `WhatsApp: ${err?.code ?? ''} ${err?.title ?? 'failed'}`.trim() },
    });
    return 'failed';
  }
  if (!(target in STATUS_RANK)) return 'ignored';
  // Webhooks can arrive out of order: only move forward.
  const currentRank = STATUS_RANK[n.status] ?? 0;
  if (n.status === 'FAILED' || STATUS_RANK[target] <= currentRank) return 'ignored';
  await ctx.prisma.notification.update({
    where: { id: n.id },
    data: {
      status: target as 'SENT' | 'DELIVERED' | 'READ',
      ...(target === 'DELIVERED' ? { deliveredAt: ts } : {}),
      ...(target === 'READ' ? { readAt: ts } : {}),
    },
  });
  return 'updated';
}

export function isOptOutText(text: string | undefined | null): boolean {
  if (!text) return false;
  const t = text.trim().toLowerCase().replace(/[.!]+$/, '');
  return WHATSAPP_OPT_OUT_KEYWORDS.includes(t);
}

/**
 * Honors an opt-out received on the platform sender: withdraws WhatsApp consent for every
 * member record with that phone (all creators) and suppresses queued WhatsApp messages.
 * Paid memberships are NOT affected.
 */
export async function withdrawWhatsappConsentByPhone(ctx: CoreContext, phoneE164: string, source: string) {
  const now = ctx.now();
  return ctx.prisma.$transaction(async (tx) => {
    const consents = await tx.notificationConsent.findMany({
      where: { channel: 'WHATSAPP', status: 'GRANTED', OR: [{ phoneE164 }, { member: { phoneE164 } }] },
    });
    for (const c of consents) {
      await tx.notificationConsent.update({
        where: { id: c.id },
        data: { status: 'WITHDRAWN', withdrawnAt: now, withdrawSource: source },
      });
      await audit(tx, {
        organizationId: c.organizationId,
        actorType: 'MEMBER',
        actorId: c.memberId,
        action: 'consent.whatsapp_withdrawn',
        entityType: 'NotificationConsent',
        entityId: c.id,
        metadata: { source },
      });
    }
    const memberIds = [...new Set(consents.map((c) => c.memberId))];
    const suppressed = await tx.notification.updateMany({
      where: { memberId: { in: memberIds }, channel: 'WHATSAPP', status: { in: ['SCHEDULED', 'QUEUED'] } },
      data: { status: 'SUPPRESSED', suppressedReason: 'member opted out of WhatsApp' },
    });
    return { consentsWithdrawn: consents.length, suppressed: suppressed.count };
  });
}

// ───────────────────────── Creator daily digest ─────────────────────────

export async function scheduleCreatorDigests(ctx: CoreContext) {
  const now = ctx.now();
  const orgs = await ctx.prisma.organization.findMany({
    where: { status: 'ACTIVE', onboardingComplete: true },
    include: { staff: { include: { user: true } }, reminderSettings: true },
  });
  let created = 0;
  for (const org of orgs) {
    const settings = org.reminderSettings ?? { creatorDigestEnabled: true, emailEnabled: true };
    if (!settings.creatorDigestEnabled) continue;
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: org.timezone }).format(now);
    const rows: Prisma.NotificationCreateManyInput[] = org.staff.map((s) => ({
      organizationId: org.id,
      recipientUserId: s.userId,
      channel: 'EMAIL',
      type: 'CREATOR_DIGEST',
      reminderKey: `digest_${day}`,
      dedupeKey: `${org.id}:digest:${s.userId}:EMAIL:${day}`,
      scheduledFor: adjustToSendingWindow(now, 8, 20, org.timezone),
    }));
    if (rows.length) created += (await ctx.prisma.notification.createMany({ data: rows, skipDuplicates: true })).count;
  }
  return { created };
}

async function deliverDigest(ctx: CoreContext, n: Notification): Promise<DeliveryResult> {
  const db = ctx.prisma;
  if (!n.recipientUserId) return suppress(db, n.id, 'missing recipient');
  const staff = await db.organizationStaff.findUnique({
    where: { organizationId_userId: { organizationId: n.organizationId, userId: n.recipientUserId } },
    include: { user: true, organization: true },
  });
  if (!staff) return suppress(db, n.id, 'recipient no longer staff');
  const now = ctx.now();
  const counts = await Promise.all([
    db.accessTask.count({ where: { organizationId: n.organizationId, status: 'OPEN', type: 'GRANT' } }),
    db.accessTask.count({ where: { organizationId: n.organizationId, status: 'OPEN', type: 'REMOVE' } }),
    db.accessTask.count({ where: { organizationId: n.organizationId, status: 'OPEN', type: 'REVIEW' } }),
    db.membership.count({
      where: { organizationId: n.organizationId, paidUntil: { gt: now, lte: new Date(now.getTime() + 3 * DAY_MS) } },
    }),
    db.notification.count({
      where: {
        organizationId: n.organizationId,
        status: { in: ['FAILED', 'NEEDS_REVIEW'] },
        updatedAt: { gte: new Date(now.getTime() - DAY_MS) },
      },
    }),
  ]);
  if (counts[0] + counts[1] + counts[2] + counts[4] === 0) return suppress(db, n.id, 'nothing to action today');
  const email = buildDigestEmail({
    orgName: staff.organization.displayName,
    pendingGrants: counts[0],
    pendingRemovals: counts[1],
    pendingReviews: counts[2],
    expiringSoon: counts[3],
    failedNotifications: counts[4],
    url: `${ctx.config.webBaseUrl}/creator/tasks`,
  });
  const attempt = await db.notificationAttempt.create({
    data: { notificationId: n.id, attemptNo: n.attemptCount, outcome: 'IN_FLIGHT' },
  });
  const outcome = await ctx.adapters.email.send({ to: staff.user.email, ...email, idempotencyKey: n.dedupeKey });
  return recordOutcome(ctx, n, attempt.id, outcome);
}
