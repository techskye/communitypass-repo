-- CreateEnum
CREATE TYPE "SubscriptionTier" AS ENUM ('STARTER', 'GROWTH', 'PRO');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'PAUSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "InvoiceKind" AS ENUM ('CHECKOUT', 'RENEWAL');

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'CREATOR_BILLING';

-- CreateTable
CREATE TABLE "organization_subscriptions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "tier" "SubscriptionTier" NOT NULL,
    "pendingTier" "SubscriptionTier",
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'TRIALING',
    "trialEndsAt" TIMESTAMP(3) NOT NULL,
    "currentPeriodStart" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "authorizationCode" TEXT,
    "billingEmail" TEXT,
    "cardBrand" TEXT,
    "cardLast4" TEXT,
    "cardExpiry" TEXT,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_invoices" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" "InvoiceKind" NOT NULL,
    "tier" "SubscriptionTier" NOT NULL,
    "amountKobo" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'NGN',
    "reference" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'PENDING',
    "renewalKey" TEXT,
    "renewalFor" TIMESTAMP(3),
    "checkoutUrl" TEXT,
    "providerTransactionId" TEXT,
    "isLive" BOOLEAN NOT NULL DEFAULT false,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscription_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organization_subscriptions_organizationId_key" ON "organization_subscriptions"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_invoices_reference_key" ON "subscription_invoices"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_invoices_renewalKey_key" ON "subscription_invoices"("renewalKey");

-- CreateIndex
CREATE INDEX "subscription_invoices_organizationId_createdAt_idx" ON "subscription_invoices"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "subscription_invoices_status_createdAt_idx" ON "subscription_invoices"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "organization_subscriptions" ADD CONSTRAINT "organization_subscriptions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_invoices" ADD CONSTRAINT "subscription_invoices_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Money is positive integer kobo.
ALTER TABLE "subscription_invoices" ADD CONSTRAINT "subscription_invoices_amount_positive" CHECK ("amountKobo" > 0);

-- Existing organizations (created before subscriptions existed) start a 14-day Growth trial.
INSERT INTO "organization_subscriptions" ("id", "organizationId", "tier", "status", "trialEndsAt", "createdAt", "updatedAt")
SELECT 'sub_' || o."id", o."id", 'GROWTH', 'TRIALING', NOW() + INTERVAL '14 days', NOW(), NOW()
FROM "organizations" o
WHERE NOT EXISTS (SELECT 1 FROM "organization_subscriptions" s WHERE s."organizationId" = o."id");
