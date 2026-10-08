import { PrismaClient } from '@prisma/client';
import type { Logger } from 'pino';
import { AppConfig, loadConfig } from './config';
import { createLogger } from './infra';
import {
  DemoPaymentAdapter,
  PaymentAdapter,
  PaystackAdapter,
} from './adapters/payment';
import {
  DisabledEmailAdapter,
  DisabledWhatsappAdapter,
  EmailAdapter,
  MockEmailAdapter,
  MockWhatsappAdapter,
  ResendEmailAdapter,
  WhatsappAdapter,
  WhatsappCloudApiAdapter,
} from './adapters/messaging';

export interface Adapters {
  payments: { PAYSTACK: PaymentAdapter | null; DEMO: PaymentAdapter | null };
  whatsapp: WhatsappAdapter;
  email: EmailAdapter;
}

export interface CoreContext {
  prisma: PrismaClient;
  config: AppConfig;
  adapters: Adapters;
  logger: Logger;
  now: () => Date;
  /** Optional hook so the API can push freshly created notifications to the queue right away. */
  onNotificationsCreated?: (ids: string[]) => void | Promise<void>;
}

/**
 * Builds provider adapters. Demo mode ALWAYS uses mocks: no real messages, no real payments.
 */
export function buildAdapters(config: AppConfig, prisma: PrismaClient): Adapters {
  if (config.appMode === 'demo') {
    return {
      payments: { PAYSTACK: null, DEMO: new DemoPaymentAdapter(prisma, config.webBaseUrl) },
      whatsapp: new MockWhatsappAdapter(prisma),
      email: new MockEmailAdapter(prisma),
    };
  }
  return {
    payments: {
      PAYSTACK: config.paystack.secretKey ? new PaystackAdapter(config.paystack) : null,
      DEMO: null,
    },
    whatsapp: config.whatsapp.enabled
      ? new WhatsappCloudApiAdapter(config.whatsapp)
      : new DisabledWhatsappAdapter(),
    email: config.email.enabled ? new ResendEmailAdapter(config.email) : new DisabledEmailAdapter(),
  };
}

export function createCoreContext(opts: {
  name: string;
  config?: AppConfig;
  prisma?: PrismaClient;
  adapters?: Adapters;
  now?: () => Date;
}): CoreContext {
  const config = opts.config ?? loadConfig();
  const prisma = opts.prisma ?? new PrismaClient({ datasourceUrl: config.databaseUrl || undefined });
  return {
    prisma,
    config,
    adapters: opts.adapters ?? buildAdapters(config, prisma),
    logger: createLogger(opts.name),
    now: opts.now ?? (() => new Date()),
  };
}
