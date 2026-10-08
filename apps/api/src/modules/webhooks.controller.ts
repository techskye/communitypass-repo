import { Controller, Get, HttpCode, Post, Query, Req, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { CoreContext, recordPaystackWebhook, recordWhatsappWebhook } from '@communitypass/core';
import { InjectCore, QueueService } from '../common/core';

type RawRequest = Request & { rawBody?: Buffer };

/**
 * Provider webhooks. Signatures are verified over the exact raw body; verified events are
 * persisted to Postgres BEFORE we return 200. Processing is asynchronous (queue + sweeper).
 */
@SkipThrottle()
@Controller('webhooks')
export class WebhooksController {
  constructor(
    @InjectCore() private readonly core: CoreContext,
    private readonly queues: QueueService,
  ) {}

  @HttpCode(200)
  @Post('paystack')
  async paystack(@Req() req: RawRequest, @Res() res: Response) {
    const sig = req.headers['x-paystack-signature'];
    const r = await recordPaystackWebhook(this.core, req.rawBody, typeof sig === 'string' ? sig : undefined);
    if (!r.ok) {
      this.core.logger.warn({ reason: r.reason }, 'paystack webhook rejected');
      res.status(r.reason === 'not_configured' ? 503 : 401).json({ ok: false });
      return;
    }
    if (!r.duplicate) await this.queues.enqueueProviderEvent(r.eventId).catch(() => undefined);
    res.status(200).json({ ok: true });
  }

  /** Meta webhook verification handshake. */
  @Get('whatsapp')
  verifyWhatsapp(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ) {
    const expected = this.core.config.whatsapp.verifyToken;
    if (mode === 'subscribe' && expected && token === expected && typeof challenge === 'string') {
      res.status(200).type('text/plain').send(challenge);
      return;
    }
    res.status(403).send('Forbidden');
  }

  @HttpCode(200)
  @Post('whatsapp')
  async whatsapp(@Req() req: RawRequest, @Res() res: Response) {
    const sig = req.headers['x-hub-signature-256'];
    const r = await recordWhatsappWebhook(this.core, req.rawBody, typeof sig === 'string' ? sig : undefined);
    if (!r.ok) {
      this.core.logger.warn({ reason: r.reason }, 'whatsapp webhook rejected');
      res.status(r.reason === 'not_configured' ? 503 : 401).json({ ok: false });
      return;
    }
    if (!r.duplicate) await this.queues.enqueueProviderEvent(r.eventId).catch(() => undefined);
    res.status(200).json({ ok: true });
  }
}
