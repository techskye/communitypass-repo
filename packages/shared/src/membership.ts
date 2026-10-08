import { DAY_MS, PLAN_DURATIONS_DAYS, PlanDurationDays } from './constants';
import { adjustToSendingWindow } from './time';

export type Entitlement = 'none' | 'active' | 'grace' | 'expired';

export function isValidPlanDuration(days: number): days is PlanDurationDays {
  return (PLAN_DURATIONS_DAYS as readonly number[]).includes(days);
}

/**
 * new_paid_until = max(current_paid_until, verified_payment_paid_at) + purchased_duration
 * Durations are exact multiples of 24h in UTC — 30 days is never "one calendar month".
 */
export function computeNewPaidUntil(
  currentPaidUntil: Date | null | undefined,
  verifiedPaidAt: Date,
  durationDays: number,
): Date {
  if (!Number.isInteger(durationDays) || durationDays <= 0) {
    throw new Error(`Invalid duration: ${durationDays}`);
  }
  const base =
    currentPaidUntil && currentPaidUntil.getTime() > verifiedPaidAt.getTime()
      ? currentPaidUntil.getTime()
      : verifiedPaidAt.getTime();
  return new Date(base + durationDays * DAY_MS);
}

/**
 * Active while now < paid_until.
 * Grace while paid_until <= now < paid_until + grace (grace is NOT paid active).
 * Expired at/after paid_until + grace.
 */
export function getEntitlement(
  paidUntil: Date | null | undefined,
  gracePeriodDays: number,
  now: Date,
): Entitlement {
  if (!paidUntil) return 'none';
  const t = now.getTime();
  const end = paidUntil.getTime();
  if (t < end) return 'active';
  if (gracePeriodDays > 0 && t < end + gracePeriodDays * DAY_MS) return 'grace';
  return 'expired';
}

/** Whether the member may currently see access instructions / be in the group. */
export function hasAccessEntitlement(e: Entitlement): boolean {
  return e === 'active' || e === 'grace';
}

export function graceEndsAt(paidUntil: Date, gracePeriodDays: number): Date {
  return new Date(paidUntil.getTime() + gracePeriodDays * DAY_MS);
}

export type ReminderKey = `before_${number}d` | 'on_expiry' | 'grace_end';

export interface ReminderSettingsInput {
  beforeExpiryDays: number[];
  onExpiry: boolean;
  graceEnd: boolean;
  sendWindowStartHour: number;
  sendWindowEndHour: number;
}

export interface PlannedReminder {
  key: ReminderKey;
  kind: 'RENEWAL_REMINDER' | 'EXPIRY_NOTICE' | 'GRACE_ENDED';
  /** The nominal moment the reminder relates to (before sending-window adjustment). */
  nominalAt: Date;
  /** When the reminder should be sent (inside the local sending window). */
  dueAt: Date;
}

/**
 * Plans reminders for a paid-until value. Reminder moments that occurred before the
 * membership purchase (purchasedAt) are skipped — e.g. a 7-day plan bought 2 days before
 * a 3-day reminder would have been due still gets it, but a reminder whose nominal moment
 * predates the purchase is never sent.
 */
export function planReminders(params: {
  paidUntil: Date;
  purchasedAt: Date;
  gracePeriodDays: number;
  settings: ReminderSettingsInput;
  timeZone?: string;
}): PlannedReminder[] {
  const { paidUntil, purchasedAt, gracePeriodDays, settings, timeZone } = params;
  const out: PlannedReminder[] = [];
  const uniqueDays = [...new Set(settings.beforeExpiryDays)]
    .filter((d) => Number.isInteger(d) && d > 0 && d <= 30)
    .sort((a, b) => b - a);
  for (const d of uniqueDays) {
    out.push({
      key: `before_${d}d`,
      kind: 'RENEWAL_REMINDER',
      nominalAt: new Date(paidUntil.getTime() - d * DAY_MS),
      dueAt: new Date(0),
    });
  }
  if (settings.onExpiry) {
    out.push({ key: 'on_expiry', kind: 'EXPIRY_NOTICE', nominalAt: paidUntil, dueAt: new Date(0) });
  }
  if (settings.graceEnd && gracePeriodDays > 0) {
    out.push({
      key: 'grace_end',
      kind: 'GRACE_ENDED',
      nominalAt: graceEndsAt(paidUntil, gracePeriodDays),
      dueAt: new Date(0),
    });
  }
  return out
    .filter((r) => r.nominalAt.getTime() >= purchasedAt.getTime())
    .map((r) => {
      let due = adjustToSendingWindow(
        r.nominalAt,
        settings.sendWindowStartHour,
        settings.sendWindowEndHour,
        timeZone,
      );
      // A before-expiry reminder must never slip past expiry because of the sending window.
      if (r.kind === 'RENEWAL_REMINDER' && due.getTime() >= paidUntil.getTime()) {
        due = r.nominalAt;
      }
      return { ...r, dueAt: due };
    });
}

export function notificationDedupeKey(parts: {
  organizationId: string;
  membershipId: string;
  channel: string;
  reminderType: string;
  paidUntil: Date;
}): string {
  return [
    parts.organizationId,
    parts.membershipId,
    parts.channel,
    parts.reminderType,
    parts.paidUntil.toISOString(),
  ].join(':');
}
