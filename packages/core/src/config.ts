/**
 * Runtime configuration. Secrets are read from environment variables only and are never
 * written to the database, returned by APIs or logged.
 */
export type AppMode = 'demo' | 'live';

export interface AppConfig {
  appMode: AppMode;
  nodeEnv: string;
  webBaseUrl: string;
  databaseUrl: string;
  redisUrl: string;
  cookieSecure: boolean;
  trustProxy: boolean;
  platformSupportEmail: string;
  uploadDir: string;
  paystack: {
    secretKey: string | null;
    /** Derived from the key prefix: sk_live_ => live. */
    liveMode: boolean;
    baseUrl: string;
  };
  whatsapp: {
    enabled: boolean;
    accessToken: string | null;
    phoneNumberId: string | null;
    appSecret: string | null;
    verifyToken: string | null;
    graphVersion: string;
    sendsPerSecond: number;
  };
  email: {
    enabled: boolean;
    resendApiKey: string | null;
    from: string;
  };
}

function bool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function opt(v: string | undefined): string | null {
  return v && v.trim() ? v.trim() : null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const appMode = (env.APP_MODE ?? 'demo') as AppMode;
  if (appMode !== 'demo' && appMode !== 'live') {
    throw new Error(`APP_MODE must be "demo" or "live" (got "${env.APP_MODE}")`);
  }
  const nodeEnv = env.NODE_ENV ?? 'development';
  const paystackKey = opt(env.PAYSTACK_SECRET_KEY);
  const cfg: AppConfig = {
    appMode,
    nodeEnv,
    webBaseUrl: (env.WEB_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
    databaseUrl: env.DATABASE_URL ?? '',
    redisUrl: env.REDIS_URL ?? 'redis://localhost:6379',
    cookieSecure: bool(env.COOKIE_SECURE, nodeEnv === 'production'),
    trustProxy: bool(env.TRUST_PROXY, false),
    platformSupportEmail: env.PLATFORM_SUPPORT_EMAIL ?? 'support@example.com',
    uploadDir: env.UPLOAD_DIR ?? './uploads',
    paystack: {
      secretKey: paystackKey,
      liveMode: !!paystackKey && paystackKey.startsWith('sk_live_'),
      baseUrl: env.PAYSTACK_BASE_URL ?? 'https://api.paystack.co',
    },
    whatsapp: {
      enabled: bool(env.WHATSAPP_ENABLED, false),
      accessToken: opt(env.WHATSAPP_ACCESS_TOKEN),
      phoneNumberId: opt(env.WHATSAPP_PHONE_NUMBER_ID),
      appSecret: opt(env.WHATSAPP_APP_SECRET),
      verifyToken: opt(env.WHATSAPP_VERIFY_TOKEN),
      graphVersion: env.WHATSAPP_GRAPH_VERSION ?? 'v23.0',
      sendsPerSecond: Number(env.WHATSAPP_SENDS_PER_SECOND ?? 10),
    },
    email: {
      enabled: bool(env.EMAIL_ENABLED, false),
      resendApiKey: opt(env.RESEND_API_KEY),
      from: env.EMAIL_FROM ?? 'CommunityPass <no-reply@example.com>',
    },
  };
  if (appMode === 'live') {
    const missing: string[] = [];
    if (!cfg.paystack.secretKey) missing.push('PAYSTACK_SECRET_KEY');
    if (cfg.email.enabled && !cfg.email.resendApiKey) missing.push('RESEND_API_KEY');
    if (cfg.whatsapp.enabled) {
      for (const [k, v] of Object.entries({
        WHATSAPP_ACCESS_TOKEN: cfg.whatsapp.accessToken,
        WHATSAPP_PHONE_NUMBER_ID: cfg.whatsapp.phoneNumberId,
        WHATSAPP_APP_SECRET: cfg.whatsapp.appSecret,
        WHATSAPP_VERIFY_TOKEN: cfg.whatsapp.verifyToken,
      })) {
        if (!v) missing.push(k);
      }
    }
    if (missing.length) {
      throw new Error(`APP_MODE=live requires: ${missing.join(', ')}`);
    }
  }
  return cfg;
}

/** Safe-to-expose summary (no secrets). */
export function publicConfigSummary(cfg: AppConfig) {
  return {
    appMode: cfg.appMode,
    paystack: { configured: !!cfg.paystack.secretKey, liveMode: cfg.paystack.liveMode },
    whatsapp: {
      enabled: cfg.whatsapp.enabled,
      configured: !!(cfg.whatsapp.accessToken && cfg.whatsapp.phoneNumberId && cfg.whatsapp.appSecret),
      graphVersion: cfg.whatsapp.graphVersion,
    },
    email: { enabled: cfg.email.enabled, configured: !!cfg.email.resendApiKey, from: cfg.email.from },
  };
}
