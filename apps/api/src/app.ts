import 'reflect-metadata';
import { Controller, Get, INestApplication, MiddlewareConsumer, Module, NotFoundException, Param, Res } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import path from 'node:path';
import type { Response } from 'express';
import { CoreContext, LOG_REDACT_PATHS } from '@communitypass/core';
import { coreModuleFor, InjectCore, QueueService } from './common/core';
import { AppExceptionFilter, CsrfMiddleware } from './common/http';
import { AuthController } from './modules/auth.controller';
import { PublicController } from './modules/public.controller';
import { MemberController } from './modules/member.controller';
import { WebhooksController } from './modules/webhooks.controller';
import { OrgController } from './modules/org.controller';
import { OperationsController } from './modules/operations.controller';
import { AdminController } from './modules/admin.controller';
import { BillingController } from './modules/billing.controller';

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

@Controller('uploads')
class UploadsController {
  constructor(@InjectCore() private readonly core: CoreContext) {}
  @Get(':name')
  serve(@Param('name') name: string, @Res() res: Response) {
    const m = /^[a-z0-9]{1,12}-[a-f0-9]{24}\.(png|jpg|webp)$/.exec(name);
    if (!m) throw new NotFoundException();
    res.setHeader('Content-Type', MIME[m[1]]);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(path.join(path.resolve(this.core.config.uploadDir), name), (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  }
}

export async function createApp(core: CoreContext, opts: { logger?: boolean; throttle?: boolean } = {}): Promise<INestApplication> {
  const CoreModule = coreModuleFor(core);

  @Module({
    imports: [
      CoreModule,
      ThrottlerModule.forRoot({
        throttlers: [{ name: 'default', ttl: 60_000, limit: 120 }],
        skipIf: () => opts.throttle === false,
      }),
    ],
    controllers: [
      AuthController,
      PublicController,
      MemberController,
      WebhooksController,
      OrgController,
      OperationsController,
      AdminController,
      BillingController,
      UploadsController,
    ],
    providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
  })
  class AppModule {
    configure(consumer: MiddlewareConsumer) {
      consumer.apply(new CsrfMiddleware(core).use.bind(new CsrfMiddleware(core))).forRoutes('*');
    }
  }

  // rawBody: true keeps the exact bytes for webhook signature verification.
  const app = await NestFactory.create(AppModule, { rawBody: true, logger: opts.logger === false ? false : ['error', 'warn'] });
  const express = app.getHttpAdapter().getInstance();
  if (core.config.trustProxy) express.set('trust proxy', 1);
  express.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'same-site' } }));
  app.use(cookieParser());
  if (opts.logger !== false) {
    app.use(
      pinoHttp({
        logger: core.logger,
        redact: { paths: LOG_REDACT_PATHS, censor: '[redacted]' },
        // Log the path only — never query strings or bodies.
        serializers: {
          req: (req: any) => ({ id: req.id, method: req.method, url: String(req.url).split('?')[0] }),
          res: (res: any) => ({ statusCode: res.statusCode }),
        },
      }),
    );
  }
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new AppExceptionFilter(core));
  app.enableShutdownHooks();

  const queues = app.get(QueueService);
  core.onNotificationsCreated = (ids) => queues.enqueueNotifications(ids);
  return app;
}
