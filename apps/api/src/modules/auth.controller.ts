import { Body, Controller, ForbiddenException, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import {
  acceptInviteSchema,
  creatorSignupSchema,
  loginSchema,
  magicLinkRequestSchema,
  magicLinkVerifySchema,
  MEMBER_SESSION_TTL_MS,
  STAFF_SESSION_TTL_MS,
  switchOrgSchema,
} from '@communitypass/shared';
import {
  acceptStaffInvite,
  audit,
  consumeMagicLink,
  CoreContext,
  createSession,
  destroySession,
  loginStaff,
  publicConfigSummary,
  randomToken,
  requestMagicLink,
  sha256Hex,
  signupCreator,
} from '@communitypass/core';
import { InjectCore } from '../common/core';
import { Member, MemberContext, MemberGuard, NoOrgRequired, Staff, StaffContext, StaffGuard } from '../common/auth';
import { cookieOptions, issueCsrfCookie, MEMBER_COOKIE, STAFF_COOKIE, ZodPipe } from '../common/http';

@Controller()
export class AuthController {
  constructor(@InjectCore() private readonly core: CoreContext) {}

  @Get('health')
  health() {
    return { ok: true };
  }

  /** Public, non-secret runtime info (used for the demo banner). */
  @Get('public/config')
  config() {
    const s = publicConfigSummary(this.core.config);
    return { appMode: s.appMode, paymentsLive: s.paystack.liveMode && s.appMode === 'live' };
  }

  @Get('auth/csrf')
  csrf(@Res({ passthrough: true }) res: Response) {
    return { csrfToken: issueCsrfCookie(this.core, res) };
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('auth/signup')
  async signup(@Body(new ZodPipe(creatorSignupSchema)) body: any, @Res({ passthrough: true }) res: Response) {
    const user = await signupCreator(this.core, body);
    const { token } = await createSession(this.core, { kind: 'STAFF', userId: user.id });
    res.cookie(STAFF_COOKIE, token, cookieOptions(this.core, STAFF_SESSION_TTL_MS));
    issueCsrfCookie(this.core, res);
    return { id: user.id, email: user.email, name: user.name };
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('auth/login')
  async login(@Body(new ZodPipe(loginSchema)) body: any, @Res({ passthrough: true }) res: Response) {
    const user = await loginStaff(this.core, body.email, body.password);
    const { token } = await createSession(this.core, { kind: 'STAFF', userId: user.id });
    res.cookie(STAFF_COOKIE, token, cookieOptions(this.core, STAFF_SESSION_TTL_MS));
    issueCsrfCookie(this.core, res);
    await audit(this.core.prisma, { actorType: 'USER', actorId: user.id, action: 'user.login', entityType: 'User', entityId: user.id });
    return { id: user.id, isPlatformAdmin: user.isPlatformAdmin };
  }

  @HttpCode(200)
  @Post('auth/logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await destroySession(this.core, req.cookies?.[STAFF_COOKIE]);
    res.clearCookie(STAFF_COOKIE, { path: '/' });
    return { ok: true };
  }

  @UseGuards(StaffGuard)
  @NoOrgRequired()
  @Get('auth/me')
  async me(@Staff() staff: StaffContext) {
    const orgs = await this.core.prisma.organizationStaff.findMany({
      where: { userId: staff.user.id },
      include: { organization: { select: { id: true, displayName: true, isDemo: true, status: true } } },
    });
    return {
      user: { id: staff.user.id, name: staff.user.name, email: staff.user.email, isPlatformAdmin: staff.user.isPlatformAdmin },
      activeOrganizationId: staff.organizationId,
      role: staff.role,
      organizations: orgs.map((o) => ({ ...o.organization, role: o.role })),
    };
  }

  @UseGuards(StaffGuard)
  @NoOrgRequired()
  @HttpCode(200)
  @Post('auth/switch-org')
  async switchOrg(@Staff() staff: StaffContext, @Body(new ZodPipe(switchOrgSchema)) body: { organizationId: string }) {
    // The requested org is accepted only if the server confirms staff membership.
    const link = await this.core.prisma.organizationStaff.findUnique({
      where: { organizationId_userId: { organizationId: body.organizationId, userId: staff.user.id } },
    });
    if (!link) throw new ForbiddenException('You are not a member of that organization');
    await this.core.prisma.session.update({ where: { id: staff.session.id }, data: { activeOrganizationId: link.organizationId } });
    return { ok: true };
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('auth/accept-invite')
  async acceptInvite(@Body(new ZodPipe(acceptInviteSchema)) body: any, @Res({ passthrough: true }) res: Response) {
    const { user, organizationId } = await acceptStaffInvite(this.core, body);
    const { token } = await createSession(this.core, { kind: 'STAFF', userId: user.id, activeOrganizationId: organizationId });
    res.cookie(STAFF_COOKIE, token, cookieOptions(this.core, STAFF_SESSION_TTL_MS));
    issueCsrfCookie(this.core, res);
    return { ok: true };
  }

  // ───────────── Members (magic link) ─────────────

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(200)
  @Post('member/auth/magic-link')
  async magicLink(@Body(new ZodPipe(magicLinkRequestSchema)) body: { email: string }) {
    if (this.core.config.appMode === 'demo') {
      // DEMO MODE ONLY: no email is really sent, so hand back a one-time link for the demo.
      const account = await this.core.prisma.memberAccount.findUnique({ where: { email: body.email } });
      if (account) {
        const token = randomToken(32);
        await this.core.prisma.magicLinkToken.create({
          data: { memberAccountId: account.id, tokenHash: sha256Hex(token), expiresAt: new Date(this.core.now().getTime() + 15 * 60_000) },
        });
        return { ok: true, demoLink: `${this.core.config.webBaseUrl}/member/verify#token=${token}` };
      }
      return { ok: true };
    }
    await requestMagicLink(this.core, body.email);
    // Same response whether or not the email exists.
    return { ok: true };
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('member/auth/verify')
  async verify(@Body(new ZodPipe(magicLinkVerifySchema)) body: { token: string }, @Res({ passthrough: true }) res: Response) {
    const { token } = await consumeMagicLink(this.core, body.token);
    res.cookie(MEMBER_COOKIE, token, cookieOptions(this.core, MEMBER_SESSION_TTL_MS));
    issueCsrfCookie(this.core, res);
    return { ok: true };
  }

  @HttpCode(200)
  @Post('member/auth/logout')
  async memberLogout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await destroySession(this.core, req.cookies?.[MEMBER_COOKIE]);
    res.clearCookie(MEMBER_COOKIE, { path: '/' });
    return { ok: true };
  }

  @UseGuards(MemberGuard)
  @Get('member/me')
  memberMe(@Member() m: MemberContext) {
    return { email: m.email };
  }
}
