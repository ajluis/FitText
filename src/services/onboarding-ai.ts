/**
 * LLM-powered onboarding message processing
 *
 * Uses Claude to interpret natural language during onboarding,
 * making the setup flow more flexible and conversational.
 */
import { User, OnboardingStep, PrimaryGoal, ActivityLevel, Sex } from '@prisma/client';
import anthropic, {
  CLAUDE_MODEL,
  callClaudeWithRetry,
  getUserFriendlyErrorMessage,
} from '../lib/claude';
import { parseAndValidate } from '../lib/schemas';
import { z } from 'zod';

// Max tokens for onboarding responses
const MAX_TOKENS_ONBOARDING = 500;

// ============================================
// TYPES AND SCHEMAS
// ============================================

// Schema for extracted onboarding fields
const ExtractedFieldsSchema = z.object({
  primaryGoal: z.enum(['fat_loss', 'muscle_gain', 'recomp', 'general_health']).optional(),
  currentWeight: z.number().min(50).max(800).optional(),
  heightInches: z.number().min(36).max(96).optional(), // 3ft to 8ft
  age: z.number().min(13).max(120).optional(),
  sex: z.enum(['male', 'female']).optional(),
  activityLevel: z.enum(['sedentary', 'light', 'moderate', 'active', 'very_active']).optional(),
  timezone: z.string().optional(),
  dietaryRestrictions: z.array(z.string()).optional(),
  accountabilityLevel: z.enum(['light', 'medium', 'high']).optional(),
  targetsConfirmed: z.boolean().optional(),
});

// Full response schema
const OnboardingExtractionSchema = z.object({
  extractedFields: ExtractedFieldsSchema,
  intent: z.enum(['provide_info', 'ask_question', 'confirm', 'deny', 'escape_command', 'unclear']),
  escapeCommand: z.enum(['help', 'restart', 'back']).nullable().optional(),
  response: z.string(),
  nextFieldToAsk: z.string().nullable().optional(),
});

export type ExtractedFields = z.infer<typeof ExtractedFieldsSchema>;
export type OnboardingExtraction = z.infer<typeof OnboardingExtractionSchema>;

// Collected user data for context
export interface CollectedData {
  primaryGoal?: PrimaryGoal | null;
  currentWeight?: number | null;
  heightInches?: number | null;
  age?: number | null;
  sex?: Sex | null;
  activityLevel?: ActivityLevel | null;
  timezone?: string | null;
  dietaryRestrictions?: string[];
  accountabilityLevel?: string | null;
  targetsConfirmed?: boolean;
  calorieTarget?: number | null;
  proteinTarget?: number | null;
}

// ============================================
// FIELD DEFINITIONS
// ============================================

const FIELD_ORDER = [
  'primaryGoal',
  'currentWeight',
  'timezone',
  'heightInches',
  'age',
  'sex',
  'activityLevel',
  'targetsConfirmed',
  'dietaryRestrictions',
  'accountabilityLevel',
] as const;

const FIELD_DESCRIPTIONS: Record<string, string> = {
  primaryGoal: 'Goal (fat_loss, muscle_gain, recomp, or general_health)',
  currentWeight: 'Current weight in pounds',
  timezone: 'Timezone (IANA format like America/New_York, or common names like Eastern/Pacific)',
  heightInches: 'Height in inches (convert from feet if needed, e.g., 5\'10" = 70 inches)',
  age: 'Age in years',
  sex: 'Biological sex (male or female) - needed for accurate calorie calculations',
  activityLevel: 'Activity level (sedentary, light, moderate, or active) outside of workouts',
  targetsConfirmed: 'Whether they confirmed the calculated calorie/protein targets',
  dietaryRestrictions: 'Any dietary restrictions (vegetarian, vegan, gluten-free, etc.) or "none"',
  accountabilityLevel: 'Preferred accountability level (light, medium, or high)',
};

const GOAL_EXPLANATIONS = `
Goal options:
- fat_loss: Focused on losing body fat while preserving muscle
- muscle_gain: Focused on building muscle, willing to gain some fat
- recomp: Simultaneously losing fat and gaining muscle (slower progress, good for beginners)
- general_health: Balanced approach, maintain current body composition
`;

const ACTIVITY_EXPLANATIONS = `
Activity levels (outside of intentional workouts):
- sedentary: Desk job, minimal daily movement
- light: Some walking, occasionally on feet
- moderate: On feet most of the day, regularly moving
- active: Physical job, constantly moving
`;

const ACCOUNTABILITY_EXPLANATIONS = `
Accountability levels:
- light: Daily summary only, no check-in reminders
- medium: Meal reminders if you haven't logged by usual meal times (recommended)
- high: All reminders plus morning/evening check-ins
`;

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Get list of missing fields based on collected data
 */
export function getMissingFields(data: CollectedData): string[] {
  const missing: string[] = [];

  if (!data.primaryGoal) missing.push('primaryGoal');
  if (!data.currentWeight) missing.push('currentWeight');
  if (!data.timezone) missing.push('timezone');
  if (!data.heightInches) missing.push('heightInches');
  if (!data.age) missing.push('age');
  if (!data.sex) missing.push('sex');
  if (!data.activityLevel) missing.push('activityLevel');
  if (!data.targetsConfirmed) missing.push('targetsConfirmed');
  if (data.dietaryRestrictions === undefined) missing.push('dietaryRestrictions');
  if (!data.accountabilityLevel) missing.push('accountabilityLevel');

  return missing;
}

/**
 * Get the next field to collect based on what's missing
 */
export function getNextField(data: CollectedData): string | null {
  const missing = getMissingFields(data);
  if (missing.length === 0) return null;

  // Return first missing field in order
  for (const field of FIELD_ORDER) {
    if (missing.includes(field)) {
      return field;
    }
  }

  return null;
}

/**
 * Build collected data object from user
 */
export function buildCollectedData(user: User): CollectedData {
  return {
    primaryGoal: user.primaryGoal,
    currentWeight: user.currentWeight,
    heightInches: user.heightInches,
    age: user.age,
    sex: user.sex,
    activityLevel: user.activityLevel,
    timezone: user.timezone !== 'America/Los_Angeles' ? user.timezone : null, // Default means not set
    dietaryRestrictions: user.dietaryRestrictions as string[] | undefined,
    accountabilityLevel: user.accountabilityLevel,
    calorieTarget: user.calorieTarget,
    proteinTarget: user.proteinTarget,
  };
}

/**
 * Format collected data for the LLM prompt
 */
function formatCollectedData(data: CollectedData): string {
  const parts: string[] = [];

  if (data.primaryGoal) parts.push(`Goal: ${data.primaryGoal}`);
  if (data.currentWeight) parts.push(`Weight: ${data.currentWeight} lbs`);
  if (data.timezone) parts.push(`Timezone: ${data.timezone}`);
  if (data.heightInches) {
    const feet = Math.floor(data.heightInches / 12);
    const inches = data.heightInches % 12;
    parts.push(`Height: ${feet}'${inches}" (${data.heightInches} inches)`);
  }
  if (data.age) parts.push(`Age: ${data.age}`);
  if (data.sex) parts.push(`Sex: ${data.sex}`);
  if (data.activityLevel) parts.push(`Activity: ${data.activityLevel}`);
  if (data.dietaryRestrictions !== undefined) {
    parts.push(`Diet restrictions: ${data.dietaryRestrictions.length > 0 ? data.dietaryRestrictions.join(', ') : 'none'}`);
  }
  if (data.accountabilityLevel) parts.push(`Accountability: ${data.accountabilityLevel}`);
  if (data.targetsConfirmed) parts.push('Targets: confirmed');
  if (data.calorieTarget && data.proteinTarget) {
    parts.push(`Calculated targets: ${data.calorieTarget} cal, ${data.proteinTarget}g protein`);
  }

  return parts.length > 0 ? parts.join('\n') : 'None yet';
}

/**
 * Format missing fields for the LLM prompt
 */
function formatMissingFields(data: CollectedData): string {
  const missing = getMissingFields(data);
  return missing.map(field => `- ${field}: ${FIELD_DESCRIPTIONS[field]}`).join('\n');
}

// ============================================
// MAIN PROCESSING FUNCTION
// ============================================

/**
 * Process an onboarding message through the LLM
 */
export async function processOnboardingWithAI(
  user: User,
  message: string,
  currentStep: OnboardingStep,
  collectedData: CollectedData
): Promise<OnboardingExtraction> {
  const missingFields = getMissingFields(collectedData);
  const nextField = getNextField(collectedData);

  // Build context about what we're looking for next
  let contextHint = '';
  if (nextField === 'primaryGoal') {
    contextHint = GOAL_EXPLANATIONS;
  } else if (nextField === 'activityLevel') {
    contextHint = ACTIVITY_EXPLANATIONS;
  } else if (nextField === 'accountabilityLevel') {
    contextHint = ACCOUNTABILITY_EXPLANATIONS;
  }

  const systemPrompt = `You are Alex from FitText, helping a new user set up their fitness coaching account via iMessage. Be extremely concise and conversational. Use lowercase, abbreviations are fine, do not use commas or dashes.

Examples of your style:
- "nice ok how much do you weigh?"
- "a ballpark figure works"
- "how old are you?"
- "gotcha. how often do you want reminders?"

CURRENT PROGRESS:
Already collected:
${formatCollectedData(collectedData)}

Still needed:
${formatMissingFields(collectedData)}
${contextHint}

TIMEZONE CONVERSION HELP:
- "eastern", "et", "est", "edt" → America/New_York
- "central", "ct", "cst", "cdt" → America/Chicago
- "mountain", "mt", "mst", "mdt" → America/Denver
- "pacific", "pt", "pst", "pdt" → America/Los_Angeles
- "uk", "london", "gmt" → Europe/London or UTC

HEIGHT CONVERSION:
- Convert feet/inches to total inches (e.g., 5'10" = 70 inches)
- If user says just "5 10" or "five ten", interpret as 5'10" = 70 inches

INSTRUCTIONS:
1. Extract any data the user provided in their message
2. If they ask a question answer it helpfully and then guide them back
3. If their response is unclear ask for clarification and be direct
4. If they provide multiple pieces of info at once extract all of them
5. Keep responses under 60 characters unless they ask a question that requires a larger response
6. Match their energy
7. For escape commands (/help, back, restart, start over) set intent to "escape_command"
8. After extracting data ask for the next missing field naturally

The NEXT field to collect is: ${nextField || 'none - all collected!'}

Return JSON only (no markdown, no explanation):
{
  "extractedFields": { ... only include fields mentioned in the message ... },
  "intent": "provide_info" | "ask_question" | "confirm" | "deny" | "escape_command" | "unclear",
  "escapeCommand": "help" | "restart" | "back" | null,
  "response": "Your friendly SMS response",
  "nextFieldToAsk": "${nextField}" | null
}`;

  const result = await callClaudeWithRetry(
    async () => {
      const response = await anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: MAX_TOKENS_ONBOARDING,
        messages: [
          { role: 'user', content: message },
        ],
        system: systemPrompt,
      });

      const content = response.content[0];
      if (content.type !== 'text') {
        throw new Error('Unexpected response type from Claude');
      }

      return content.text;
    },
    { label: 'Onboarding AI processing' }
  );

  if (!result.success || !result.data) {
    // Return a fallback response
    return {
      extractedFields: {},
      intent: 'unclear',
      escapeCommand: null,
      response: result.error
        ? getUserFriendlyErrorMessage(result.error)
        : "I had a bit of trouble there. Can you try rephrasing?",
      nextFieldToAsk: nextField,
    };
  }

  // Parse and validate the response
  const parsed = parseAndValidate(result.data, OnboardingExtractionSchema);

  if (!parsed.success) {
    console.error('Failed to parse onboarding AI response:', parsed.error);
    console.error('Raw response:', result.data);

    // Return a fallback
    return {
      extractedFields: {},
      intent: 'unclear',
      escapeCommand: null,
      response: "I didn't quite catch that. Can you try again?",
      nextFieldToAsk: nextField,
    };
  }

  return parsed.data;
}

/**
 * Validate extracted timezone
 */
export function validateTimezone(tz: string): string | null {
  // Common aliases
  const aliases: Record<string, string> = {
    'eastern': 'America/New_York',
    'et': 'America/New_York',
    'est': 'America/New_York',
    'edt': 'America/New_York',
    'central': 'America/Chicago',
    'ct': 'America/Chicago',
    'cst': 'America/Chicago',
    'cdt': 'America/Chicago',
    'mountain': 'America/Denver',
    'mt': 'America/Denver',
    'mst': 'America/Denver',
    'mdt': 'America/Denver',
    'pacific': 'America/Los_Angeles',
    'pt': 'America/Los_Angeles',
    'pst': 'America/Los_Angeles',
    'pdt': 'America/Los_Angeles',
    'utc': 'UTC',
    'gmt': 'UTC',
    'uk': 'Europe/London',
    'london': 'Europe/London',
  };

  const lower = tz.toLowerCase().trim();
  const resolved = aliases[lower] || tz;

  try {
    Intl.DateTimeFormat(undefined, { timeZone: resolved });
    return resolved;
  } catch {
    return null;
  }
}

/**
 * Clean and validate extracted fields before database update
 */
export function cleanExtractedFields(fields: ExtractedFields): ExtractedFields {
  const cleaned: ExtractedFields = {};

  if (fields.primaryGoal) {
    cleaned.primaryGoal = fields.primaryGoal;
  }

  if (fields.currentWeight && fields.currentWeight >= 50 && fields.currentWeight <= 800) {
    cleaned.currentWeight = Math.round(fields.currentWeight * 10) / 10; // Round to 1 decimal
  }

  if (fields.heightInches && fields.heightInches >= 36 && fields.heightInches <= 96) {
    cleaned.heightInches = Math.round(fields.heightInches);
  }

  if (fields.age && fields.age >= 13 && fields.age <= 120) {
    cleaned.age = Math.round(fields.age);
  }

  if (fields.sex) {
    cleaned.sex = fields.sex;
  }

  if (fields.activityLevel) {
    cleaned.activityLevel = fields.activityLevel;
  }

  if (fields.timezone) {
    const validTz = validateTimezone(fields.timezone);
    if (validTz) {
      cleaned.timezone = validTz;
    }
  }

  if (fields.dietaryRestrictions !== undefined) {
    // Filter out empty strings and normalize
    const restrictions = fields.dietaryRestrictions
      .map(r => r.trim().toLowerCase())
      .filter(r => r.length > 0 && r !== 'none' && r !== 'n/a');
    cleaned.dietaryRestrictions = restrictions;
  }

  if (fields.accountabilityLevel) {
    cleaned.accountabilityLevel = fields.accountabilityLevel;
  }

  if (fields.targetsConfirmed !== undefined) {
    cleaned.targetsConfirmed = fields.targetsConfirmed;
  }

  return cleaned;
}
