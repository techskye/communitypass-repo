import { Body, Controller, Get, HttpCode, Param, Post, Put, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { memberPreferencesSchema, membershipCancelSchema } from '@communitypass/shared';
import {
  cancelMyMembership,
  CoreContext,
  DomainError,
  getMyMembership,
  getMyPreferences,
  listMyMemberships,
  listMyPayments,
  NotFoundError,
  startCheckout,
  updateMyPreferences,
} from '@communitypass/core';
import { InjectCore } from '../common/core';
import { Member, MemberContext, MemberGuard } from '../common/auth';
import { ZodPipe } from '../common/http';

@UseGuards(MemberGuard)
@Controller('member')
export class MemberController {
  constructor(@InjectCore() private readonly core: CoreContext) {}

  @Get('memberships')
  list(@Member() m: MemberContext) {
    return listMyMemberships(this.core, m.memberAccountId);
  }

  @Get('memberships/:id')
  detail(@Member() m: MemberContext, @Param('id') id: string) {
    return getMyMembership(this.core, m.memberAccountId, id);
  }

  @HttpCode(200)
  @Post('memberships/:id/cancel')
  async cancel(@Member() m: MemberContext, @Param('id') id: string, @Body(new ZodPipe(membershipCancelSchema)) body: { reason?: string }) {
    await cancelMyMembership(this.core, m.memberAccountId, id, body.reason);
    return { ok: true };
  }

  /** Renew the current plan (V1: same plan; switching is blocked while active). */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('memberships/:id/renew')
  async renew(@Member() m: MemberContext, @Param('id') id: string) {
    const ms = await this.core.prisma.membership.findFirst({
      where: { id, member: { memberAccountId: m.memberAccountId } },
      include: { community: true, plan: true, member: true },
    });
    if (!ms) throw new NotFoundError('Membership');
    if (!ms.plan.isActive) {
      throw new DomainError('PLAN_RETIRED', 'This plan is no longer offered. Choose a plan on the community page once your membership ends.', 409);
    }
    return startCheckout(this.core, {
      communitySlug: ms.community.slug,
      planId: ms.planId,
      fullName: ms.member.fullName,
      email: ms.member.email,
      phone: ms.member.phoneE164,
      whatsappOptIn: false, // consent is managed separately on the preferences page
      acceptTerms: true,
    });
  }

  @Get('payments')
  payments(@Member() m: MemberContext) {
    return listMyPayments(this.core, m.memberAccountId);
  }

  @Get('preferences')
  prefs(@Member() m: MemberContext) {
    return getMyPreferences(this.core, m.memberAccountId);
  }

  @Put('preferences/:memberId')
  async updatePrefs(
    @Member() m: MemberContext,
    @Param('memberId', new ZodPipe(z.string().min(1).max(64))) memberId: string,
    @Body(new ZodPipe(memberPreferencesSchema)) body: any,
  ) {
    await updateMyPreferences(this.core, m.memberAccountId, memberId, body);
    return { ok: true };
  }
}
