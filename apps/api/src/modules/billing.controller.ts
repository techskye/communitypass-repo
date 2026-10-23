import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { changePlanSchema } from '@communitypass/shared';
import {
  changePlan,
  CoreContext,
  getBillingOverview,
  setCancelAtPeriodEnd,
  startSubscriptionCheckout,
  verifySubscriptionPayment,
} from '@communitypass/core';
import { InjectCore } from '../common/core';
import { OrgId, Roles, Staff, StaffContext, StaffGuard } from '../common/auth';
import { ZodPipe } from '../common/http';

const subReference = z.string().regex(/^SUB-[A-Z0-9]{16}$/);

/** Creator's own CommunityPass subscription (paid to the platform, separate from member money). */
@UseGuards(StaffGuard)
@Controller('org/billing')
export class BillingController {
  constructor(@InjectCore() private readonly core: CoreContext) {}

  @Get()
  overview(@OrgId() orgId: string) {
    return getBillingOverview(this.core, orgId);
  }

  @Roles('OWNER')
  @HttpCode(200)
  @Post('plan')
  plan(@OrgId() orgId: string, @Staff() s: StaffContext, @Body(new ZodPipe(changePlanSchema)) body: { tier: 'STARTER' | 'GROWTH' | 'PRO' }) {
    return changePlan(this.core, orgId, s.user.id, body.tier);
  }

  /** Card checkout for one month; saves the card for automatic monthly renewal. */
  @Roles('OWNER')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post('checkout')
  checkout(@OrgId() orgId: string, @Staff() s: StaffContext) {
    return startSubscriptionCheckout(this.core, orgId, { id: s.user.id, email: s.user.email });
  }

  @HttpCode(200)
  @Post('verify/:reference')
  verify(@OrgId() orgId: string, @Param('reference', new ZodPipe(subReference)) reference: string) {
    return verifySubscriptionPayment(this.core, orgId, reference);
  }

  @Roles('OWNER')
  @HttpCode(200)
  @Post('cancel')
  async cancel(@OrgId() orgId: string, @Staff() s: StaffContext) {
    await setCancelAtPeriodEnd(this.core, orgId, s.user.id, true);
    return { ok: true };
  }

  @Roles('OWNER')
  @HttpCode(200)
  @Post('resume')
  async resume(@OrgId() orgId: string, @Staff() s: StaffContext) {
    await setCancelAtPeriodEnd(this.core, orgId, s.user.id, false);
    return { ok: true };
  }
}
