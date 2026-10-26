import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  ALLOWED_ORIGINS: z.string().default('http://localhost:5173,http://127.0.0.1:5173'),
  AI_BASE_URL: z.string().url().optional().or(z.literal('')),
  AI_API_KEY: z.string().optional(),
  AI_MODEL: z.string().optional(),
  AI_TIMEOUT_MS: z.coerce.number().int().positive().max(120_000).default(45_000),
  AI_MAX_TOKENS: z.coerce.number().int().positive().max(8_000).default(1_600),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('[authdoctor] Invalid environment configuration:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const env = parsed.data;

export const config = {
  port: env.PORT,
  nodeEnv: env.NODE_ENV,
  allowedOrigins: env.ALLOWED_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean),
  ai: {
    baseUrl: env.AI_BASE_URL?.replace(/\/+$/, '') ?? '',
    apiKey: env.AI_API_KEY ?? '',
    model: env.AI_MODEL ?? '',
    timeoutMs: env.AI_TIMEOUT_MS,
    maxTokens: env.AI_MAX_TOKENS,
  },
} as const;

/**
 * A model is only considered configured when all three pieces are present.
 * A base URL without a model is a misconfiguration, not a working provider.
 */
export const aiConfigured = Boolean(config.ai.baseUrl && config.ai.model);

export function providerStatus() {
  return {
    mode: aiConfigured ? ('model' as const) : ('local' as const),
    model: aiConfigured ? config.ai.model : null,
    baseUrlHost: aiConfigured ? safeHost(config.ai.baseUrl) : null,
    hasApiKey: Boolean(config.ai.apiKey),
  };
}

function safeHost(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
