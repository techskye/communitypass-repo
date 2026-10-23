import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  communityInputSchema,
  communityUpdateSchema,
  MAX_IMAGE_UPLOAD_BYTES,
  onboardingSchema,
  orgProfileSchema,
  planInputSchema,
  planUpdateSchema,
  reminderSettingsSchema,
  staffInviteSchema,
} from '@communitypass/shared';
import {
  assertCanAddCommunity,
  audit,
  completeOnboarding,
  CoreContext,
  createStaffInvite,
  DomainError,
  getOrgMetrics,
  getPaymentReadiness,
  isUniqueViolation,
  NotFoundError,
  publicConfigSummary,
} from '@communitypass/core';
import { InjectCore } from '../common/core';
import { NoOrgRequired, OrgId, Roles, Staff, StaffContext, StaffGuard } from '../common/auth';
import { ZodPipe } from '../common/http';

/** Detects image type from magic bytes (never trust the client-declared MIME type). */
export function sniffImage(buf: Buffer): { ext: string; mime: string } | null {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png', mime: 'image/png' };
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf.length > 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  return null;
}

@UseGuards(StaffGuard)
@Controller('org')
export class OrgController {
  constructor(@InjectCore() private readonly core: CoreContext) {}

  @NoOrgRequired()
  @Post('onboarding')
  async onboarding(@Staff() staff: StaffContext, @Body(new ZodPipe(onboardingSchema)) body: any) {
    if (staff.organizationId) {
      throw new DomainError('ALREADY_ONBOARDED', 'You already belong to an organization', 409);
    }
    const r = await completeOnboarding(this.core, staff.user.id, body);
    await this.core.prisma.session.update({ where: { id: staff.session.id }, data: { activeOrganizationId: r.organization.id } });
    return { organizationId: r.organization.id, communityId: r.community.id, slug: r.community.slug };
  }

  @Get('dashboard')
  async dashboard(@OrgId() orgId: string) {
    const [org, metrics, readiness, communities] = await Promise.all([
      this.core.prisma.organization.findUniqueOrThrow({
        where: { id: orgId },
        select: { id: true, name: true, displayName: true, supportEmail: true, supportWhatsapp: true, isDemo: true, status: true, timezone: true },
      }),
      getOrgMetrics(this.core, orgId),
      getPaymentReadiness(this.core, orgId),
      this.core.prisma.community.findMany({ where: { organizationId: orgId }, select: { id: true, name: true, slug: true } }),
    ]);
    return { organization: org, metrics, payments: readiness, communities };
  }

  @Get('profile')
  profile(@OrgId() orgId: string) {
    return this.core.prisma.organization.findUniqueOrThrow({
      where: { id: orgId },
      select: { name: true, displayName: true, supportEmail: true, supportWhatsapp: true, timezone: true },
    });
  }

  @Roles('OWNER')
  @Put('profile')
  async updateProfile(@OrgId() orgId: string, @Staff() s: StaffContext, @Body(new ZodPipe(orgProfileSchema)) body: any) {
    await this.core.prisma.organization.update({
      where: { id: orgId },
      data: { ...body, supportWhatsapp: body.supportWhatsapp || null },
    });
    await audit(this.core.prisma, { organizationId: orgId, actorType: 'USER', actorId: s.user.id, action: 'organization.profile_updated', entityType: 'Organization', entityId: orgId });
    return { ok: true };
  }

  // ───────────── Communities ─────────────

  @Get('communities')
  communities(@OrgId() orgId: string) {
    return this.core.prisma.community.findMany({
      where: { organizationId: orgId },
      include: { plans: { orderBy: { durationDays: 'asc' } }, _count: { select: { memberships: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  @Get('communities/:id')
  async community(@OrgId() orgId: string, @Param('id') id: string) {
    const c = await this.core.prisma.community.findFirst({
      where: { id, organizationId: orgId },
      include: { plans: { orderBy: { durationDays: 'asc' } } },
    });
    if (!c) throw new NotFoundError('Community');
    return c;
  }

  @Roles('OWNER')
  @Post('communities')
  async createCommunity(@OrgId() orgId: string, @Staff() s: StaffContext, @Body(new ZodPipe(communityInputSchema)) body: any) {
    await assertCanAddCommunity(this.core, orgId);
    try {
      const c = await this.core.prisma.community.create({ data: { ...body, organizationId: orgId } });
      await audit(this.core.prisma, { organizationId: orgId, actorType: 'USER', actorId: s.user.id, action: 'community.created', entityType: 'Community', entityId: c.id });
      return c;
    } catch (e) {
      if (isUniqueViolation(e)) throw new DomainError('SLUG_TAKEN', 'That community link is already taken', 409);
      throw e;
    }
  }

  @Roles('OWNER')
  @Put('communities/:id')
  async updateCommunity(@OrgId() orgId: string, @Staff() s: StaffContext, @Param('id') id: string, @Body(new ZodPipe(communityUpdateSchema)) body: any) {
    const existing = await this.core.prisma.community.findFirst({ where: { id, organizationId: orgId } });
    if (!existing) throw new NotFoundError('Community');
    const inviteChanged = body.whatsappInviteUrl && body.whatsappInviteUrl !== existing.whatsappInviteUrl;
    try {
      const c = await this.core.prisma.community.update({
        where: { id },
        data: { ...body, ...(inviteChanged ? { inviteUrlUpdatedAt: this.core.now() } : {}) },
      });
      await audit(this.core.prisma, {
        organizationId: orgId,
        actorType: 'USER',
        actorId: s.user.id,
        action: inviteChanged ? 'community.invite_link_updated' : 'community.updated',
        entityType: 'Community',
        entityId: id,
        metadata: { fields: Object.keys(body).filter((k) => k !== 'whatsappInviteUrl') },
      });
      return c;
    } catch (e) {
      if (isUniqueViolation(e)) throw new DomainError('SLUG_TAKEN', 'That community link is already taken', 409);
      throw e;
    }
  }

  // ───────────── Plans ─────────────

  @Get('plans')
  plans(@OrgId() orgId: string) {
    return this.core.prisma.plan.findMany({
      where: { organizationId: orgId },
      include: { community: { select: { id: true, name: true, slug: true } }, _count: { select: { memberships: true } } },
      orderBy: [{ communityId: 'asc' }, { durationDays: 'asc' }],
    });
  }

  @Roles('OWNER')
  @Post('communities/:id/plans')
  async createPlan(@OrgId() orgId: string, @Staff() s: StaffContext, @Param('id') communityId: string, @Body(new ZodPipe(planInputSchema)) body: any) {
    const c = await this.core.prisma.community.findFirst({ where: { id: communityId, organizationId: orgId } });
    if (!c) throw new NotFoundError('Community');
    const p = await this.core.prisma.plan.create({
      data: { organizationId: orgId, communityId, currency: 'NGN', name: body.name, description: body.description ?? null, priceKobo: body.priceKobo, durationDays: body.durationDays },
    });
    await audit(this.core.prisma, { organizationId: orgId, actorType: 'USER', actorId: s.user.id, action: 'plan.created', entityType: 'Plan', entityId: p.id, metadata: { priceKobo: p.priceKobo, durationDays: p.durationDays } });
    return p;
  }

  /** Plan edits affect future checkouts only — orders keep their snapshots. */
  @Roles('OWNER')
  @Put('plans/:id')
  async updatePlan(
    @OrgId() orgId: string,
    @Staff() s: StaffContext,
    @Param('id') id: string,
    @Body(new ZodPipe(planUpdateSchema)) body: any,
  ) {
    const plan = await this.core.prisma.plan.findFirst({ where: { id, organizationId: orgId } });
    if (!plan) throw new NotFoundError('Plan');
    const data: Record<string, unknown> = {};
    for (const k of ['name', 'description', 'priceKobo', 'durationDays'] as const) if (body[k] !== undefined) data[k] = body[k];
    if (typeof body.isActive === 'boolean') data.isActive = body.isActive;
    const updated = await this.core.prisma.plan.update({ where: { id }, data });
    await audit(this.core.prisma, { organizationId: orgId, actorType: 'USER', actorId: s.user.id, action: 'plan.updated', entityType: 'Plan', entityId: id, metadata: { before: { priceKobo: plan.priceKobo, durationDays: plan.durationDays, isActive: plan.isActive }, after: data } });
    return updated;
  }

  // ───────────── Reminder settings ─────────────

  @Get('reminder-settings')
  async reminderSettings(@OrgId() orgId: string) {
    return this.core.prisma.reminderSettings.upsert({ where: { organizationId: orgId }, create: { organizationId: orgId }, update: {} });
  }

  @Roles('OWNER')
  @Put('reminder-settings')
  async updateReminderSettings(@OrgId() orgId: string, @Staff() s: StaffContext, @Body(new ZodPipe(reminderSettingsSchema)) body: any) {
    const r = await this.core.prisma.reminderSettings.upsert({
      where: { organizationId: orgId },
      create: { organizationId: orgId, ...body },
      update: body,
    });
    await audit(this.core.prisma, { organizationId: orgId, actorType: 'USER', actorId: s.user.id, action: 'reminder_settings.updated', entityType: 'ReminderSettings', entityId: r.id });
    return r;
  }

  // ───────────── Staff ─────────────

  @Get('staff')
  async staff(@OrgId() orgId: string) {
    const [members, invites] = await Promise.all([
      this.core.prisma.organizationStaff.findMany({
        where: { organizationId: orgId },
        include: { user: { select: { id: true, name: true, email: true } } },
        orderBy: { createdAt: 'asc' },
      }),
      this.core.prisma.staffInvite.findMany({
        where: { organizationId: orgId, acceptedAt: null, revokedAt: null, expiresAt: { gt: this.core.now() } },
        select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
      }),
    ]);
    return { members: members.map((m) => ({ ...m.user, role: m.role, since: m.createdAt })), invites };
  }

  @Roles('OWNER')
  @Post('staff/invite')
  async invite(@OrgId() orgId: string, @Staff() s: StaffContext, @Body(new ZodPipe(staffInviteSchema)) body: any) {
    const inv = await createStaffInvite(this.core, { organizationId: orgId, email: body.email, role: body.role, invitedByUserId: s.user.id });
    return { id: inv.id, email: inv.email, role: inv.role, expiresAt: inv.expiresAt };
  }

  @Roles('OWNER')
  @Delete('staff/invites/:id')
  async revokeInvite(@OrgId() orgId: string, @Staff() s: StaffContext, @Param('id') id: string) {
    const r = await this.core.prisma.staffInvite.updateMany({ where: { id, organizationId: orgId, acceptedAt: null }, data: { revokedAt: this.core.now() } });
    if (!r.count) throw new NotFoundError('Invite');
    await audit(this.core.prisma, { organizationId: orgId, actorType: 'USER', actorId: s.user.id, action: 'staff.invite_revoked', entityType: 'StaffInvite', entityId: id });
    return { ok: true };
  }

  @Roles('OWNER')
  @Delete('staff/:userId')
  async removeStaff(@OrgId() orgId: string, @Staff() s: StaffContext, @Param('userId') userId: string) {
    if (userId === s.user.id) throw new DomainError('CANNOT_REMOVE_SELF', 'You cannot remove yourself', 400);
    const link = await this.core.prisma.organizationStaff.findUnique({ where: { organizationId_userId: { organizationId: orgId, userId } } });
    if (!link) throw new NotFoundError('Staff member');
    await this.core.prisma.organizationStaff.delete({ where: { id: link.id } });
    await this.core.prisma.session.updateMany({ where: { userId, activeOrganizationId: orgId }, data: { activeOrganizationId: null } });
    await audit(this.core.prisma, { organizationId: orgId, actorType: 'USER', actorId: s.user.id, action: 'staff.removed', entityType: 'OrganizationStaff', entityId: userId });
    return { ok: true };
  }

  // ───────────── Integrations (read-only for creators; no secrets) ─────────────

  @Get('integrations')
  async integrations(@OrgId() orgId: string) {
    const [pc, readiness, templates] = await Promise.all([
      this.core.prisma.organizationPaymentConfig.findUnique({ where: { organizationId: orgId } }),
      getPaymentReadiness(this.core, orgId),
      this.core.prisma.whatsappTemplate.findMany({ select: { purpose: true, name: true, language: true, status: true, category: true } }),
    ]);
    const summary = publicConfigSummary(this.core.config);
    return {
      appMode: summary.appMode,
      payments: {
        provider: 'Paystack',
        setupStatus: pc?.status ?? 'NOT_CONFIGURED',
        subaccountConfigured: !!pc?.subaccountCode,
        subaccountCodeMasked: pc?.subaccountCode ? `${pc.subaccountCode.slice(0, 7)}…${pc.subaccountCode.slice(-3)}` : null,
        settlementBankName: pc?.settlementBankName ?? null,
        accountNumberLast4: pc?.accountNumberLast4 ?? null,
        platformFeePercent: pc ? pc.platformFeeBps / 100 : 0,
        feeBearer: pc?.feeBearer ?? null,
        checkoutReady: readiness.ready,
        checkoutBlockedReason: readiness.ready ? null : readiness.reason,
      },
      whatsapp: { ...summary.whatsapp, templates },
      email: { enabled: summary.email.enabled, configured: summary.email.configured },
    };
  }

  // ───────────── Uploads ─────────────

  /** Image uploads (community picture). Allowed during onboarding; owner-only once an org exists. */
  @NoOrgRequired()
  @Post('uploads')
  @HttpCode(201)
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MAX_IMAGE_UPLOAD_BYTES, files: 1 } }))
  async upload(@Staff() staff: StaffContext, @UploadedFile() file?: Express.Multer.File) {
    if (staff.organizationId && staff.role !== 'OWNER') {
      throw new DomainError('FORBIDDEN', 'Only the organization owner can upload images', 403);
    }
    const ownerKey = staff.organizationId ?? staff.user.id;
    if (!file) throw new BadRequestException({ code: 'NO_FILE', message: 'Choose an image to upload' });
    const kind = sniffImage(file.buffer);
    if (!kind) throw new BadRequestException({ code: 'BAD_FILE_TYPE', message: 'Only PNG, JPEG or WebP images are allowed' });
    const name = `${ownerKey.slice(-6).toLowerCase()}-${randomBytes(12).toString('hex')}.${kind.ext}`;
    const dir = path.resolve(this.core.config.uploadDir);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, name), file.buffer, { mode: 0o640 });
    return { url: `/api/uploads/${name}` };
  }
}
