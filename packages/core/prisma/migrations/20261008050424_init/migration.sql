-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "SessionKind" AS ENUM ('STAFF', 'MEMBER');

-- CreateEnum
CREATE TYPE "OrgStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "StaffRole" AS ENUM ('OWNER', 'STAFF');

-- CreateEnum
CREATE TYPE "PaymentSetupStatus" AS ENUM ('NOT_CONFIGURED', 'PENDING_REVIEW', 'ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "FeeBearer" AS ENUM ('ACCOUNT', 'SUBACCOUNT');

-- CreateEnum
CREATE TYPE "SaasBillingStatus" AS ENUM ('DUE', 'PAID', 'WAIVED');

-- CreateEnum
CREATE TYPE "AccessStatus" AS ENUM ('NOT_GRANTED', 'PENDING_GRANT', 'GRANTED', 'PENDING_REMOVAL', 'REMOVED');

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('PAYSTACK', 'DEMO');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'ABANDONED', 'NEEDS_REVIEW');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('SUCCESS', 'HELD_FOR_REVIEW', 'REFUND_PENDING', 'REFUNDED', 'PARTIALLY_REFUNDED', 'DISPUTED');

-- CreateEnum
CREATE TYPE "VerificationSource" AS ENUM ('WEBHOOK', 'CALLBACK', 'RECONCILIATION');

-- CreateEnum
CREATE TYPE "ProviderEventSource" AS ENUM ('PAYSTACK', 'WHATSAPP', 'DEMO');

-- CreateEnum
CREATE TYPE "ReconciliationKind" AS ENUM ('AMOUNT_MISMATCH', 'CURRENCY_MISMATCH', 'SUBACCOUNT_MISMATCH', 'MODE_MISMATCH', 'UNKNOWN_REFERENCE', 'REFUND', 'DISPUTE', 'VERIFY_ERROR', 'STALE_PENDING');

-- CreateEnum
CREATE TYPE "IssueStatus" AS ENUM ('OPEN', 'RESOLVED');

-- CreateEnum
CREATE TYPE "AccessTaskType" AS ENUM ('GRANT', 'REMOVE', 'REVIEW');

-- CreateEnum
CREATE TYPE "AccessTaskStatus" AS ENUM ('OPEN', 'COMPLETED', 'DISMISSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AccessTaskReason" AS ENUM ('NEW_PAID_MEMBER', 'RENEWED_AFTER_REMOVAL', 'MEMBERSHIP_EXPIRED', 'REFUND', 'DISPUTE', 'REOPENED', 'MANUAL');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('WHATSAPP', 'EMAIL');

-- CreateEnum
CREATE TYPE "ConsentStatus" AS ENUM ('GRANTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('PAYMENT_RECEIPT', 'ACCESS_INSTRUCTIONS', 'RENEWAL_REMINDER', 'EXPIRY_NOTICE', 'GRACE_ENDED', 'CREATOR_DIGEST');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('SCHEDULED', 'QUEUED', 'SENDING', 'ACCEPTED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'SUPPRESSED', 'NEEDS_REVIEW');

-- CreateEnum
CREATE TYPE "AttemptOutcome" AS ENUM ('IN_FLIGHT', 'ACCEPTED', 'RETRYABLE_ERROR', 'PERMANENT_ERROR', 'AMBIGUOUS');

-- CreateEnum
CREATE TYPE "TemplatePurpose" AS ENUM ('PAYMENT_CONFIRMATION', 'ACCESS_INSTRUCTIONS', 'RENEWAL_REMINDER', 'EXPIRY_NOTICE');

-- CreateEnum
CREATE TYPE "TemplateStatus" AS ENUM ('APPROVED', 'PENDING', 'REJECTED', 'DISABLED');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'MEMBER', 'SYSTEM', 'PROVIDER', 'ADMIN');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "isPlatformAdmin" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member_accounts" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "member_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "kind" "SessionKind" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT,
    "memberAccountId" TEXT,
    "activeOrganizationId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "magic_link_tokens" (
    "id" TEXT NOT NULL,
    "memberAccountId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "magic_link_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "supportEmail" TEXT NOT NULL,
    "supportWhatsapp" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Africa/Lagos',
    "status" "OrgStatus" NOT NULL DEFAULT 'ACTIVE',
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "onboardingComplete" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_staff" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "StaffRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_staff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_invites" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "StaffRole" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "invitedByUserId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_payment_configs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "status" "PaymentSetupStatus" NOT NULL DEFAULT 'NOT_CONFIGURED',
    "subaccountCode" TEXT,
    "settlementBankName" TEXT,
    "accountNumberLast4" TEXT,
    "platformFeeBps" INTEGER NOT NULL DEFAULT 0,
    "feeBearer" "FeeBearer" NOT NULL DEFAULT 'SUBACCOUNT',
    "notes" TEXT,
    "updatedByUserId" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_payment_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reminder_settings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "beforeExpiryDays" INTEGER[] DEFAULT ARRAY[3, 1]::INTEGER[],
    "onExpiry" BOOLEAN NOT NULL DEFAULT true,
    "graceEnd" BOOLEAN NOT NULL DEFAULT true,
    "sendWindowStartHour" INTEGER NOT NULL DEFAULT 8,
    "sendWindowEndHour" INTEGER NOT NULL DEFAULT 20,
    "maxMessagesPerMemberPerDay" INTEGER NOT NULL DEFAULT 2,
    "creatorDigestEnabled" BOOLEAN NOT NULL DEFAULT true,
    "whatsappEnabled" BOOLEAN NOT NULL DEFAULT true,
    "emailEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reminder_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saas_billing_records" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "amountKobo" INTEGER NOT NULL,
    "status" "SaasBillingStatus" NOT NULL,
    "note" TEXT,
    "recordedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "saas_billing_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "communities" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "slug" TEXT NOT NULL,
    "imageUrl" TEXT,
    "whatsappInviteUrl" TEXT NOT NULL,
    "inviteUrlUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accessInstructions" TEXT NOT NULL DEFAULT '',
    "gracePeriodDays" INTEGER NOT NULL DEFAULT 0,
    "adminApprovalEnabled" BOOLEAN NOT NULL DEFAULT false,
    "isPublished" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "communities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plans" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "communityId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "priceKobo" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "durationDays" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "members" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "memberAccountId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phoneE164" TEXT NOT NULL,
    "emailReminders" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "communityId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "paidUntil" TIMESTAMP(3),
    "firstPaidAt" TIMESTAMP(3),
    "lastPaymentAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "accessStatus" "AccessStatus" NOT NULL DEFAULT 'NOT_GRANTED',
    "accessStatusUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removalDismissedForPaidUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "communityId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "planNameSnapshot" TEXT NOT NULL,
    "communityNameSnapshot" TEXT NOT NULL,
    "amountKobo" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "durationDays" INTEGER NOT NULL,
    "subaccountCodeSnapshot" TEXT,
    "platformFeeKobo" INTEGER NOT NULL DEFAULT 0,
    "feeBearerSnapshot" "FeeBearer",
    "checkoutUrl" TEXT,
    "providerAccessCode" TEXT,
    "lastVerifiedAt" TIMESTAMP(3),
    "lastVerifyStatus" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "providerTransactionId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "isLive" BOOLEAN NOT NULL,
    "status" "PaymentStatus" NOT NULL,
    "amountKobo" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL,
    "channel" TEXT,
    "feesKobo" INTEGER,
    "verifiedVia" "VerificationSource" NOT NULL,
    "refundedAmountKobo" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "membership_payment_applications" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "previousPaidUntil" TIMESTAMP(3),
    "basisAt" TIMESTAMP(3) NOT NULL,
    "durationDays" INTEGER NOT NULL,
    "newPaidUntil" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "membership_payment_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "demo_transactions" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "amountKobo" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "demo_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_events" (
    "id" TEXT NOT NULL,
    "source" "ProviderEventSource" NOT NULL,
    "eventType" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "processingError" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "provider_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_issues" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "orderId" TEXT,
    "paymentId" TEXT,
    "reference" TEXT,
    "kind" "ReconciliationKind" NOT NULL,
    "details" JSONB NOT NULL,
    "status" "IssueStatus" NOT NULL DEFAULT 'OPEN',
    "resolution" TEXT,
    "resolvedByUserId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reconciliation_issues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_tasks" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "communityId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "type" "AccessTaskType" NOT NULL,
    "status" "AccessTaskStatus" NOT NULL DEFAULT 'OPEN',
    "reason" "AccessTaskReason" NOT NULL,
    "reasonDetail" TEXT,
    "completedAt" TIMESTAMP(3),
    "completedByUserId" TEXT,
    "dismissedReason" TEXT,
    "cancelledReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "access_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_task_notes" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "authorUserId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_task_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_consents" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "scope" TEXT NOT NULL,
    "status" "ConsentStatus" NOT NULL,
    "phoneE164" TEXT,
    "wordingVersion" TEXT NOT NULL,
    "wordingText" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3),
    "withdrawnAt" TIMESTAMP(3),
    "withdrawSource" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "memberId" TEXT,
    "membershipId" TEXT,
    "recipientUserId" TEXT,
    "channel" "NotificationChannel" NOT NULL,
    "type" "NotificationType" NOT NULL,
    "reminderKey" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "paidUntilSnapshot" TIMESTAMP(3),
    "orderId" TEXT,
    "status" "NotificationStatus" NOT NULL DEFAULT 'SCHEDULED',
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "providerMessageId" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "suppressedReason" TEXT,
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_attempts" (
    "id" TEXT NOT NULL,
    "notificationId" TEXT NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "outcome" "AttemptOutcome" NOT NULL,
    "providerMessageId" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "notification_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_templates" (
    "id" TEXT NOT NULL,
    "purpose" "TemplatePurpose" NOT NULL,
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "status" "TemplateStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "demo_outbox_messages" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "demo_outbox_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_statuses" (
    "id" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "configured" BOOLEAN NOT NULL,
    "lastOkAt" TIMESTAMP(3),
    "lastErrorAt" TIMESTAMP(3),
    "lastError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "integration_statuses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "actorType" "ActorType" NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "member_accounts_email_key" ON "member_accounts"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_tokenHash_key" ON "sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- CreateIndex
CREATE INDEX "sessions_memberAccountId_idx" ON "sessions"("memberAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "magic_link_tokens_tokenHash_key" ON "magic_link_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "magic_link_tokens_memberAccountId_createdAt_idx" ON "magic_link_tokens"("memberAccountId", "createdAt");

-- CreateIndex
CREATE INDEX "organization_staff_userId_idx" ON "organization_staff"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "organization_staff_organizationId_userId_key" ON "organization_staff"("organizationId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "staff_invites_tokenHash_key" ON "staff_invites"("tokenHash");

-- CreateIndex
CREATE INDEX "staff_invites_organizationId_idx" ON "staff_invites"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "organization_payment_configs_organizationId_key" ON "organization_payment_configs"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "reminder_settings_organizationId_key" ON "reminder_settings"("organizationId");

-- CreateIndex
CREATE INDEX "saas_billing_records_organizationId_idx" ON "saas_billing_records"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "communities_slug_key" ON "communities"("slug");

-- CreateIndex
CREATE INDEX "communities_organizationId_idx" ON "communities"("organizationId");

-- CreateIndex
CREATE INDEX "plans_organizationId_idx" ON "plans"("organizationId");

-- CreateIndex
CREATE INDEX "plans_communityId_idx" ON "plans"("communityId");

-- CreateIndex
CREATE INDEX "members_organizationId_idx" ON "members"("organizationId");

-- CreateIndex
CREATE INDEX "members_phoneE164_idx" ON "members"("phoneE164");

-- CreateIndex
CREATE UNIQUE INDEX "members_organizationId_memberAccountId_key" ON "members"("organizationId", "memberAccountId");

-- CreateIndex
CREATE INDEX "memberships_organizationId_paidUntil_idx" ON "memberships"("organizationId", "paidUntil");

-- CreateIndex
CREATE INDEX "memberships_organizationId_accessStatus_idx" ON "memberships"("organizationId", "accessStatus");

-- CreateIndex
CREATE INDEX "memberships_communityId_idx" ON "memberships"("communityId");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_memberId_communityId_key" ON "memberships"("memberId", "communityId");

-- CreateIndex
CREATE UNIQUE INDEX "orders_reference_key" ON "orders"("reference");

-- CreateIndex
CREATE INDEX "orders_organizationId_createdAt_idx" ON "orders"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "orders_status_createdAt_idx" ON "orders"("status", "createdAt");

-- CreateIndex
CREATE INDEX "orders_memberId_idx" ON "orders"("memberId");

-- CreateIndex
CREATE UNIQUE INDEX "payments_orderId_key" ON "payments"("orderId");

-- CreateIndex
CREATE INDEX "payments_organizationId_paidAt_idx" ON "payments"("organizationId", "paidAt");

-- CreateIndex
CREATE UNIQUE INDEX "payments_provider_providerTransactionId_key" ON "payments"("provider", "providerTransactionId");

-- CreateIndex
CREATE UNIQUE INDEX "payments_provider_reference_key" ON "payments"("provider", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "membership_payment_applications_paymentId_key" ON "membership_payment_applications"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "membership_payment_applications_orderId_key" ON "membership_payment_applications"("orderId");

-- CreateIndex
CREATE INDEX "membership_payment_applications_organizationId_idx" ON "membership_payment_applications"("organizationId");

-- CreateIndex
CREATE INDEX "membership_payment_applications_membershipId_idx" ON "membership_payment_applications"("membershipId");

-- CreateIndex
CREATE UNIQUE INDEX "demo_transactions_reference_key" ON "demo_transactions"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "provider_events_dedupeKey_key" ON "provider_events"("dedupeKey");

-- CreateIndex
CREATE INDEX "provider_events_source_processedAt_idx" ON "provider_events"("source", "processedAt");

-- CreateIndex
CREATE INDEX "reconciliation_issues_status_createdAt_idx" ON "reconciliation_issues"("status", "createdAt");

-- CreateIndex
CREATE INDEX "reconciliation_issues_organizationId_idx" ON "reconciliation_issues"("organizationId");

-- CreateIndex
CREATE INDEX "access_tasks_organizationId_status_type_idx" ON "access_tasks"("organizationId", "status", "type");

-- CreateIndex
CREATE INDEX "access_tasks_membershipId_idx" ON "access_tasks"("membershipId");

-- CreateIndex
CREATE INDEX "access_task_notes_taskId_idx" ON "access_task_notes"("taskId");

-- CreateIndex
CREATE INDEX "notification_consents_organizationId_idx" ON "notification_consents"("organizationId");

-- CreateIndex
CREATE INDEX "notification_consents_phoneE164_idx" ON "notification_consents"("phoneE164");

-- CreateIndex
CREATE UNIQUE INDEX "notification_consents_memberId_channel_scope_key" ON "notification_consents"("memberId", "channel", "scope");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_dedupeKey_key" ON "notifications"("dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_providerMessageId_key" ON "notifications"("providerMessageId");

-- CreateIndex
CREATE INDEX "notifications_status_scheduledFor_idx" ON "notifications"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "notifications_organizationId_createdAt_idx" ON "notifications"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "notifications_membershipId_idx" ON "notifications"("membershipId");

-- CreateIndex
CREATE UNIQUE INDEX "notification_attempts_notificationId_attemptNo_key" ON "notification_attempts"("notificationId", "attemptNo");

-- CreateIndex
CREATE UNIQUE INDEX "whatsapp_templates_purpose_language_key" ON "whatsapp_templates"("purpose", "language");

-- CreateIndex
CREATE INDEX "audit_logs_organizationId_createdAt_idx" ON "audit_logs"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_logs_entityType_entityId_idx" ON "audit_logs"("entityType", "entityId");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_memberAccountId_fkey" FOREIGN KEY ("memberAccountId") REFERENCES "member_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "magic_link_tokens" ADD CONSTRAINT "magic_link_tokens_memberAccountId_fkey" FOREIGN KEY ("memberAccountId") REFERENCES "member_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_staff" ADD CONSTRAINT "organization_staff_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_staff" ADD CONSTRAINT "organization_staff_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_invites" ADD CONSTRAINT "staff_invites_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_payment_configs" ADD CONSTRAINT "organization_payment_configs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminder_settings" ADD CONSTRAINT "reminder_settings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saas_billing_records" ADD CONSTRAINT "saas_billing_records_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communities" ADD CONSTRAINT "communities_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plans" ADD CONSTRAINT "plans_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plans" ADD CONSTRAINT "plans_communityId_fkey" FOREIGN KEY ("communityId") REFERENCES "communities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "members" ADD CONSTRAINT "members_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "members" ADD CONSTRAINT "members_memberAccountId_fkey" FOREIGN KEY ("memberAccountId") REFERENCES "member_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_communityId_fkey" FOREIGN KEY ("communityId") REFERENCES "communities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_communityId_fkey" FOREIGN KEY ("communityId") REFERENCES "communities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_payment_applications" ADD CONSTRAINT "membership_payment_applications_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_payment_applications" ADD CONSTRAINT "membership_payment_applications_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "memberships"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_payment_applications" ADD CONSTRAINT "membership_payment_applications_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership_payment_applications" ADD CONSTRAINT "membership_payment_applications_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_issues" ADD CONSTRAINT "reconciliation_issues_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_tasks" ADD CONSTRAINT "access_tasks_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_tasks" ADD CONSTRAINT "access_tasks_communityId_fkey" FOREIGN KEY ("communityId") REFERENCES "communities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_tasks" ADD CONSTRAINT "access_tasks_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "memberships"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_tasks" ADD CONSTRAINT "access_tasks_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_task_notes" ADD CONSTRAINT "access_task_notes_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "access_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_consents" ADD CONSTRAINT "notification_consents_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_consents" ADD CONSTRAINT "notification_consents_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "memberships"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_attempts" ADD CONSTRAINT "notification_attempts_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ───────────── Integrity guarantees not expressible in Prisma schema ─────────────

-- At most one OPEN access task of each type per membership.
CREATE UNIQUE INDEX "access_tasks_one_open_per_type"
  ON "access_tasks" ("membershipId", "type") WHERE "status" = 'OPEN';

-- Money is integer kobo and positive.
ALTER TABLE "orders"   ADD CONSTRAINT "orders_amount_positive"   CHECK ("amountKobo" > 0);
ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_positive" CHECK ("amountKobo" > 0);
ALTER TABLE "plans"    ADD CONSTRAINT "plans_price_positive"     CHECK ("priceKobo" > 0);
ALTER TABLE "plans"    ADD CONSTRAINT "plans_duration_allowed"   CHECK ("durationDays" IN (7, 30, 90, 365));
ALTER TABLE "communities" ADD CONSTRAINT "communities_grace_range" CHECK ("gracePeriodDays" BETWEEN 0 AND 14);

-- Immutable payment audit information: identity and money fields can never change; rows cannot be deleted.
CREATE OR REPLACE FUNCTION payments_immutable_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payments are immutable and cannot be deleted';
  END IF;
  IF NEW."amountKobo" IS DISTINCT FROM OLD."amountKobo"
     OR NEW."currency" IS DISTINCT FROM OLD."currency"
     OR NEW."reference" IS DISTINCT FROM OLD."reference"
     OR NEW."providerTransactionId" IS DISTINCT FROM OLD."providerTransactionId"
     OR NEW."provider" IS DISTINCT FROM OLD."provider"
     OR NEW."paidAt" IS DISTINCT FROM OLD."paidAt"
     OR NEW."isLive" IS DISTINCT FROM OLD."isLive"
     OR NEW."orderId" IS DISTINCT FROM OLD."orderId"
     OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId" THEN
    RAISE EXCEPTION 'payment audit fields are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payments_immutable
  BEFORE UPDATE OR DELETE ON "payments"
  FOR EACH ROW EXECUTE FUNCTION payments_immutable_guard();

-- Fulfillment records are permanent.
CREATE OR REPLACE FUNCTION append_only_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER membership_payment_applications_append_only
  BEFORE UPDATE OR DELETE ON "membership_payment_applications"
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();

CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();
