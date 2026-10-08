export const DEFAULT_TIMEZONE = 'Africa/Lagos';
export const CURRENCY = 'NGN' as const;

/** V1 plans are fixed-duration. These are exact day counts, never calendar months. */
export const PLAN_DURATIONS_DAYS = [7, 30, 90, 365] as const;
export type PlanDurationDays = (typeof PLAN_DURATIONS_DAYS)[number];

export const DAY_MS = 24 * 60 * 60 * 1000;

export const PLAN_DURATION_LABELS: Record<PlanDurationDays, string> = {
  7: '7 days',
  30: '30 days',
  90: '90 days',
  365: '365 days',
};

export const MAX_GRACE_PERIOD_DAYS = 14;

/** Magic links are short-lived and single-use. */
export const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
export const STAFF_SESSION_TTL_MS = 7 * DAY_MS;
export const MEMBER_SESSION_TTL_MS = 14 * DAY_MS;
export const STAFF_INVITE_TTL_MS = 7 * DAY_MS;

/**
 * Versioned consent wording. When the wording changes, add a new version;
 * never edit an existing one because stored consents reference it.
 */
export const WHATSAPP_CONSENT_VERSIONS = {
  'wa-v1': (creatorName: string) =>
    `I agree to receive WhatsApp messages from CommunityPass on behalf of ${creatorName} about my membership: ` +
    `payment receipts, group access instructions, renewal reminders and expiry notices. ` +
    `I can reply STOP at any time to stop these messages. Stopping messages does not cancel my membership.`,
} as const;
export type WhatsappConsentVersion = keyof typeof WHATSAPP_CONSENT_VERSIONS;
export const CURRENT_WHATSAPP_CONSENT_VERSION: WhatsappConsentVersion = 'wa-v1';

/** Inbound WhatsApp keywords that we treat as an opt-out request (case-insensitive, trimmed). */
export const WHATSAPP_OPT_OUT_KEYWORDS = [
  'stop',
  'unsubscribe',
  'stop all',
  'cancel messages',
  'opt out',
  'optout',
  'end',
  'quit',
];

export const DEFAULT_REMINDER_SETTINGS = {
  beforeExpiryDays: [3, 1],
  onExpiry: true,
  graceEnd: true,
  sendWindowStartHour: 8,
  sendWindowEndHour: 20,
  maxMessagesPerMemberPerDay: 2,
  creatorDigestEnabled: true,
};

export const ALLOWED_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const MAX_IMAGE_UPLOAD_BYTES = 2 * 1024 * 1024;
