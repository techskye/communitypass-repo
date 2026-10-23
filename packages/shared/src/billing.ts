import { DAY_MS } from './constants';

/**
 * Creator SaaS subscription tiers. Creators pay CommunityPass monthly; member payments are
 * settled 100% to the creator's own Paystack subaccount and never pass through the platform.
 */
export type SubscriptionTier = 'STARTER' | 'GROWTH' | 'PRO';

export interface TierDefinition {
  tier: SubscriptionTier;
  name: string;
  priceKobo: number;
  /** null = unlimited */
  maxCommunities: number | null;
  /** Memberships with paid time remaining (grace does not count). null = unlimited */
  maxActiveMembers: number | null;
  whatsappReminders: boolean;
}

export const SUBSCRIPTION_TIERS: Record<SubscriptionTier, TierDefinition> = {
  STARTER: {
    tier: 'STARTER',
    name: 'Starter',
    priceKobo: 500_000,
    maxCommunities: 1,
    maxActiveMembers: 100,
    whatsappReminders: false,
  },
  GROWTH: {
    tier: 'GROWTH',
    name: 'Growth',
    priceKobo: 1_500_000,
    maxCommunities: 3,
    maxActiveMembers: 500,
    whatsappReminders: true,
  },
  PRO: {
    tier: 'PRO',
    name: 'Pro',
    priceKobo: 3_500_000,
    maxCommunities: null,
    maxActiveMembers: null,
    whatsappReminders: true,
  },
};

export const TIER_ORDER: SubscriptionTier[] = ['STARTER', 'GROWTH', 'PRO'];
export const SUBSCRIPTION_TRIAL_DAYS = 14;
export const SUBSCRIPTION_GRACE_DAYS = 7;
export const SUBSCRIPTION_MAX_RENEWAL_ATTEMPTS = 4;

export function isTierUpgrade(from: SubscriptionTier, to: SubscriptionTier): boolean {
  return TIER_ORDER.indexOf(to) > TIER_ORDER.indexOf(from);
}

/** Adds calendar months in UTC, clamping to the last day of shorter months (31 Jan + 1 = 28/29 Feb). */
export function addMonthsUtc(date: Date, months: number): Date {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + months;
  const targetYear = y + Math.floor(m / 12);
  const targetMonth = ((m % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      Math.min(date.getUTCDate(), lastDay),
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  );
}

export type SubscriptionAccess = 'trialing' | 'active' | 'past_due' | 'paused' | 'cancelled';

export interface SubscriptionLike {
  trialEndsAt: Date;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

/** The moment the creator's free trial or paid time runs out. */
export function subscriptionPaidThrough(s: SubscriptionLike): Date {
  const t = s.trialEndsAt.getTime();
  const p = s.currentPeriodEnd ? s.currentPeriodEnd.getTime() : 0;
  return new Date(Math.max(t, p));
}

/**
 * Pure access rule, computed from dates (never from a job-updated status, so a late job can't
 * wrongly block or allow a creator):
 *  - before paid-through: trialing (no payment yet) or active
 *  - cancelled renewals stop exactly at paid-through
 *  - otherwise a 7-day grace period (past_due), then paused
 */
export function getSubscriptionAccess(s: SubscriptionLike, now: Date): SubscriptionAccess {
  const paidThrough = subscriptionPaidThrough(s).getTime();
  const t = now.getTime();
  if (t < paidThrough) {
    return s.currentPeriodEnd && s.currentPeriodEnd.getTime() > t ? 'active' : 'trialing';
  }
  if (s.cancelAtPeriodEnd) return 'cancelled';
  if (t < paidThrough + SUBSCRIPTION_GRACE_DAYS * DAY_MS) return 'past_due';
  return 'paused';
}

/** Whether the creator's pages may take member payments. */
export function subscriptionAllowsPayments(access: SubscriptionAccess): boolean {
  return access === 'trialing' || access === 'active' || access === 'past_due';
}

export const SUBSCRIPTION_ACCESS_LABELS: Record<SubscriptionAccess, string> = {
  trialing: 'Free trial',
  active: 'Active',
  past_due: 'Payment overdue',
  paused: 'Paused (unpaid)',
  cancelled: 'Cancelled',
};
