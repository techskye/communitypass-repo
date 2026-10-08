import type { Prisma, ReconciliationKind, VerificationSource } from '@prisma/client';
import { computeNewPaidUntil } from '@communitypass/shared';
import type { CoreContext } from '../context';
import { audit, newId, Tx } from '../infra';
import type { VerifiedTransaction } from '../adapters/payment';
import { lockMembership, onMembershipPaid } from './access';
import { queuePaymentNotifications, suppressStaleReminders } from './notifications';

export type FulfillmentOutcome =
  | { outcome: 'fulfilled'; orderId: string; membershipId: string; previousPaidUntil: Date | null; newPaidUntil: Date }
  | { outcome: 'already_fulfilled'; orderId: string; membershipId: string; newPaidUntil: Date }
  | { outcome: 'not_successful'; orderId: string; providerStatus: string }
  | { outcome: 'held_for_review'; orderId: string; kind: ReconciliationKind }
  | { outcome: 'unknown_reference'; reference: string };

/**
 * THE fulfillment service. Webhooks, the payment callback and reconciliation all call this.
 *
 * Guarantees:
 *  - Only a server-side verified, successful provider transaction can extend a membership.
 *  - Reference, integer-kobo amount, currency, provider/mode and (when exposed) subaccount
 *    must match the stored order snapshot; otherwise the payment is held for review.
 *  - Exactly-once: the order row is locked (FOR UPDATE) and the fulfillment record has unique
 *    constraints on order and payment, so duplicates and races become no-ops.
 *  - Concurrent renewals for the same membership serialize on the membership row lock, so
 *    no paid time is lost: new_paid_until = max(current, paid_at) + duration.
 */
export async function fulfillVerifiedTransaction(
  ctx: CoreContext,
  reference: string,
  v: VerifiedTransaction,
  via: VerificationSource,
): Promise<FulfillmentOutcome> {
  const now = ctx.now();
  let newNotificationIds: string[] = [];

  const result = await ctx.prisma.$transaction(
    async (tx): Promise<FulfillmentOutcome> => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM orders WHERE reference = ${reference} FOR UPDATE`;
      if (!locked.length) {
        await tx.reconciliationIssue.create({
          data: {
            kind: 'UNKNOWN_REFERENCE',
            reference,
            details: { provider: v.provider, status: v.status, via, amountKobo: v.amountKobo },
          },
        });
        return { outcome: 'unknown_reference', reference };
      }
      const order = await tx.order.findUniqueOrThrow({
        where: { id: locked[0].id },
        include: { application: true, payment: true },
      });

      if (order.application) {
        return {
          outcome: 'already_fulfilled',
          orderId: order.id,
          membershipId: order.application.membershipId,
          newPaidUntil: order.application.newPaidUntil,
        };
      }

      await tx.order.update({
        where: { id: order.id },
        data: { lastVerifiedAt: now, lastVerifyStatus: `${via}:${v.status}` },
      });

      if (v.status !== 'success') {
        if (order.status === 'PENDING' && (v.status === 'failed' || v.status === 'reversed')) {
          await tx.order.update({
            where: { id: order.id },
            data: { status: 'FAILED', failureReason: `Provider status: ${v.status}` },
          });
        }
        return { outcome: 'not_successful', orderId: order.id, providerStatus: v.status };
      }

      // ── Validate everything against the stored order snapshot ──
      const problems: { kind: ReconciliationKind; detail: string }[] = [];
      if (v.reference !== order.reference) problems.push({ kind: 'UNKNOWN_REFERENCE', detail: 'reference mismatch' });
      if (v.provider !== order.provider) problems.push({ kind: 'MODE_MISMATCH', detail: 'provider mismatch' });
      if (order.provider === 'DEMO' && v.isLive) problems.push({ kind: 'MODE_MISMATCH', detail: 'live tx for demo order' });
      if (order.provider === 'PAYSTACK' && v.isLive !== ctx.config.paystack.liveMode) {
        problems.push({ kind: 'MODE_MISMATCH', detail: `expected ${ctx.config.paystack.liveMode ? 'live' : 'test'} transaction` });
      }
      if (!Number.isInteger(v.amountKobo) || v.amountKobo !== order.amountKobo) {
        problems.push({ kind: 'AMOUNT_MISMATCH', detail: `expected ${order.amountKobo} got ${v.amountKobo}` });
      }
      if (v.currency !== order.currency) {
        problems.push({ kind: 'CURRENCY_MISMATCH', detail: `expected ${order.currency} got ${v.currency}` });
      }
      if (order.subaccountCodeSnapshot && v.subaccountCode && v.subaccountCode !== order.subaccountCodeSnapshot) {
        problems.push({ kind: 'SUBACCOUNT_MISMATCH', detail: `expected ${order.subaccountCodeSnapshot} got ${v.subaccountCode}` });
      }
      if (!v.providerTransactionId) problems.push({ kind: 'VERIFY_ERROR', detail: 'missing transaction id' });

      const paidAt = v.paidAt && !Number.isNaN(v.paidAt.getTime()) ? v.paidAt : now;

      if (problems.length) {
        // Money may have moved, so record what the provider reported — but never activate.
        const alreadyRecorded = v.providerTransactionId
          ? await tx.payment.findUnique({
              where: { provider_providerTransactionId: { provider: v.provider, providerTransactionId: v.providerTransactionId } },
              select: { id: true },
            })
          : null;
        if (
          !order.payment &&
          !alreadyRecorded &&
          v.reference === order.reference &&
          v.provider === order.provider &&
          v.providerTransactionId &&
          Number.isInteger(v.amountKobo) &&
          v.amountKobo > 0
        ) {
          await tx.payment.create({
            data: {
              organizationId: order.organizationId,
              orderId: order.id,
              provider: order.provider,
              providerTransactionId: v.providerTransactionId,
              reference: order.reference,
              isLive: v.isLive && v.provider === 'PAYSTACK',
              status: 'HELD_FOR_REVIEW',
              amountKobo: v.amountKobo,
              currency: v.currency || order.currency,
              paidAt,
              channel: v.channel,
              feesKobo: v.feesKobo,
              verifiedVia: via,
            },
          });
        }
        if (order.status !== 'NEEDS_REVIEW') {
          await tx.order.update({
            where: { id: order.id },
            data: { status: 'NEEDS_REVIEW', failureReason: problems.map((p) => p.detail).join('; ') },
          });
          await tx.reconciliationIssue.create({
            data: {
              organizationId: order.organizationId,
              orderId: order.id,
              reference: order.reference,
              kind: problems[0].kind,
              details: { problems, via, provider: v.provider } as unknown as Prisma.InputJsonValue,
            },
          });
          await audit(tx, {
            organizationId: order.organizationId,
            actorType: 'PROVIDER',
            action: 'payment.held_for_review',
            entityType: 'Order',
            entityId: order.id,
            metadata: { problems, via },
          });
        }
        return { outcome: 'held_for_review', orderId: order.id, kind: problems[0].kind };
      }

      // ── Record the verified payment (unique per provider transaction and reference) ──
      const payment = await tx.payment.create({
        data: {
          organizationId: order.organizationId,
          orderId: order.id,
          provider: order.provider,
          providerTransactionId: v.providerTransactionId,
          reference: order.reference,
          isLive: v.provider === 'PAYSTACK' && v.isLive,
          status: 'SUCCESS',
          amountKobo: v.amountKobo,
          currency: v.currency,
          paidAt,
          channel: v.channel,
          feesKobo: v.feesKobo,
          verifiedVia: via,
        },
      });

      // ── Get-or-create and lock the membership ──
      await tx.$executeRaw`
        INSERT INTO memberships (id, "organizationId", "communityId", "memberId", "planId", "accessStatus", "accessStatusUpdatedAt", "createdAt", "updatedAt")
        VALUES (${newId()}, ${order.organizationId}, ${order.communityId}, ${order.memberId}, ${order.planId}, 'NOT_GRANTED', ${now}, ${now}, ${now})
        ON CONFLICT ("memberId", "communityId") DO NOTHING`;
      const existing = await tx.membership.findUniqueOrThrow({
        where: { memberId_communityId: { memberId: order.memberId, communityId: order.communityId } },
        select: { id: true },
      });
      const m = await lockMembership(tx, existing.id);

      const previousPaidUntil = m.paidUntil;
      const newPaidUntil = computeNewPaidUntil(previousPaidUntil, paidAt, order.durationDays);

      await tx.membershipPaymentApplication.create({
        data: {
          organizationId: order.organizationId,
          membershipId: m.id,
          paymentId: payment.id,
          orderId: order.id,
          previousPaidUntil,
          basisAt: previousPaidUntil && previousPaidUntil > paidAt ? previousPaidUntil : paidAt,
          durationDays: order.durationDays,
          newPaidUntil,
        },
      });
      await tx.membership.update({
        where: { id: m.id },
        data: {
          paidUntil: newPaidUntil,
          planId: order.planId,
          firstPaidAt: m.firstPaidAt ?? paidAt,
          lastPaymentAt: paidAt,
          cancelledAt: null, // paying again signals intent to keep the membership
          removalDismissedForPaidUntil: null,
        },
      });
      m.paidUntil = newPaidUntil;

      const { grantTaskId } = await onMembershipPaid(tx, m, now);
      await suppressStaleReminders(tx, m.id, newPaidUntil);
      await tx.order.update({ where: { id: order.id }, data: { status: 'PAID', failureReason: null } });

      newNotificationIds = await queuePaymentNotifications(tx, {
        organizationId: order.organizationId,
        memberId: order.memberId,
        membershipId: m.id,
        orderId: order.id,
        paidUntil: newPaidUntil,
        includeAccessInstructions: !!grantTaskId,
        now,
      });

      await audit(tx, {
        organizationId: order.organizationId,
        actorType: 'PROVIDER',
        action: 'membership.payment_applied',
        entityType: 'Membership',
        entityId: m.id,
        metadata: {
          orderId: order.id,
          paymentId: payment.id,
          reference: order.reference,
          via,
          provider: v.provider,
          isLive: payment.isLive,
          amountKobo: v.amountKobo,
          durationDays: order.durationDays,
          previousPaidUntil: previousPaidUntil?.toISOString() ?? null,
          newPaidUntil: newPaidUntil.toISOString(),
        },
      });

      return { outcome: 'fulfilled', orderId: order.id, membershipId: m.id, previousPaidUntil, newPaidUntil };
    },
    { timeout: 20000, maxWait: 10000 },
  );

  if (newNotificationIds.length && ctx.onNotificationsCreated) {
    try {
      await ctx.onNotificationsCreated(newNotificationIds);
    } catch (e) {
      ctx.logger.warn({ err: (e as Error).message }, 'could not enqueue notifications; dispatcher will pick them up');
    }
  }
  return result;
}

/** Server-side verification + fulfillment for a reference (callback & reconciliation path). */
export async function verifyAndFulfill(
  ctx: CoreContext,
  reference: string,
  via: VerificationSource,
): Promise<FulfillmentOutcome | { outcome: 'provider_unavailable' }> {
  const order = await ctx.prisma.order.findUnique({ where: { reference } });
  if (!order) return { outcome: 'unknown_reference', reference };
  const adapter = ctx.adapters.payments[order.provider];
  if (!adapter) return { outcome: 'provider_unavailable' };
  const v = await adapter.verify(reference);
  return fulfillVerifiedTransaction(ctx, reference, v, via);
}
