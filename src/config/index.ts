import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string(),
  REDIS_URL: z.string(),
  SENDBLUE_API_KEY: z.string(),
  SENDBLUE_API_SECRET: z.string(),
  SENDBLUE_PHONE_NUMBER: z.string(),
  GOOGLE_AI_API_KEY: z.string(),
  // Keep ANTHROPIC_API_KEY optional during migration
  ANTHROPIC_API_KEY: z.string().optional(),
  PORT: z.string().default('3000'),
  WEBHOOK_BASE_URL: z.string(),
  // Build mode (optional)
  BUILD_ADMIN_PHONES: z.string().optional(),
  GITHUB_TOKEN: z.string().optional(),
});

function loadConfig() {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
    throw new Error('Invalid environment variables');
  }

  return {
    database: {
      url: parsed.data.DATABASE_URL,
    },
    redis: {
      url: parsed.data.REDIS_URL,
    },
    sendblue: {
      apiKey: parsed.data.SENDBLUE_API_KEY,
      apiSecret: parsed.data.SENDBLUE_API_SECRET,
      phoneNumber: parsed.data.SENDBLUE_PHONE_NUMBER,
    },
    google: {
      apiKey: parsed.data.GOOGLE_AI_API_KEY,
    },
    anthropic: {
      apiKey: parsed.data.ANTHROPIC_API_KEY || '',
    },
    server: {
      port: parseInt(parsed.data.PORT, 10),
      webhookBaseUrl: parsed.data.WEBHOOK_BASE_URL,
    },
    build: {
      adminPhones: (parsed.data.BUILD_ADMIN_PHONES || '')
        .split(',')
        .map(p => p.trim())
        .filter(Boolean),
      githubToken: parsed.data.GITHUB_TOKEN || '',
      maxToolCalls: 50,
      sessionTimeoutMinutes: 60,
    },
  };
}

export const config = loadConfig();
export type Config = ReturnType<typeof loadConfig>;

// US Timezone options
export const US_TIMEZONES = [
  'America/New_York',      // Eastern
  'America/Chicago',       // Central
  'America/Denver',        // Mountain
  'America/Phoenix',       // Arizona (no DST)
  'America/Los_Angeles',   // Pacific
  'America/Anchorage',     // Alaska
  'Pacific/Honolulu',      // Hawaii
] as const;

// Meal time windows for auto-classification
export const MEAL_WINDOWS = {
  breakfast: { start: 5, end: 10.5 },   // 5am - 10:30am
  lunch: { start: 10.5, end: 15 },      // 10:30am - 3pm
  dinner: { start: 17, end: 21 },       // 5pm - 9pm
  // Everything else is snack
} as const;

// Activity multipliers for TDEE calculation
export const ACTIVITY_MULTIPLIERS = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  very_active: 1.9,
} as const;

// Rate limiting for Sendblue
export const SENDBLUE_RATE_LIMIT_MS = 1000; // 1 message per second per user
