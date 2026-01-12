import { User } from '@prisma/client';
import anthropic, { CLAUDE_MODEL, MAX_TOKENS } from '../lib/claude';
import { isSettingsRequest } from './settings-ai';

// Intent types
export type Intent =
  | 'food_log'
  | 'food_photo'
  | 'workout_log'
  | 'weight_log'
  | 'command'
  | 'settings_change'
  | 'question'
  | 'confirmation'
  | 'correction'
  | 'freeform'
  | 'greeting';

export interface ClassifiedMessage {
  intent: Intent;
  confidence: 'high' | 'medium' | 'low';
  command?: string;         // For command intent: the specific command
  isAffirmative?: boolean;  // For confirmation intent: yes/no
  correctionValue?: string; // For correction intent: the corrected value
  rawMessage: string;
}

// Commands we recognize
const COMMANDS = [
  '/settings',
  '/progress',
  '/today',
  '/yesterday',
  '/week',
  '/help',
  '/pause',
  '/resume',
  '/goals',
  '/weight',
  '/macros',
  '/status',
] as const;

// Quick patterns for fast classification (before LLM)
const FOOD_KEYWORDS = [
  'ate', 'had', 'eaten', 'eating', 'breakfast', 'lunch', 'dinner', 'snack',
  'meal', 'food', 'calories', 'cal', 'protein', 'drank', 'coffee', 'tea',
  'chipotle', 'mcdonalds', 'subway', 'starbucks', 'shake', 'smoothie',
  'salad', 'sandwich', 'burger', 'pizza', 'chicken', 'eggs', 'toast',
  'oatmeal', 'yogurt', 'fruit', 'rice', 'pasta', 'bowl', 'plate',
];

const WORKOUT_KEYWORDS = [
  'workout', 'worked out', 'gym', 'lift', 'lifted', 'lifting', 'weights',
  'ran', 'run', 'running', 'cardio', 'hiit', 'trained', 'training',
  'exercise', 'exercised', 'squat', 'bench', 'deadlift', 'press',
  'pull', 'push', 'leg day', 'chest', 'back', 'arms', 'shoulders',
  'hiked', 'cycled', 'cycling', 'swam', 'swimming', 'walked', 'miles',
  'reps', 'sets', 'x10', 'x8', 'x12', 'x5', 'x6', '3x', '4x', '5x',
];

const WEIGHT_PATTERNS = [
  /^\d{2,3}\.?\d*\s*(lbs?|pounds?)?(\s+this\s+morning)?$/i,
  /^weigh(ed|s)?\s*(in\s*(at)?)?:?\s*\d{2,3}/i,
  /^scale\s*(says?|showed?)?\s*\d{2,3}/i,
];

const AFFIRMATIVE_WORDS = [
  'yes', 'yeah', 'yep', 'yup', 'correct', 'right', 'sure', 'ok', 'okay',
  'sounds good', 'perfect', 'that\'s right', 'thats right', 'log it',
  'confirmed', 'confirm', 'y', 'ye', 'yas', 'absolutely', 'definitely',
];

const NEGATIVE_WORDS = [
  'no', 'nope', 'nah', 'wrong', 'incorrect', 'not right', 'actually',
  'wait', 'hold on', 'change', 'fix', 'different',
];

const GREETING_WORDS = [
  'hi', 'hello', 'hey', 'sup', 'yo', 'good morning', 'good afternoon',
  'good evening', 'howdy', 'what\'s up', 'whats up',
];

const QUESTION_WORDS = [
  'how', 'what', 'why', 'when', 'should', 'can', 'is', 'are', 'do', 'does',
  'will', 'would', 'could', '?',
];

// Data query patterns - user asking about their logged data (NOT logging new food)
const DATA_QUERY_PATTERNS = [
  /what (have|did|had) i (eat|eaten|have|log|had)/i,
  /what i (ate|eaten|had|logged)/i,
  /show me (my|what|today)/i,
  /how (much|many) (calories|protein|carbs|have i)/i,
  /what('s| is| was) my (progress|streak|weight|total)/i,
  /tell me (about |what )?(my|i)/i,
  /how am i doing/i,
  /^my (progress|stats|summary|totals)/i,
  /how('s| is) my (day|progress|diet)/i,
];

/**
 * Fast pattern-based classification (no LLM call)
 */
function quickClassify(message: string, hasMedia: boolean): ClassifiedMessage | null {
  const lower = message.toLowerCase().trim();
  const words = lower.split(/\s+/);

  // Photo with food context
  if (hasMedia) {
    return {
      intent: 'food_photo',
      confidence: 'high',
      rawMessage: message,
    };
  }

  // Commands (highest priority)
  for (const cmd of COMMANDS) {
    if (lower.startsWith(cmd)) {
      return {
        intent: 'command',
        confidence: 'high',
        command: cmd,
        rawMessage: message,
      };
    }
  }

  // Settings change requests (natural language)
  if (isSettingsRequest(message)) {
    return {
      intent: 'settings_change',
      confidence: 'high',
      rawMessage: message,
    };
  }

  // Data queries - asking about logged data (BEFORE food/workout keywords)
  // e.g., "What have I eaten today?" should be a question, not food_log
  for (const pattern of DATA_QUERY_PATTERNS) {
    if (pattern.test(lower)) {
      return {
        intent: 'question',
        confidence: 'high',
        rawMessage: message,
      };
    }
  }

  // Weight logging
  for (const pattern of WEIGHT_PATTERNS) {
    if (pattern.test(lower)) {
      return {
        intent: 'weight_log',
        confidence: 'high',
        rawMessage: message,
      };
    }
  }

  // Simple affirmative/negative (short responses)
  if (words.length <= 4) {
    const isAffirmative = AFFIRMATIVE_WORDS.some(w => lower.includes(w));
    const isNegative = NEGATIVE_WORDS.some(w => lower.includes(w));

    if (isAffirmative && !isNegative) {
      return {
        intent: 'confirmation',
        confidence: 'high',
        isAffirmative: true,
        rawMessage: message,
      };
    }

    if (isNegative && !isAffirmative) {
      // Check if it includes a correction
      const numberMatch = message.match(/\d+/);
      if (numberMatch) {
        return {
          intent: 'correction',
          confidence: 'medium',
          isAffirmative: false,
          correctionValue: numberMatch[0],
          rawMessage: message,
        };
      }

      return {
        intent: 'confirmation',
        confidence: 'high',
        isAffirmative: false,
        rawMessage: message,
      };
    }
  }

  // Simple greetings
  if (words.length <= 3 && GREETING_WORDS.some(w => lower.includes(w))) {
    return {
      intent: 'greeting',
      confidence: 'high',
      rawMessage: message,
    };
  }

  // Food keywords with high confidence
  const foodMatches = FOOD_KEYWORDS.filter(kw => lower.includes(kw)).length;
  const workoutMatches = WORKOUT_KEYWORDS.filter(kw => lower.includes(kw)).length;

  if (foodMatches >= 2 && foodMatches > workoutMatches) {
    return {
      intent: 'food_log',
      confidence: 'high',
      rawMessage: message,
    };
  }

  if (workoutMatches >= 2 && workoutMatches > foodMatches) {
    return {
      intent: 'workout_log',
      confidence: 'high',
      rawMessage: message,
    };
  }

  // Questions
  if (lower.includes('?') || QUESTION_WORDS.some(w => lower.startsWith(w + ' '))) {
    return {
      intent: 'question',
      confidence: 'medium',
      rawMessage: message,
    };
  }

  // Not confident enough for quick classification
  return null;
}

/**
 * LLM-based classification for ambiguous messages
 */
async function llmClassify(message: string, context?: { lastIntent?: string }): Promise<ClassifiedMessage> {
  const systemPrompt = `You are an intent classifier for a fitness coaching SMS app. Classify the user's message into exactly one of these intents:

- food_log: User is reporting what they ate/drank (e.g., "Had eggs for breakfast", "Chipotle bowl", "2 scoops protein powder")
- workout_log: User is reporting exercise (e.g., "Did chest today", "Ran 3 miles", "Bench 185x8")
- weight_log: User is reporting their weight (e.g., "183.5 this morning", "Weighed in at 180")
- settings_change: User wants to change a setting (e.g., "Change my timezone to Tokyo", "Set my calorie target to 2000", "Switch to the friend coaching style")
- question: User is asking about nutrition, fitness, or how to use the app (e.g., "How much protein should I eat?", "What's creatine?")
- confirmation: User is confirming or denying something (e.g., "Yes", "No", "Correct", "That's wrong")
- correction: User is correcting previously logged data (e.g., "No it was 8oz", "Actually 200 calories")
- freeform: General conversation, venting, thanks, or doesn't fit other categories

${context?.lastIntent ? `Context: The last interaction was a "${context.lastIntent}" - consider if this is a follow-up.` : ''}

Respond with JSON only: {"intent": "...", "confidence": "high|medium|low"}`;

  try {
    const response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: MAX_TOKENS.classification,
      messages: [
        { role: 'user', content: message }
      ],
      system: systemPrompt,
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);

    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        intent: parsed.intent as Intent,
        confidence: parsed.confidence || 'medium',
        rawMessage: message,
      };
    }
  } catch (error) {
    console.error('LLM classification error:', error);
  }

  // Fallback
  return {
    intent: 'freeform',
    confidence: 'low',
    rawMessage: message,
  };
}

/**
 * Classify an incoming message
 */
export async function classifyMessage(
  message: string,
  hasMedia: boolean = false,
  context?: { lastIntent?: string; user?: User }
): Promise<ClassifiedMessage> {
  // Try quick classification first
  const quick = quickClassify(message, hasMedia);

  if (quick && quick.confidence === 'high') {
    return quick;
  }

  // For medium confidence or no match, use LLM
  if (quick && quick.confidence === 'medium') {
    // Use quick result but could enhance with LLM if needed
    return quick;
  }

  // Fall back to LLM
  return llmClassify(message, { lastIntent: context?.lastIntent });
}

/**
 * Check if a message is a number (for menu selections, etc.)
 */
export function isMenuSelection(message: string): number | null {
  const cleaned = message.trim();
  if (/^[1-9]$/.test(cleaned)) {
    return parseInt(cleaned, 10);
  }
  return null;
}

/**
 * Check if user wants to exit/cancel
 */
export function isExitCommand(message: string): boolean {
  const lower = message.toLowerCase().trim();
  return ['done', 'exit', 'back', 'cancel', 'quit', 'nevermind', 'never mind'].includes(lower);
}
