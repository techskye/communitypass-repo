import { z } from 'zod';
import { MAX_GRACE_PERIOD_DAYS, PLAN_DURATIONS_DAYS } from './constants';
import { normalizePhoneE164 } from './format';

const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(10, 'Use at least 10 characters').max(200);
const shortText = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(48)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and single hyphens');

export const phoneSchema = z
  .string()
  .trim()
  .min(7)
  .max(20)
  .transform((v, ctx) => {
    const n = normalizePhoneE164(v);
    if (!n) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a valid phone number' });
      return z.NEVER;
    }
    return n;
  });

/**
 * WhatsApp invite URLs. We only accept the official chat.whatsapp.com invite format.
 * The app can store and update the link, but cannot reset or revoke it inside WhatsApp.
 */
export const whatsappInviteUrlSchema = z
  .string()
  .trim()
  .url()
  .max(200)
  .refine((u) => /^https:\/\/chat\.whatsapp\.com\/[A-Za-z0-9]{10,64}$/.test(u), {
    message: 'Use a WhatsApp group invite link like https://chat.whatsapp.com/AbC123...',
  });

export const planDurationSchema = z.coerce
  .number()
  .int()
  .refine((d) => (PLAN_DURATIONS_DAYS as readonly number[]).includes(d), {
    message: `Duration must be one of ${PLAN_DURATIONS_DAYS.join(', ')} days`,
  });

/** Price entered in kobo (integer). UIs convert from naira before sending. */
export const priceKoboSchema = z.coerce
  .number()
  .int()
  .min(10000, 'Minimum price is ₦100')
  .max(100_000_000_00, 'Price too large');

// ---------- Auth ----------
export const creatorSignupSchema = z.object({
  name: shortText(100),
  email,
  password,
});
export const loginSchema = z.object({ email, password: z.string().min(1).max(200) });
export const magicLinkRequestSchema = z.object({ email });
export const magicLinkVerifySchema = z.object({ token: z.string().min(20).max(200) });
export const switchOrgSchema = z.object({ organizationId: z.string().min(1).max(64) });
export const acceptInviteSchema = z.object({
  token: z.string().min(20).max(200),
  name: shortText(100),
  password,
});

// ---------- Onboarding / org ----------
export const reminderSettingsSchema = z.object({
  beforeExpiryDays: z.array(z.coerce.number().int().min(1).max(30)).max(4),
  onExpiry: z.boolean(),
  graceEnd: z.boolean(),
  sendWindowStartHour: z.coerce.number().int().min(0).max(23),
  sendWindowEndHour: z.coerce.number().int().min(1).max(24),
  maxMessagesPerMemberPerDay: z.coerce.number().int().min(1).max(5),
  creatorDigestEnabled: z.boolean(),
  whatsappEnabled: z.boolean(),
  emailEnabled: z.boolean(),
}).refine((v) => v.sendWindowEndHour > v.sendWindowStartHour, {
  message: 'Sending window end must be after start',
  path: ['sendWindowEndHour'],
});

export const planInputSchema = z.object({
  name: shortText(80),
  description: optionalText(500),
  priceKobo: priceKoboSchema,
  durationDays: planDurationSchema,
});

export const planUpdateSchema = planInputSchema.partial().extend({ isActive: z.boolean().optional() });

export const communityInputSchema = z.object({
  name: shortText(100),
  description: z.string().trim().max(2000).default(''),
  slug: slugSchema,
  imageUrl: z.string().trim().max(300).optional().nullable(),
  whatsappInviteUrl: whatsappInviteUrlSchema,
  accessInstructions: z.string().trim().max(2000).default(''),
  gracePeriodDays: z.coerce.number().int().min(0).max(MAX_GRACE_PERIOD_DAYS).default(0),
  adminApprovalEnabled: z.boolean().default(false),
  isPublished: z.boolean().default(true),
});
export const communityUpdateSchema = communityInputSchema.partial();

export const onboardingSchema = z.object({
  organizationName: shortText(120),
  displayName: shortText(80),
  supportEmail: email,
  community: communityInputSchema,
  plans: z.array(planInputSchema).min(1).max(6),
  reminders: reminderSettingsSchema.optional(),
  acknowledgeManualAccess: z.literal(true, {
    errorMap: () => ({ message: 'Please confirm you understand group access is managed manually' }),
  }),
});

export const orgProfileSchema = z.object({
  name: shortText(120),
  displayName: shortText(80),
  supportEmail: email,
  supportWhatsapp: z.union([phoneSchema, z.literal('')]).optional(),
});

export const staffInviteSchema = z.object({ email, role: z.enum(['OWNER', 'STAFF']).default('STAFF') });

// ---------- Public checkout ----------
export const checkoutStartSchema = z.object({
  communitySlug: slugSchema,
  planId: z.string().min(1).max(64),
  fullName: shortText(100),
  email,
  phone: phoneSchema,
  /** Must be an explicit opt-in; the checkbox is unchecked by default. */
  whatsappOptIn: z.boolean(),
  acceptTerms: z.literal(true, {
    errorMap: () => ({ message: 'Please accept the membership terms' }),
  }),
});

// ---------- Access tasks ----------
export const taskNoteSchema = z.object({ note: shortText(1000) });
export const taskDismissSchema = z.object({ reason: shortText(500) });
export const taskCompleteSchema = z.object({ note: optionalText(1000) });

// ---------- Member ----------
export const memberPreferencesSchema = z.object({
  emailReminders: z.boolean(),
  whatsappOptIn: z.boolean(),
  phone: phoneSchema.optional(),
});
export const membershipCancelSchema = z.object({ reason: optionalText(500) });

// ---------- Admin ----------
export const paymentSetupSchema = z.object({
  subaccountCode: z
    .string()
    .trim()
    .regex(/^ACCT_[A-Za-z0-9]+$/, 'Paystack subaccount codes look like ACCT_xxxxxxxx'),
  settlementBankName: optionalText(100),
  accountNumberLast4: z
    .string()
    .trim()
    .regex(/^\d{4}$/)
    .optional(),
  platformFeeBps: z.coerce.number().int().min(0).max(3000),
  feeBearer: z.enum(['ACCOUNT', 'SUBACCOUNT']),
  status: z.enum(['PENDING_REVIEW', 'ACTIVE', 'SUSPENDED']),
  notes: optionalText(1000),
});

export const saasBillingRecordSchema = z.object({
  periodStart: z.coerce.date(),
  periodEnd: z.coerce.date(),
  amountKobo: z.coerce.number().int().min(0),
  status: z.enum(['DUE', 'PAID', 'WAIVED']),
  note: optionalText(500),
});

export const whatsappTemplateSchema = z.object({
  purpose: z.enum(['PAYMENT_CONFIRMATION', 'ACCESS_INSTRUCTIONS', 'RENEWAL_REMINDER', 'EXPIRY_NOTICE']),
  name: z.string().trim().regex(/^[a-z0-9_]{1,512}$/, 'Template names are lowercase with underscores'),
  language: z.string().trim().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/),
  category: z.enum(['UTILITY', 'MARKETING']),
  status: z.enum(['APPROVED', 'PENDING', 'REJECTED', 'DISABLED']),
});

export const resolveIssueSchema = z.object({ resolution: shortText(1000) });

export type CreatorSignupInput = z.infer<typeof creatorSignupSchema>;
export type OnboardingInput = z.infer<typeof onboardingSchema>;
export type CommunityInput = z.infer<typeof communityInputSchema>;
export type PlanInput = z.infer<typeof planInputSchema>;
export type CheckoutStartInput = z.infer<typeof checkoutStartSchema>;
export type ReminderSettingsData = z.infer<typeof reminderSettingsSchema>;
export type PaymentSetupInput = z.infer<typeof paymentSetupSchema>;
