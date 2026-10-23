import { Body, Controller, Get, HttpCode, NotFoundException, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { checkoutStartSchema, CURRENT_WHATSAPP_CONSENT_VERSION, WHATSAPP_CONSENT_VERSIONS } from '@communitypass/shared';
import {
  CoreContext,
  getDemoCheckout,
  getPaymentReadiness,
  getPublicOrderStatus,
  memberLimitReached,
  simulateDemoCheckout,
  startCheckout,
  verifyFromCallback,
} from '@communitypass/core';
import { InjectCore } from '../common/core';
import { ZodPipe } from '../common/http';

const referenceSchema = z.string().regex(/^CP-[A-Z0-9]{16}$/);
const demoReferenceSchema = z.string().regex(/^(CP|SUB)-[A-Z0-9]{16}$/);

@Controller('public')
export class PublicController {
  constructor(@InjectCore() private readonly core: CoreContext) {}

  /**
   * Public community page data. Explicit field selection: the WhatsApp invite URL and any
   * member data are never included.
   */
  @Get('communities/:slug')
  async community(@Param('slug') slug: string) {
    const c = await this.core.prisma.community.findUnique({
      where: { slug: String(slug).toLowerCase() },
      select: {
        id: true,
        organizationId: true,
        name: true,
        slug: true,
        description: true,
        imageUrl: true,
        gracePeriodDays: true,
        isPublished: true,
        organization: { select: { displayName: true, supportEmail: true, status: true } },
        plans: {
          where: { isActive: true },
          select: { id: true, name: true, description: true, priceKobo: true, currency: true, durationDays: true },
          orderBy: { durationDays: 'asc' },
        },
      },
    });
    if (!c || !c.isPublished || c.organization.status !== 'ACTIVE') throw new NotFoundException('Community not found');
    const readiness = await getPaymentReadiness(this.core, c.organizationId);
    const full = readiness.ready && (await memberLimitReached(this.core.prisma, c.organizationId, this.core.now()));
    return {
      name: c.name,
      slug: c.slug,
      description: c.description,
      imageUrl: c.imageUrl,
      gracePeriodDays: c.gracePeriodDays,
      creator: { displayName: c.organization.displayName, supportEmail: c.organization.supportEmail },
      plans: c.plans,
      checkoutAvailable: readiness.ready,
      checkoutUnavailableReason: readiness.ready ? null : 'This creator is not accepting payments right now.',
      newMembersAllowed: readiness.ready && !full,
      newMembersUnavailableReason: full ? 'This community is not accepting new members right now. Existing members can still renew from their member page.' : null,
      isDemoCheckout: readiness.provider === 'DEMO',
      whatsappConsentText: WHATSAPP_CONSENT_VERSIONS[CURRENT_WHATSAPP_CONSENT_VERSION](c.organization.displayName),
      whatsappConsentVersion: CURRENT_WHATSAPP_CONSENT_VERSION,
    };
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Post('checkout')
  async checkout(@Body(new ZodPipe(checkoutStartSchema)) body: any) {
    return startCheckout(this.core, body);
  }

  @Get('orders/:reference')
  async order(@Param('reference', new ZodPipe(referenceSchema)) reference: string) {
    return getPublicOrderStatus(this.core, reference);
  }

  /** Called by the payment callback page. Verifies server-side; never trusts the redirect. */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(200)
  @Post('orders/:reference/verify')
  async verify(@Param('reference', new ZodPipe(referenceSchema)) reference: string) {
    return verifyFromCallback(this.core, reference);
  }

  // ───────────── Demo hosted checkout (APP_MODE=demo only) ─────────────

  @Get('demo-checkout/:reference')
  async demoCheckout(@Param('reference', new ZodPipe(demoReferenceSchema)) reference: string) {
    if (this.core.config.appMode !== 'demo') throw new NotFoundException();
    return getDemoCheckout(this.core, reference);
  }

  @HttpCode(200)
  @Post('demo-checkout/:reference/complete')
  async demoComplete(
    @Param('reference', new ZodPipe(demoReferenceSchema)) reference: string,
    @Body(new ZodPipe(z.object({ outcome: z.enum(['success', 'failed', 'wrong_amount']) }))) body: { outcome: 'success' | 'failed' | 'wrong_amount' },
  ) {
    return simulateDemoCheckout(this.core, reference, body.outcome);
  }
}
