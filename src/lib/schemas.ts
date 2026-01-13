/**
 * Zod schemas for validating LLM responses and external data
 */
import { z } from 'zod';

// ============================================
// FOOD PARSING SCHEMAS
// ============================================

export const FoodItemSchema = z.object({
  name: z.string().min(1, 'Food name is required'),
  quantity: z.string().default('1 serving'),
  calories: z.number().min(0).max(10000),
  protein: z.number().min(0).max(500),
});

export const ParsedFoodResponseSchema = z.object({
  items: z.array(FoodItemSchema),
  totalCalories: z.number().min(0),
  totalProtein: z.number().min(0),
  confidence: z.enum(['high', 'medium', 'low']).default('medium'),
  notes: z.string().optional(),
});

export type FoodItemType = z.output<typeof FoodItemSchema>;
export type ParsedFoodResponseType = z.output<typeof ParsedFoodResponseSchema>;

// ============================================
// WORKOUT PARSING SCHEMAS
// ============================================

export const ParsedWorkoutResponseSchema = z.object({
  workoutType: z.enum(['strength', 'cardio', 'mixed', 'other']),
  durationMinutes: z.number().min(0).max(600).optional(),
  cardioType: z.string().optional(),
  distance: z.number().optional(),
  distanceUnit: z.enum(['miles', 'km']).optional(),
  simpleDescription: z.string().optional(),
  confidence: z.enum(['high', 'medium', 'low']).default('medium'),
  notes: z.string().optional(),
});

export type ParsedWorkoutResponseType = z.output<typeof ParsedWorkoutResponseSchema>;

// ============================================
// INTENT CLASSIFICATION SCHEMAS
// ============================================

export const IntentClassificationSchema = z.object({
  intent: z.enum([
    'food_log',
    'food_photo',
    'workout_log',
    'weight_log',
    'command',
    'question',
    'confirmation',
    'correction',
    'freeform',
    'greeting',
  ]),
  confidence: z.number().min(0).max(1).default(0.8),
  extractedValue: z.string().optional(),
});

export type IntentClassificationType = z.infer<typeof IntentClassificationSchema>;

// ============================================
// WEIGHT PARSING SCHEMAS
// ============================================

export const ParsedWeightSchema = z.object({
  weight: z.number().min(50).max(800), // lbs, reasonable range
  unit: z.enum(['lbs', 'kg']).default('lbs'),
  confidence: z.enum(['high', 'medium', 'low']).default('high'),
});

export type ParsedWeightType = z.infer<typeof ParsedWeightSchema>;

// ============================================
// INPUT VALIDATION SCHEMAS
// ============================================

export const PhoneNumberSchema = z
  .string()
  .regex(/^\+?1?[2-9]\d{9}$/, 'Invalid US phone number format')
  .transform((val) => {
    // Normalize to E.164 format
    const digits = val.replace(/\D/g, '');
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    return val;
  });

export const TimezoneSchema = z
  .string()
  .refine(
    (tz) => {
      try {
        Intl.DateTimeFormat(undefined, { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    },
    { message: 'Invalid timezone' }
  );

export const TimeStringSchema = z
  .string()
  .regex(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/, 'Time must be in HH:mm format');

// ============================================
// WEBHOOK PAYLOAD SCHEMAS
// ============================================

export const SendblueWebhookSchema = z.object({
  accountEmail: z.string().optional(),
  content: z.string(),
  media_url: z.string().url().optional().nullable(),
  is_outbound: z.boolean(),
  status: z.string(),
  error_code: z.string().optional().nullable(),
  error_message: z.string().optional().nullable(),
  message_handle: z.string(),
  date_sent: z.string(),
  date_updated: z.string(),
  from_number: z.string(),
  number: z.string().optional(),
  to_number: z.string(),
  was_downgraded: z.boolean().optional(),
  plan: z.string().optional(),
});

export type SendblueWebhookType = z.infer<typeof SendblueWebhookSchema>;

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Safely parse JSON from LLM response and validate with schema
 */
export function parseAndValidate<TInput, TOutput>(
  text: string,
  schema: z.ZodType<TOutput, z.ZodTypeDef, TInput>
): { success: true; data: TOutput } | { success: false; error: string } {
  // Try to extract JSON from the text
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { success: false, error: 'No JSON object found in response' };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const result = schema.safeParse(parsed);

    if (result.success) {
      return { success: true, data: result.data };
    } else {
      const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
      return { success: false, error: `Validation failed: ${issues}` };
    }
  } catch (error) {
    return {
      success: false,
      error: `JSON parse error: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

/**
 * Validate and coerce parsed food response
 */
export function validateFoodResponse(text: string): ParsedFoodResponseType | null {
  const result = parseAndValidate(text, ParsedFoodResponseSchema);
  return result.success ? result.data : null;
}

/**
 * Validate and coerce parsed workout response
 */
export function validateWorkoutResponse(text: string): ParsedWorkoutResponseType | null {
  const result = parseAndValidate(text, ParsedWorkoutResponseSchema);
  return result.success ? result.data : null;
}
