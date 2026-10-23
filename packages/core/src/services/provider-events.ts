import type { PaymentStatus, Prisma } from '@prisma/client';
import { normalizePhoneE164 } from '@communitypass/shared';
import type { CoreContext } from '../context';
import { audit, isUniqueViolation } from '../infra';
import { verifyPaystackSignature } from '../adapters/payment';
import { verifyMetaSignature } from '../adapters/messaging';
import { lockMembership, openTaskIfAbsent } from './access';
import { fulfillVerifiedTransaction } from './fulfillment';
import { applySubscriptionPayment } from './billing';
import { applyWhatsappStatus, isOptOutText, withdrawWhatsappConsentByPhone } from './notifications';

export type RecordResult =
  | { ok: false; reason: 'invalid_signature' | 'invalid_payload' | 'not_configured' }
  | { ok: true; eventId: string; duplicate: boolean };

/**
 * Verifies the Paystack signature over the EXACT raw body and durably persists the event
 * before the HTTP layer acknowledges it. Processing happens afterwards (queue / sweeper).
 */
export async function recordPaystackWebhook(
  ctx: CoreContext,
  rawBody: Buffer | undefined,
  signature: string | undefined,
): Promise<RecordResult> {
  if (!ctx.config.paystack.secretKey) return { ok: false, reason: 'not_configured' };
  if (!verifyPaystackSignature(rawBody, signature, ctx.config.paystack.secretKey)) {
    return { ok: false, reason: 'invalid_signature' };
  }
  let payload: any;
  try {
    payload = JSON.parse(rawBody!.toString('utf8'));
  } catch {
    return { ok: false, reason: 'invalid_payload' };
  }
  const event = typeof payload?.event === 'string' ? payload.event : 'unknown';
  const d = payload?.data ?? {};
  const id = d.id ?? d.reference ?? d.transaction_reference ?? 'noid';
  const dedupeKey = `paystack:${event}:${id}:${d.status ?? ''}`;
  return persistEvent(ctx, 'PAYSTACK', event, dedupeKey, redactPaystack(payload));
}

/** Keep only what we need; drop card/authorization/customer detail from stored payloads. */
function redactPaystack(p: any): Prisma.InputJsonValue {
  const d = p?.data ?? {};
  return {
    event: p?.event ?? null,
    data: {
      id: d.id ?? null,
      reference: d.reference ?? null,
      status: d.status ?? null,
      amount: d.amount ?? null,
      currency: d.currency ?? null,
      domain: d.domain ?? null,
      paid_at: d.paid_at ?? d.paidAt ?? null,
      transaction_reference: d.transaction_reference ?? d.transaction?.reference ?? null,
      refund_amount: d.amount ?? null,
      deducted_amount: d.deducted_amount ?? null,
      dispute_status: d.status ?? null,
      resolution: d.resolution ?? null,
      subaccount: d.subaccount?.subaccount_code ?? null,
    },
  };
}

async function persistEvent(
  ctx: CoreContext,
  source: 'PAYSTACK' | 'WHATSAPP',
  eventType: string,
  dedupeKey: string,
  payload: Prisma.InputJsonValue,
): Promise<RecordResult> {
  try {
    const e = await ctx.prisma.providerEvent.create({ data: { source, eventType, dedupeKey, payload } });
    return { ok: true, eventId: e.id, duplicate: false };
  } catch (e) {
    if (isUniqueViolation(e)) {
      const existing = await ctx.prisma.providerEvent.findUniqueOrThrow({ where: { dedupeKey } });
      return { ok: true, eventId: existing.id, duplicate: true };
    }
    throw e;
  }
}

export async function recordWhatsappWebhook(
  ctx: CoreContext,
  rawBody: Buffer | undefined,
  signature: string | undefined,
): Promise<RecordResult> {
  if (!ctx.config.whatsapp.appSecret) return { ok: false, reason: 'not_configured' };
  if (!verifyMetaSignature(rawBody, signature, ctx.config.whatsapp.appSecret)) {
    return { ok: false, reason: 'invalid_signature' };
  }
  let payload: any;
  try {
    payload = JSON.parse(rawBody!.toString('utf8'));
  } catch {
    return { ok: false, reason: 'invalid_payload' };
  }
  const ids: string[] = [];
  for (const entry of payload?.entry ?? []) {
    for (const ch of entry?.changes ?? []) {
      for (const s of ch?.value?.statuses ?? []) ids.push(`s:${s.id}:${s.status}`);
      for (const m of ch?.value?.messages ?? []) ids.push(`m:${m.id}`);
    }
  }
  const dedupeKey = `whatsapp:${ids.sort().join('|').slice(0, 400) || `raw:${Date.now()}`}`;
  return persistEvent(ctx, 'WHATSAPP', 'webhook', dedupeKey, minimalWhatsapp(payload));
}

/** Store only routing/status data and opt-out-relevant text; not full message payloads. */
function minimalWhatsapp(p: any): Prisma.InputJsonValue {
  const statuses: any[] = [];
  const messages: any[] = [];
  for (const entry of p?.entry ?? []) {
    for (const ch of entry?.changes ?? []) {
      for (const s of ch?.value?.statuses ?? []) {
        statuses.push({
          id: s.id,
          status: s.status,
          timestamp: s.timestamp,
          errors: (s.errors ?? []).map((e: any) => ({ code: e.code, title: e.title })),
        });
      }
      for (const m of ch?.value?.messages ?? []) {
        const text: string | undefined = m?.text?.body ?? m?.button?.text ?? m?.interactive?.button_reply?.title;
        messages.push({
          id: m.id,
          from: m.from,
          type: m.type,
          // Only keep the text if it is an opt-out keyword; other content is not stored.
          optOut: isOptOutText(text),
        });
      }
    }
  }
  return { statuses, messages };
}

export async function processProviderEvent(ctx: CoreContext, eventId: string): Promise<string> {
  const ev = await ctx.prisma.providerEvent.findUnique({ where: { id: eventId } });
  if (!ev) return 'missing';
  if (ev.processedAt) return 'already_processed';
  await ctx.prisma.providerEvent.update({ where: { id: ev.id }, data: { attempts: { increment: 1 } } });
  try {
    const outcome =
      ev.source === 'PAYSTACK'
        ? await processPaystackEvent(ctx, ev.eventType, ev.payload as any)
        : ev.source === 'WHATSAPP'
          ? await processWhatsappEvent(ctx, ev.payload as any)
          : 'ignored';
    await ctx.prisma.providerEvent.update({
      where: { id: ev.id },
      data: { processedAt: ctx.now(), processingError: null },
    });
    return outcome;
  } catch (e) {
    await ctx.prisma.providerEvent.update({
      where: { id: ev.id },
      data: { processingError: (e as Error).message.slice(0, 500) },
    });
    throw e;
  }
}

/** Unprocessed events (e.g. queue unavailable at receipt time) are retried by the worker. */
export async function findUnprocessedEvents(ctx: CoreContext, olderThanSeconds = 30, limit = 100) {
  return ctx.prisma.providerEvent.findMany({
    where: {
      processedAt: null,
      attempts: { lt: 10 },
      receivedAt: { lt: new Date(ctx.now().getTime() - olderThanSeconds * 1000) },
    },
    select: { id: true },
    take: limit,
    orderBy: { receivedAt: 'asc' },
  });
}

async function processPaystackEvent(ctx: CoreContext, event: string, payload: any): Promise<string> {
  const d = payload?.data ?? {};
  if (event === 'charge.success') {
    const reference = d.reference;
    if (typeof reference !== 'string') return 'no_reference';
    const adapter = ctx.adapters.payments.PAYSTACK;
    if (!adapter) throw new Error('Paystack adapter not configured');
    // Even though the webhook is signed, re-verify server-side before fulfilling.
    const v = await adapter.verify(reference);
    if (reference.startsWith('SUB-')) return `subscription:${await applySubscriptionPayment(ctx, reference, v)}`;
    const r = await fulfillVerifiedTransaction(ctx, reference, v, 'WEBHOOK');
    return r.outcome;
  }
  if (event.startsWith('refund.')) {
    return applyRefundEvent(ctx, event, d);
  }
  if (event.startsWith('charge.dispute.')) {
    return applyDisputeEvent(ctx, event, d);
  }
  return 'ignored';
}

async function findPaymentByReference(ctx: CoreContext, reference: unknown) {
  if (typeof reference !== 'string') return null;
  return ctx.prisma.payment.findUnique({
    where: { provider_reference: { provider: 'PAYSTACK', reference } },
    include: { application: true },
  });
}

async function createReviewTask(
  ctx: CoreContext,
  paymentMembershipId: string | undefined,
  reason: 'REFUND' | 'DISPUTE',
  detail: string,
) {
  if (!paymentMembershipId) return;
  await ctx.prisma.$transaction(async (tx) => {
    const m = await lockMembership(tx, paymentMembershipId);
    await openTaskIfAbsent(tx, m, 'REVIEW', reason, detail);
  });
}

/**
 * Refunds: record only what the provider confirms. Paid time is NOT changed automatically;
 * the creator/admin reviews it via a REVIEW task.
 */
async function applyRefundEvent(ctx: CoreContext, event: string, d: any): Promise<string> {
  const payment = await findPaymentByReference(ctx, d.transaction_reference);
  if (!payment) {
    await ctx.prisma.reconciliationIssue.create({
      data: { kind: 'REFUND', reference: String(d.transaction_reference ?? ''), details: { event, note: 'refund for unknown payment' } },
    });
    return 'unknown_payment';
  }
  let status: PaymentStatus | null = null;
  let refunded = payment.refundedAmountKobo;
  if (event === 'refund.processed') {
    const amt = Number.isInteger(d.refund_amount) ? d.refund_amount : payment.amountKobo;
    refunded = Math.min(payment.amountKobo, payment.refundedAmountKobo + amt);
    status = refunded >= payment.amountKobo ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
  } else if (event === 'refund.pending' || event === 'refund.processing') {
    if (payment.status === 'SUCCESS') status = 'REFUND_PENDING';
  } else if (event === 'refund.failed') {
    if (payment.status === 'REFUND_PENDING') status = 'SUCCESS';
  }
  if (status && status !== payment.status) {
    await ctx.prisma.payment.update({
      where: { id: payment.id },
      data: { status, refundedAmountKobo: refunded },
    });
  }
  await audit(ctx.prisma, {
    organizationId: payment.organizationId,
    actorType: 'PROVIDER',
    action: `payment.${event}`,
    entityType: 'Payment',
    entityId: payment.id,
    metadata: { providerStatus: d.status ?? null, refundedAmountKobo: refunded, newStatus: status },
  });
  if (event === 'refund.processed') {
    await ctx.prisma.reconciliationIssue.create({
      data: {
        organizationId: payment.organizationId,
        paymentId: payment.id,
        orderId: payment.orderId,
        reference: payment.reference,
        kind: 'REFUND',
        details: { event, refundedAmountKobo: refunded },
      },
    });
    await createReviewTask(ctx, payment.application?.membershipId, 'REFUND', `Refunded ${refunded} kobo — review paid time and group access`);
  }
  return `refund:${status ?? 'unchanged'}`;
}

async function applyDisputeEvent(ctx: CoreContext, event: string, d: any): Promise<string> {
  const payment = await findPaymentByReference(ctx, d.transaction_reference);
  if (!payment) {
    await ctx.prisma.reconciliationIssue.create({
      data: { kind: 'DISPUTE', reference: String(d.transaction_reference ?? ''), details: { event, note: 'dispute for unknown payment' } },
    });
    return 'unknown_payment';
  }
  if (event === 'charge.dispute.create' && payment.status === 'SUCCESS') {
    await ctx.prisma.payment.update({ where: { id: payment.id }, data: { status: 'DISPUTED' } });
  }
  await audit(ctx.prisma, {
    organizationId: payment.organizationId,
    actorType: 'PROVIDER',
    action: `payment.${event}`,
    entityType: 'Payment',
    entityId: payment.id,
    metadata: { providerStatus: d.dispute_status ?? null, resolution: d.resolution ?? null },
  });
  if (event === 'charge.dispute.create') {
    await ctx.prisma.reconciliationIssue.create({
      data: {
        organizationId: payment.organizationId,
        paymentId: payment.id,
        orderId: payment.orderId,
        reference: payment.reference,
        kind: 'DISPUTE',
        details: { event },
      },
    });
    await createReviewTask(ctx, payment.application?.membershipId, 'DISPUTE', 'Payment disputed — review with platform admin');
  }
  return `dispute:${event}`;
}

async function processWhatsappEvent(ctx: CoreContext, payload: any): Promise<string> {
  let statuses = 0;
  let optOuts = 0;
  for (const s of payload?.statuses ?? []) {
    await applyWhatsappStatus(ctx, s);
    statuses++;
  }
  for (const m of payload?.messages ?? []) {
    if (m.optOut && m.from) {
      const phone = normalizePhoneE164(`+${String(m.from).replace(/^\+/, '')}`);
      if (phone) {
        await withdrawWhatsappConsentByPhone(ctx, phone, 'whatsapp_stop_keyword');
        optOuts++;
      }
    }
  }
  return `statuses:${statuses},optouts:${optOuts}`;
}
