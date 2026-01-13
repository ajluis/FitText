/**
 * Input validation utilities for startup and runtime validation
 */
import { z } from 'zod';
import { PhoneNumberSchema, TimezoneSchema, TimeStringSchema } from './schemas';

// ============================================
// ENVIRONMENT VALIDATION
// ============================================

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
  SENDBLUE_API_KEY: z.string().min(1, 'SENDBLUE_API_KEY is required'),
  SENDBLUE_API_SECRET: z.string().min(1, 'SENDBLUE_API_SECRET is required'),
  SENDBLUE_PHONE_NUMBER: z.string().min(1, 'SENDBLUE_PHONE_NUMBER is required'),
  PORT: z.string().regex(/^\d+$/).transform(Number).default('3000'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

export type EnvConfig = z.infer<typeof EnvSchema>;

/**
 * Validate environment variables at startup
 * Throws if required env vars are missing
 */
export function validateEnv(): EnvConfig {
  const result = EnvSchema.safeParse(process.env);

  if (!result.success) {
    const missing = result.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Missing or invalid environment variables: ${missing}`);
  }

  return result.data;
}

// ============================================
// PHONE NUMBER VALIDATION
// ============================================

/**
 * Validate and normalize a phone number
 */
export function validatePhoneNumber(phone: string): string | null {
  const result = PhoneNumberSchema.safeParse(phone);
  return result.success ? result.data : null;
}

/**
 * Check if a phone number is valid
 */
export function isValidPhoneNumber(phone: string): boolean {
  return PhoneNumberSchema.safeParse(phone).success;
}

// ============================================
// TIMEZONE VALIDATION
// ============================================

/**
 * Validate a timezone string
 */
export function validateTimezone(tz: string): boolean {
  return TimezoneSchema.safeParse(tz).success;
}

// ============================================
// TIME VALIDATION
// ============================================

/**
 * Validate a time string (HH:mm format)
 */
export function validateTimeString(time: string): boolean {
  return TimeStringSchema.safeParse(time).success;
}

// ============================================
// MESSAGE VALIDATION
// ============================================

const MessageSchema = z.object({
  phone: PhoneNumberSchema,
  content: z.string().min(1).max(10000),
  mediaUrl: z.string().url().optional().nullable(),
});

export type ValidatedMessage = z.infer<typeof MessageSchema>;

/**
 * Validate an inbound message
 */
export function validateInboundMessage(data: unknown): ValidatedMessage | null {
  const result = MessageSchema.safeParse(data);
  return result.success ? result.data : null;
}

// ============================================
// NUMERIC INPUT VALIDATION
// ============================================

/**
 * Validate weight input (supports various formats)
 */
export function validateWeightInput(input: string): number | null {
  // Remove common units and extra text
  const cleaned = input.toLowerCase().replace(/\s*(lbs?|pounds?|kg|kilos?)\s*/gi, '').trim();
  const num = parseFloat(cleaned);

  // Valid weight range: 50-800 lbs (covers most human weights)
  if (isNaN(num) || num < 50 || num > 800) {
    return null;
  }

  return Math.round(num * 10) / 10; // Round to 1 decimal place
}

/**
 * Validate calorie target input
 */
export function validateCalorieTarget(input: string): number | null {
  const num = parseInt(input.replace(/\D/g, ''), 10);

  // Valid calorie range: 800-8000
  if (isNaN(num) || num < 800 || num > 8000) {
    return null;
  }

  return num;
}

/**
 * Validate protein target input
 */
export function validateProteinTarget(input: string): number | null {
  const num = parseInt(input.replace(/\D/g, ''), 10);

  // Valid protein range: 20-500g
  if (isNaN(num) || num < 20 || num > 500) {
    return null;
  }

  return num;
}

// ============================================
// SANITIZATION
// ============================================

/**
 * Sanitize user input to prevent injection
 */
export function sanitizeInput(input: string): string {
  return input
    .trim()
    .slice(0, 5000) // Limit length
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ''); // Remove control characters
}

/**
 * Sanitize for database storage
 */
export function sanitizeForDb(input: string): string {
  return sanitizeInput(input).replace(/\\/g, '\\\\'); // Escape backslashes
}
