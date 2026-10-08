import { Body, Controller, Get, Header, HttpCode, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import {
  getEntitlement,
  graceEndsAt,
  taskCompleteSchema,
  taskDismissSchema,
  taskNoteSchema,
  toCsv,
} from '@communitypass/shared';
import {
  addTaskNote,
  audit,
  completeTask,
  CoreContext,
  dismissTask,
  NotFoundError,
  reopenTask,
  retryNotification,
} from '@communitypass/core';
import type { Prisma } from '@communitypass/core';
import { InjectCore, QueueService } from '../common/core';
import { OrgId, Roles, Staff, StaffContext, StaffGuard } from '../common/auth';
import { ZodPipe } from '../common/http';

const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.string().max(30).optional(),
  type: z.string().max(30).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});
const PAGE_SIZE = 50;

@UseGuards(StaffGuard)
@Controller('org')
export class OperationsController {
  constructor(
    @InjectCore() private readonly core: CoreContext,
    private readonly queues: QueueService,
  ) {}

  // ───────────── Members ─────────────

  private async memberRows(orgId: string, q: z.infer<typeof listQuery>, all = false) {
    const now = this.core.now();
    const where: Prisma.MembershipWhereInput = { organizationId: orgId };
    if (q.q) {
      where.member = {
        OR: [
          { fullName: { contains: q.q, mode: 'insensitive' } },
          { email: { contains: q.q, mode: 'insensitive' } },
          { phoneE164: { contains: q.q.replace(/\s/g, '') } },
        ],
      };
    }
    const rows = await this.core.prisma.membership.findMany({
      where,
      include: {
        member: { select: { id: true, fullName: true, email: true, phoneE164: true } },
        community: { select: { id: true, name: true, gracePeriodDays: true } },
        plan: { select: { name: true, durationDays: true } },
      },
      orderBy: { paidUntil: 'asc' },
      take: all ? 10_000 : 1000,
    });
    const mapped = rows.map((m) => {
      const ent = getEntitlement(m.paidUntil, m.community.gracePeriodDays, now);
      const expiringSoon = ent === 'active' && !!m.paidUntil && m.paidUntil.getTime() - now.getTime() <= 7 * 86400000;
      return {
        membershipId: m.id,
        memberId: m.member.id,
        name: m.member.fullName,
        email: m.member.email,
        phone: m.member.phoneE164,
        community: m.community.name,
        plan: m.plan.name,
        durationDays: m.plan.durationDays,
        paidUntil: m.paidUntil,
        graceEndsAt: m.paidUntil && m.community.gracePeriodDays ? graceEndsAt(m.paidUntil, m.community.gracePeriodDays) : null,
        entitlement: ent,
        expiringSoon,
        accessStatus: m.accessStatus,
        cancelled: !!m.cancelledAt,
      };
    });
    const filtered = q.status
      ? mapped.filter((r) => (q.status === 'expiring' ? r.expiringSoon : r.entitlement === q.status))
      : mapped;
    return filtered;
  }

  @Get('members')
  async members(@OrgId() orgId: string, @Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    const rows = await this.memberRows(orgId, q);
    const start = (q.page - 1) * PAGE_SIZE;
    return { total: rows.length, page: q.page, pageSize: PAGE_SIZE, items: rows.slice(start, start + PAGE_SIZE) };
  }

  @Get('members.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async membersCsv(@OrgId() orgId: string, @Staff() s: StaffContext, @Res({ passthrough: true }) res: Response) {
    const rows = await this.memberRows(orgId, { page: 1 }, true);
    res.setHeader('Content-Disposition', 'attachment; filename="members.csv"');
    await audit(this.core.prisma, { organizationId: orgId, actorType: 'USER', actorId: s.user.id, action: 'export.members', entityType: 'Organization', entityId: orgId, metadata: { rows: rows.length } });
    return toCsv(
      ['Name', 'Email', 'WhatsApp phone', 'Community', 'Plan', 'Paid until (UTC)', 'Status', 'Group access (creator confirmed)', 'Cancelled renewal'],
      rows.map((r) => [r.name, r.email, r.phone, r.community, r.plan, r.paidUntil, r.entitlement, r.accessStatus, r.cancelled ? 'yes' : 'no']),
    );
  }

  @Get('members/:memberId')
  async member(@OrgId() orgId: string, @Param('memberId') memberId: string) {
    const now = this.core.now();
    const m = await this.core.prisma.member.findFirst({
      where: { id: memberId, organizationId: orgId },
      include: {
        memberships: {
          include: {
            community: { select: { name: true, gracePeriodDays: true } },
            plan: { select: { name: true, durationDays: true } },
            applications: { orderBy: { createdAt: 'desc' }, include: { payment: { select: { reference: true, amountKobo: true, status: true, paidAt: true, provider: true, isLive: true } } } },
          },
        },
        orders: { orderBy: { createdAt: 'desc' }, take: 50, include: { payment: { select: { status: true, isLive: true } } } },
        consents: true,
        accessTasks: { orderBy: { createdAt: 'desc' }, take: 50 },
        notifications: { orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, channel: true, type: true, status: true, scheduledFor: true, sentAt: true, suppressedReason: true, lastError: true } },
      },
    });
    if (!m) throw new NotFoundError('Member');
    return {
      ...m,
      memberships: m.memberships.map((ms) => ({
        ...ms,
        entitlement: getEntitlement(ms.paidUntil, ms.community.gracePeriodDays, now),
      })),
    };
  }

  // ───────────── Payments ─────────────

  @Get('payments')
  async payments(@OrgId() orgId: string, @Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    const where: Prisma.OrderWhereInput = { organizationId: orgId };
    if (q.status) where.status = q.status as any;
    if (q.q) where.OR = [{ reference: { contains: q.q.toUpperCase() } }, { member: { email: { contains: q.q, mode: 'insensitive' } } }];
    const [total, items] = await Promise.all([
      this.core.prisma.order.count({ where }),
      this.core.prisma.order.findMany({
        where,
        include: { member: { select: { fullName: true, email: true } }, payment: true, application: { select: { newPaidUntil: true, previousPaidUntil: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
    ]);
    return { total, page: q.page, pageSize: PAGE_SIZE, items };
  }

  @Get('payments.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async paymentsCsv(@OrgId() orgId: string, @Staff() s: StaffContext, @Res({ passthrough: true }) res: Response) {
    const rows = await this.core.prisma.payment.findMany({
      where: { organizationId: orgId },
      include: { order: { include: { member: { select: { fullName: true, email: true } } } } },
      orderBy: { paidAt: 'desc' },
      take: 10_000,
    });
    res.setHeader('Content-Disposition', 'attachment; filename="payments.csv"');
    await audit(this.core.prisma, { organizationId: orgId, actorType: 'USER', actorId: s.user.id, action: 'export.payments', entityType: 'Organization', entityId: orgId, metadata: { rows: rows.length } });
    return toCsv(
      ['Reference', 'Paid at (UTC)', 'Member', 'Email', 'Community', 'Plan', 'Amount (NGN)', 'Refunded (NGN)', 'Status', 'Provider', 'Live'],
      rows.map((p) => [
        p.reference,
        p.paidAt,
        p.order.member.fullName,
        p.order.member.email,
        p.order.communityNameSnapshot,
        p.order.planNameSnapshot,
        (p.amountKobo / 100).toFixed(2),
        (p.refundedAmountKobo / 100).toFixed(2),
        p.status,
        p.provider,
        p.isLive ? 'yes' : 'no (demo/test)',
      ]),
    );
  }

  // ───────────── Access tasks ─────────────

  @Get('tasks')
  async tasks(@OrgId() orgId: string, @Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    const now = this.core.now();
    const where: Prisma.AccessTaskWhereInput = { organizationId: orgId, status: (q.status as any) ?? 'OPEN' };
    if (q.type) where.type = q.type as any;
    const [total, items] = await Promise.all([
      this.core.prisma.accessTask.count({ where }),
      this.core.prisma.accessTask.findMany({
        where,
        include: {
          member: { select: { id: true, fullName: true, phoneE164: true, email: true } },
          community: { select: { name: true, gracePeriodDays: true } },
          membership: { select: { paidUntil: true, accessStatus: true } },
          notes: { orderBy: { createdAt: 'asc' } },
        },
        orderBy: { createdAt: 'asc' },
        skip: (q.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
    ]);
    return {
      total,
      page: q.page,
      pageSize: PAGE_SIZE,
      items: items.map((t) => ({
        ...t,
        entitlement: getEntitlement(t.membership.paidUntil, t.community.gracePeriodDays, now),
      })),
    };
  }

  @HttpCode(200)
  @Post('tasks/:id/complete')
  complete(@OrgId() orgId: string, @Staff() s: StaffContext, @Param('id') id: string, @Body(new ZodPipe(taskCompleteSchema)) body: { note?: string }) {
    return completeTask(this.core, { organizationId: orgId, userId: s.user.id }, id, body.note);
  }

  @HttpCode(200)
  @Post('tasks/:id/dismiss')
  async dismiss(@OrgId() orgId: string, @Staff() s: StaffContext, @Param('id') id: string, @Body(new ZodPipe(taskDismissSchema)) body: { reason: string }) {
    await dismissTask(this.core, { organizationId: orgId, userId: s.user.id }, id, body.reason);
    return { ok: true };
  }

  @HttpCode(200)
  @Post('tasks/:id/reopen')
  async reopen(@OrgId() orgId: string, @Staff() s: StaffContext, @Param('id') id: string) {
    await reopenTask(this.core, { organizationId: orgId, userId: s.user.id }, id);
    return { ok: true };
  }

  @Post('tasks/:id/notes')
  note(@OrgId() orgId: string, @Staff() s: StaffContext, @Param('id') id: string, @Body(new ZodPipe(taskNoteSchema)) body: { note: string }) {
    return addTaskNote(this.core, { organizationId: orgId, userId: s.user.id }, id, body.note);
  }

  // ───────────── Message delivery history ─────────────

  @Get('notifications')
  async notifications(@OrgId() orgId: string, @Query(new ZodPipe(listQuery)) q: z.infer<typeof listQuery>) {
    const where: Prisma.NotificationWhereInput = { organizationId: orgId };
    if (q.status) where.status = q.status as any;
    if (q.type) where.channel = q.type as any;
    const [total, items] = await Promise.all([
      this.core.prisma.notification.count({ where }),
      this.core.prisma.notification.findMany({
        where,
        select: {
          id: true, channel: true, type: true, reminderKey: true, status: true, scheduledFor: true, sentAt: true,
          deliveredAt: true, readAt: true, attemptCount: true, lastError: true, suppressedReason: true, createdAt: true,
          member: { select: { id: true, fullName: true } },
          membership: { select: { community: { select: { name: true } } } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
    ]);
    return { total, page: q.page, pageSize: PAGE_SIZE, items };
  }

  /** Re-send only after the creator has checked the member did not receive it. */
  @Roles('OWNER')
  @HttpCode(200)
  @Post('notifications/:id/retry')
  async retry(@OrgId() orgId: string, @Staff() s: StaffContext, @Param('id') id: string) {
    const ok = await retryNotification(this.core, orgId, id, s.user.id);
    if (!ok) throw new NotFoundError('Retryable notification');
    await this.queues.enqueueNotifications([id]).catch(() => undefined);
    return { ok: true };
  }
}
