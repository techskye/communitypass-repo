import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { SUBSCRIPTION_TIERS, adminSubscriptionSchema, getSubscriptionAccess, paymentSetupSchema, resolveIssueSchema, saasBillingRecordSchema, subscriptionPaidThrough, whatsappTemplateSchema } from '@communitypass/shared';
import { adminAdjustSubscription, audit, CoreContext, DomainError, ensureSubscription, getOrgMetrics, NotFoundError, publicConfigSummary } from '@communitypass/core';
import { InjectCore, QueueService } from '../common/core';
import { PlatformAdminGuard, Staff, StaffContext } from '../common/auth';
import { ZodPipe } from '../common/http';

/** Platform administrator console. Controlled process for payment setup in V1. */
@UseGuards(PlatformAdminGuard)
@Controller('admin')
export class AdminController {
  constructor(
    @InjectCore() private readonly core: CoreContext,
    private readonly queues: QueueService,
  ) {}

  @Get('organizations')
  async organizations() {
    const orgs = await this.core.prisma.organization.findMany({
      include: {
        paymentConfig: { select: { status: true, subaccountCode: true, platformFeeBps: true, feeBearer: true } },
        _count: { select: { communities: true, memberships: true, staff: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return orgs;
  }

  @Get('organizations/:id')
  async organization(@Param('id') id: string) {
    const org = await this.core.prisma.organization.findUnique({
      where: { id },
      include: {
        paymentConfig: true,
        communities: { select: { id: true, name: true, slug: true, isPublished: true } },
        staff: { include: { user: { select: { name: true, email: true } } } },
        saasBilling: { orderBy: { periodStart: 'desc' } },
      },
    });
    if (!org) throw new NotFoundError('Organization');
    return { ...org, metrics: await getOrgMetrics(this.core, id) };
  }

  @Put('organizations/:id/payment-config')
  async setPaymentConfig(@Staff() s: StaffContext, @Param('id') id: string, @Body(new ZodPipe(paymentSetupSchema)) body: any) {
    const org = await this.core.prisma.organization.findUnique({ where: { id } });
    if (!org) throw new NotFoundError('Organization');
    if (org.isDemo && body.status === 'ACTIVE' && this.core.config.appMode === 'live') {
      throw new DomainError('DEMO_ORG', 'Demo organizations cannot be activated for live payments', 409);
    }
    const before = await this.core.prisma.organizationPaymentConfig.findUnique({ where: { organizationId: id } });
    const data = {
      subaccountCode: body.subaccountCode,
      settlementBankName: body.settlementBankName ?? null,
      accountNumberLast4: body.accountNumberLast4 ?? null,
      platformFeeBps: body.platformFeeBps,
      feeBearer: body.feeBearer,
      status: body.status,
      notes: body.notes ?? null,
      updatedByUserId: s.user.id,
      verifiedAt: body.status === 'ACTIVE' ? this.core.now() : null,
    };
    const pc = await this.core.prisma.organizationPaymentConfig.upsert({
      where: { organizationId: id },
      create: { organizationId: id, ...data },
      update: data,
    });
    await audit(this.core.prisma, {
      organizationId: id,
      actorType: 'ADMIN',
      actorId: s.user.id,
      action: 'payment_config.updated',
      entityType: 'OrganizationPaymentConfig',
      entityId: pc.id,
      metadata: {
        before: before ? { status: before.status, subaccountCode: before.subaccountCode, platformFeeBps: before.platformFeeBps, feeBearer: before.feeBearer } : null,
        after: { status: pc.status, subaccountCode: pc.subaccountCode, platformFeeBps: pc.platformFeeBps, feeBearer: pc.feeBearer },
      },
    });
    return pc;
  }

  @HttpCode(200)
  @Post('organizations/:id/status')
  async setStatus(@Staff() s: StaffContext, @Param('id') id: string, @Body(new ZodPipe(z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']) }))) body: { status: 'ACTIVE' | 'SUSPENDED' }) {
    await this.core.prisma.organization.update({ where: { id }, data: { status: body.status } });
    await audit(this.core.prisma, { organizationId: id, actorType: 'ADMIN', actorId: s.user.id, action: `organization.${body.status.toLowerCase()}`, entityType: 'Organization', entityId: id });
    return { ok: true };
  }

  /** Creator SaaS billing is recorded manually and never deducted from member payments. */
  @Post('organizations/:id/billing')
  async addBilling(@Staff() s: StaffContext, @Param('id') id: string, @Body(new ZodPipe(saasBillingRecordSchema)) body: any) {
    const r = await this.core.prisma.saasBillingRecord.create({ data: { ...body, organizationId: id, recordedByUserId: s.user.id } });
    await audit(this.core.prisma, { organizationId: id, actorType: 'ADMIN', actorId: s.user.id, action: 'saas_billing.recorded', entityType: 'SaasBillingRecord', entityId: r.id, metadata: { amountKobo: r.amountKobo, status: r.status } });
    return r;
  }

  /** Creator subscriptions: who is trialing, paying, overdue or paused, and expected monthly revenue. */
  @Get('billing')
  async billing() {
    const now = this.core.now();
    const orgs = await this.core.prisma.organization.findMany({
      select: { id: true, displayName: true, isDemo: true, status: true },
      orderBy: { createdAt: 'desc' },
    });
    const rows = [];
    let mrrKobo = 0;
    for (const o of orgs) {
      const sub = await ensureSubscription(this.core.prisma, o.id, now);
      const access = getSubscriptionAccess(sub, now);
      if (access === 'active' && sub.authorizationCode && !sub.cancelAtPeriodEnd) {
        mrrKobo += SUBSCRIPTION_TIERS[sub.pendingTier ?? sub.tier].priceKobo;
      }
      const lastInvoice = await this.core.prisma.subscriptionInvoice.findFirst({
        where: { organizationId: o.id },
        orderBy: { createdAt: 'desc' },
        select: { status: true, amountKobo: true, createdAt: true, failureReason: true },
      });
      rows.push({
        organization: o,
        tier: sub.tier,
        pendingTier: sub.pendingTier,
        access,
        paidThrough: subscriptionPaidThrough(sub),
        autoRenew: !!sub.authorizationCode && !sub.cancelAtPeriodEnd,
        failedAttempts: sub.failedAttempts,
        lastInvoice,
      });
    }
    const paid = await this.core.prisma.subscriptionInvoice.aggregate({
      where: { status: 'PAID', paidAt: { gte: new Date(now.getTime() - 30 * 86400000) } },
      _sum: { amountKobo: true },
      _count: true,
    });
    return { mrrKobo, collected30DaysKobo: paid._sum.amountKobo ?? 0, collected30DaysCount: paid._count, rows };
  }

  @HttpCode(200)
  @Post('organizations/:id/subscription')
  async adjustSubscription(@Staff() s: StaffContext, @Param('id') id: string, @Body(new ZodPipe(adminSubscriptionSchema)) body: any) {
    const org = await this.core.prisma.organization.findUnique({ where: { id } });
    if (!org) throw new NotFoundError('Organization');
    return adminAdjustSubscription(this.core, id, s.user.id, body);
  }

  @Get('integrations')
  async integrations() {
    const summary = publicConfigSummary(this.core.config);
    const now = this.core.now();
    const dayAgo = new Date(now.getTime() - 86400000);
    const [templates, unprocessed, lastPaystack, lastWhatsapp, failures24h, sent24h] = await Promise.all([
      this.core.prisma.whatsappTemplate.findMany({ orderBy: { purpose: 'asc' } }),
      this.core.prisma.providerEvent.count({ where: { processedAt: null } }),
      this.core.prisma.providerEvent.findFirst({ where: { source: 'PAYSTACK' }, orderBy: { receivedAt: 'desc' }, select: { receivedAt: true, eventType: true } }),
      this.core.prisma.providerEvent.findFirst({ where: { source: 'WHATSAPP' }, orderBy: { receivedAt: 'desc' }, select: { receivedAt: true } }),
      this.core.prisma.notification.groupBy({ by: ['channel'], where: { status: { in: ['FAILED', 'NEEDS_REVIEW'] }, updatedAt: { gte: dayAgo } }, _count: true }),
      this.core.prisma.notification.groupBy({ by: ['channel'], where: { sentAt: { gte: dayAgo } }, _count: true }),
    ]);
    let redis: 'ok' | 'unreachable' | 'disabled' = 'disabled';
    if (this.queues.enabled) {
      const jobs = await this.queues.failedJobs(1);
      redis = jobs.some((j) => j.name === 'redis-unavailable') ? 'unreachable' : 'ok';
    }
    return { config: summary, templates, unprocessedEvents: unprocessed, lastPaystackEvent: lastPaystack, lastWhatsappEvent: lastWhatsapp, failures24h, sent24h, redis };
  }

  @Put('templates')
  async upsertTemplate(@Staff() s: StaffContext, @Body(new ZodPipe(whatsappTemplateSchema)) body: any) {
    const t = await this.core.prisma.whatsappTemplate.upsert({
      where: { purpose_language: { purpose: body.purpose, language: body.language } },
      create: body,
      update: { name: body.name, category: body.category, status: body.status },
    });
    await audit(this.core.prisma, { actorType: 'ADMIN', actorId: s.user.id, action: 'whatsapp_template.updated', entityType: 'WhatsappTemplate', entityId: t.id, metadata: body });
    return t;
  }

  @Get('jobs')
  async jobs() {
    const [queueFailures, notifications, events] = await Promise.all([
      this.queues.failedJobs(50),
      this.core.prisma.notification.findMany({
        where: { status: { in: ['FAILED', 'NEEDS_REVIEW'] } },
        select: { id: true, organizationId: true, channel: true, type: true, status: true, lastError: true, attemptCount: true, updatedAt: true },
        orderBy: { updatedAt: 'desc' },
        take: 100,
      }),
      this.core.prisma.providerEvent.findMany({
        where: { processedAt: null },
        select: { id: true, source: true, eventType: true, attempts: true, processingError: true, receivedAt: true },
        orderBy: { receivedAt: 'desc' },
        take: 100,
      }),
    ]);
    return { queueFailures, notifications, unprocessedEvents: events };
  }

  @HttpCode(200)
  @Post('jobs/:queue/:id/retry')
  async retryJob(@Staff() s: StaffContext, @Param('queue') queue: string, @Param('id') id: string) {
    const ok = await this.queues.retryFailed(queue, id);
    if (!ok) throw new NotFoundError('Job');
    await audit(this.core.prisma, { actorType: 'ADMIN', actorId: s.user.id, action: 'job.retried', entityType: 'Job', entityId: `${queue}:${id}` });
    return { ok: true };
  }

  @Get('reconciliation')
  reconciliation(@Query('status') status?: string) {
    return this.core.prisma.reconciliationIssue.findMany({
      where: { status: status === 'RESOLVED' ? 'RESOLVED' : 'OPEN' },
      include: { organization: { select: { displayName: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  @HttpCode(200)
  @Post('reconciliation/:id/resolve')
  async resolve(@Staff() s: StaffContext, @Param('id') id: string, @Body(new ZodPipe(resolveIssueSchema)) body: { resolution: string }) {
    const issue = await this.core.prisma.reconciliationIssue.findUnique({ where: { id } });
    if (!issue) throw new NotFoundError('Issue');
    await this.core.prisma.reconciliationIssue.update({
      where: { id },
      data: { status: 'RESOLVED', resolution: body.resolution, resolvedByUserId: s.user.id, resolvedAt: this.core.now() },
    });
    await audit(this.core.prisma, { organizationId: issue.organizationId, actorType: 'ADMIN', actorId: s.user.id, action: 'reconciliation.resolved', entityType: 'ReconciliationIssue', entityId: id, metadata: { resolution: body.resolution } });
    return { ok: true };
  }

  @Get('audit')
  auditLog(@Query('organizationId') organizationId?: string, @Query('action') action?: string) {
    return this.core.prisma.auditLog.findMany({
      where: {
        ...(organizationId ? { organizationId } : {}),
        ...(action ? { action: { contains: action } } : {}),
      },
      include: { organization: { select: { displayName: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  /** Demo mode: what the mock adapters "sent". */
  @Get('demo-outbox')
  async demoOutbox() {
    if (this.core.config.appMode !== 'demo') return [];
    return this.core.prisma.demoOutboxMessage.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
  }
}
