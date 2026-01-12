import { User, MealType, FoodInputType, Prisma } from '@prisma/client';
import prisma from '../lib/db';
import anthropic, {
  CLAUDE_MODEL,
  CLAUDE_VISION_MODEL,
  MAX_TOKENS,
  callClaudeWithRetry,
  getUserFriendlyErrorMessage,
} from '../lib/claude';
import { fetchWithTimeout } from '../lib/fetch-with-timeout';
import { sendSMS, sendSMSWithEffect, SendStyle } from '../services/sendblue';
import { getTodayDate, getCurrentTimeDecimal, percentage } from '../lib/calculations';
import { MEAL_WINDOWS } from '../config';

// Error result type for parsing functions
interface ParseError {
  type: 'api_error' | 'parse_error' | 'image_fetch_error';
  message: string;
  userMessage: string;
}

// Types
export interface FoodItem {
  name: string;
  quantity: string;
  calories: number;
  protein: number;
}

export interface ParsedFood {
  items: FoodItem[];
  totalCalories: number;
  totalProtein: number;
  confidence: 'high' | 'medium' | 'low';
  mealType: MealType;
}

export type ParseResult = { success: true; data: ParsedFood } | { success: false; error: ParseError };

/**
 * Determine meal type based on time of day
 */
function getMealTypeFromTime(timezone: string): MealType {
  const hour = getCurrentTimeDecimal(timezone);

  if (hour >= MEAL_WINDOWS.breakfast.start && hour < MEAL_WINDOWS.breakfast.end) {
    return 'breakfast';
  } else if (hour >= MEAL_WINDOWS.lunch.start && hour < MEAL_WINDOWS.lunch.end) {
    return 'lunch';
  } else if (hour >= MEAL_WINDOWS.dinner.start && hour < MEAL_WINDOWS.dinner.end) {
    return 'dinner';
  }
  return 'snack';
}

// Meal type keywords for parsing user intent
const MEAL_KEYWORDS: Record<string, MealType> = {
  // Breakfast
  'breakfast': 'breakfast',
  'bfast': 'breakfast',
  'morning': 'breakfast',
  'for breakfast': 'breakfast',
  'had breakfast': 'breakfast',
  // Lunch
  'lunch': 'lunch',
  'for lunch': 'lunch',
  'had lunch': 'lunch',
  'midday': 'lunch',
  // Dinner
  'dinner': 'dinner',
  'for dinner': 'dinner',
  'had dinner': 'dinner',
  'supper': 'dinner',
  'evening': 'dinner',
  // Snack
  'snack': 'snack',
  'snacking': 'snack',
  'for snack': 'snack',
  'for a snack': 'snack',
};

/**
 * Extract meal type from user message if specified
 * Returns the meal type and the message with meal keywords removed
 */
function extractMealType(message: string): { mealType: MealType | null; cleanedMessage: string } {
  const lower = message.toLowerCase();

  // Check for explicit meal type patterns like "breakfast: eggs" or "for breakfast, had eggs"
  for (const [keyword, mealType] of Object.entries(MEAL_KEYWORDS)) {
    // Check for "meal: food" pattern
    const colonPattern = new RegExp(`^${keyword}[:\\s-]+`, 'i');
    if (colonPattern.test(message)) {
      return {
        mealType,
        cleanedMessage: message.replace(colonPattern, '').trim(),
      };
    }

    // Check for "for meal" or "had meal" patterns
    if (lower.includes(keyword)) {
      // Don't match if keyword is part of a larger word (e.g., "launching" contains "lunch")
      const wordBoundaryPattern = new RegExp(`\\b${keyword}\\b`, 'i');
      if (wordBoundaryPattern.test(lower)) {
        // Remove the meal keyword from the message for cleaner parsing
        const cleanedMessage = message.replace(new RegExp(`\\b${keyword}[,:\\s]*\\b`, 'gi'), '').trim();
        return {
          mealType,
          cleanedMessage: cleanedMessage || message, // Keep original if removing leaves nothing
        };
      }
    }
  }

  return { mealType: null, cleanedMessage: message };
}

/**
 * Parse food from text description using LLM with retry
 */
async function parseFoodFromText(
  description: string,
  user: User
): Promise<ParseResult> {
  const systemPrompt = `You are a nutrition parser for a fitness tracking app. Parse the user's food description and estimate macros.

Rules:
1. Identify each distinct food item
2. Estimate reasonable portion sizes if not specified
3. Provide calorie and protein estimates
4. Be realistic - a "bowl" of rice is about 1-1.5 cups
5. For restaurant/brand foods, use typical serving sizes
${user.dietaryRestrictions.length > 0 ? `6. User has dietary restrictions: ${user.dietaryRestrictions.join(', ')}` : ''}

Common portion references:
- Chicken breast: 6oz = 280 cal, 52g protein
- Rice (1 cup cooked): 205 cal, 4g protein
- Eggs (1 large): 70 cal, 6g protein
- Protein shake (1 scoop): 120 cal, 24g protein

Return JSON only:
{
  "items": [
    { "name": "food name", "quantity": "amount", "calories": number, "protein": number }
  ],
  "totalCalories": number,
  "totalProtein": number,
  "confidence": "high" | "medium" | "low"
}`;

  const result = await callClaudeWithRetry(
    () =>
      anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: MAX_TOKENS.foodParsing,
        system: systemPrompt,
        messages: [{ role: 'user', content: description }],
      }),
    { label: 'Food text parsing' }
  );

  if (!result.success) {
    return {
      success: false,
      error: {
        type: 'api_error',
        message: result.error?.message || 'Unknown error',
        userMessage: getUserFriendlyErrorMessage(result.error!),
      },
    };
  }

  const response = result.data!;
  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);

  if (!jsonMatch) {
    return {
      success: false,
      error: {
        type: 'parse_error',
        message: 'Could not extract JSON from response',
        userMessage: `I couldn't understand "${description.slice(0, 30)}...". Try being more specific, like "2 eggs scrambled" or "chicken breast 6oz".`,
      },
    };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.items || parsed.items.length === 0) {
      return {
        success: false,
        error: {
          type: 'parse_error',
          message: 'No food items identified',
          userMessage: `I couldn't identify any food in "${description.slice(0, 30)}...". Can you describe it differently?`,
        },
      };
    }

    return {
      success: true,
      data: {
        items: parsed.items || [],
        totalCalories: parsed.totalCalories || 0,
        totalProtein: parsed.totalProtein || 0,
        confidence: parsed.confidence || 'medium',
        mealType: getMealTypeFromTime(user.timezone),
      },
    };
  } catch {
    return {
      success: false,
      error: {
        type: 'parse_error',
        message: 'Failed to parse JSON response',
        userMessage: "I had trouble understanding that. Can you describe your food more simply?",
      },
    };
  }
}

/**
 * Parse food from photo using Vision AI with retry
 */
async function parseFoodFromPhoto(
  photoUrl: string,
  user: User
): Promise<ParseResult> {
  const systemPrompt = `You are analyzing a food photo for macro estimation.

Identify each food item visible. For each item, estimate:
- What it is
- Approximate portion size (be realistic based on plate size)
- Calories
- Protein (grams)

${user.dietaryRestrictions.length > 0 ? `User has dietary restrictions: ${user.dietaryRestrictions.join(', ')}` : ''}

Return JSON only:
{
  "items": [
    { "name": "grilled chicken breast", "quantity": "6 oz", "calories": 280, "protein": 52 }
  ],
  "totalCalories": number,
  "totalProtein": number,
  "confidence": "high" | "medium" | "low",
  "notes": "optional notes about estimation"
}`;

  // Fetch the image with timeout
  let base64Image: string;
  let mediaType: string;

  try {
    const imageResponse = await fetchWithTimeout(photoUrl, { timeoutMs: 15000 });
    if (!imageResponse.ok) {
      return {
        success: false,
        error: {
          type: 'image_fetch_error',
          message: `Failed to fetch image: ${imageResponse.status}`,
          userMessage: "I couldn't download that photo. Can you try sending it again?",
        },
      };
    }
    const imageBuffer = await imageResponse.arrayBuffer();
    base64Image = Buffer.from(imageBuffer).toString('base64');
    mediaType = imageResponse.headers.get('content-type') || 'image/jpeg';
  } catch (error) {
    console.error('Image fetch error:', error);
    return {
      success: false,
      error: {
        type: 'image_fetch_error',
        message: error instanceof Error ? error.message : 'Image fetch failed',
        userMessage: "I couldn't load that photo. Can you try sending it again, or describe what's on your plate?",
      },
    };
  }

  const result = await callClaudeWithRetry(
    () =>
      anthropic.messages.create({
        model: CLAUDE_VISION_MODEL,
        max_tokens: MAX_TOKENS.foodParsing,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
                  data: base64Image,
                },
              },
              {
                type: 'text',
                text: systemPrompt,
              },
            ],
          },
        ],
      }),
    { label: 'Food photo parsing' }
  );

  if (!result.success) {
    return {
      success: false,
      error: {
        type: 'api_error',
        message: result.error?.message || 'Unknown error',
        userMessage: getUserFriendlyErrorMessage(result.error!),
      },
    };
  }

  const response = result.data!;
  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);

  if (!jsonMatch) {
    return {
      success: false,
      error: {
        type: 'parse_error',
        message: 'Could not extract JSON from vision response',
        userMessage: "I'm having trouble analyzing that photo. Try with better lighting, or just tell me what's on your plate.",
      },
    };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.items || parsed.items.length === 0) {
      return {
        success: false,
        error: {
          type: 'parse_error',
          message: 'No food items identified in photo',
          userMessage: "I couldn't identify any food in that photo. Can you try a clearer photo or describe what you're eating?",
        },
      };
    }

    return {
      success: true,
      data: {
        items: parsed.items || [],
        totalCalories: parsed.totalCalories || 0,
        totalProtein: parsed.totalProtein || 0,
        confidence: parsed.confidence || 'medium',
        mealType: getMealTypeFromTime(user.timezone),
      },
    };
  } catch {
    return {
      success: false,
      error: {
        type: 'parse_error',
        message: 'Failed to parse vision JSON response',
        userMessage: "I had trouble understanding what's in that photo. Can you describe it instead?",
      },
    };
  }
}

/**
 * Get or create today's daily log
 */
async function getOrCreateDailyLog(user: User) {
  const today = getTodayDate(user.timezone);

  let dailyLog = await prisma.dailyLog.findUnique({
    where: {
      userId_date: {
        userId: user.id,
        date: today,
      },
    },
  });

  if (!dailyLog) {
    dailyLog = await prisma.dailyLog.create({
      data: {
        userId: user.id,
        date: today,
        calorieTarget: user.calorieTarget,
        proteinTarget: user.proteinTarget,
      },
    });
  }

  return dailyLog;
}

/**
 * Format parsed food for confirmation message
 */
function formatFoodConfirmation(parsed: ParsedFood, mealType: MealType): string {
  if (parsed.items.length === 0) {
    return "I couldn't identify the food. Can you describe it differently?";
  }

  const mealLabel = mealType.charAt(0).toUpperCase() + mealType.slice(1);
  let message = `Here's what I ${parsed.confidence === 'low' ? 'think I ' : ''}see:\n`;

  for (const item of parsed.items) {
    message += `• ${item.name} (${item.quantity}) — ${item.calories} cal, ${item.protein}g protein\n`;
  }

  message += `\nTotal: ${parsed.totalCalories} cal, ${parsed.totalProtein}g protein`;

  if (parsed.confidence !== 'high') {
    message += `\n\nIs that right? Reply 'yes' to log, or tell me what's different.`;
  }

  return message;
}

/**
 * Format logged food with daily totals
 */
function formatLoggedResponse(
  parsed: ParsedFood,
  dailyLog: { caloriesTotal: number; proteinTotal: number; calorieTarget: number | null; proteinTarget: number | null },
  mealType: MealType
): string {
  const mealLabel = mealType.charAt(0).toUpperCase() + mealType.slice(1);
  let message = `Got it! Logged for ${mealLabel.toLowerCase()}:\n`;

  for (const item of parsed.items) {
    message += `• ${item.name} (${item.quantity}) — ${item.calories} cal, ${item.protein}g protein\n`;
  }

  message += `\nTotal: ${parsed.totalCalories} cal, ${parsed.totalProtein}g protein`;

  // Add daily totals
  const calorieTarget = dailyLog.calorieTarget || 2000;
  const proteinTarget = dailyLog.proteinTarget || 150;
  const caloriesRemaining = calorieTarget - dailyLog.caloriesTotal;
  const proteinRemaining = proteinTarget - dailyLog.proteinTotal;

  message += `\n\nToday so far: ${dailyLog.caloriesTotal.toLocaleString()} cal, ${dailyLog.proteinTotal}g protein`;
  message += `\n(${caloriesRemaining > 0 ? caloriesRemaining.toLocaleString() : 0} cal, ${proteinRemaining > 0 ? proteinRemaining : 0}g protein remaining)`;

  return message;
}

/**
 * Handle text-based food logging
 */
export async function handleFoodLog(
  user: User,
  message: string
): Promise<void> {
  // Extract meal type if user specified it
  const { mealType: userMealType, cleanedMessage } = extractMealType(message);

  // Parse the food
  const result = await parseFoodFromText(cleanedMessage, user);

  if (!result.success) {
    await sendSMS(user.phone, result.error.userMessage);
    return;
  }

  const parsed = result.data;

  // Override meal type if user specified it
  if (userMealType) {
    parsed.mealType = userMealType;
  }

  // For high confidence, log directly
  // For medium/low, store pending and ask for confirmation
  if (parsed.confidence === 'high') {
    await logFood(user, parsed, 'text', message);
  } else {
    // Store pending entry for confirmation
    await prisma.conversationContext.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        pendingFoodEntry: parsed as unknown as object,
        lastIntent: 'food_log',
      },
      update: {
        pendingFoodEntry: parsed as unknown as object,
        lastIntent: 'food_log',
        lastMessageAt: new Date(),
      },
    });

    await sendSMS(user.phone, formatFoodConfirmation(parsed, parsed.mealType));
  }
}

/**
 * Handle photo-based food logging
 */
export async function handleFoodPhoto(
  user: User,
  photoUrl: string
): Promise<void> {
  // Parse the photo
  const result = await parseFoodFromPhoto(photoUrl, user);

  if (!result.success) {
    await sendSMS(user.phone, result.error.userMessage);
    return;
  }

  const parsed = result.data;

  // Always ask for confirmation with photos
  await prisma.conversationContext.upsert({
    where: { userId: user.id },
    create: {
      userId: user.id,
      pendingFoodEntry: { ...parsed, photoUrl } as unknown as object,
      lastIntent: 'food_photo',
    },
    update: {
      pendingFoodEntry: { ...parsed, photoUrl } as unknown as object,
      lastIntent: 'food_photo',
      lastMessageAt: new Date(),
    },
  });

  await sendSMS(user.phone, formatFoodConfirmation(parsed, parsed.mealType));
}

/**
 * Handle food confirmation
 */
export async function handleFoodConfirmation(
  user: User,
  isConfirmed: boolean,
  correctionValue?: string
): Promise<void> {
  const context = await prisma.conversationContext.findUnique({
    where: { userId: user.id },
  });

  if (!context?.pendingFoodEntry) {
    await sendSMS(user.phone, "I don't have a pending food entry to confirm. What did you eat?");
    return;
  }

  const pending = context.pendingFoodEntry as unknown as ParsedFood & { photoUrl?: string };

  if (isConfirmed) {
    // Log the food
    const inputType: FoodInputType = pending.photoUrl ? 'photo' : 'text';
    await logFood(user, pending, inputType, pending.photoUrl || 'confirmed');

    // Clear pending
    await prisma.conversationContext.update({
      where: { userId: user.id },
      data: { pendingFoodEntry: Prisma.DbNull, lastIntent: null },
    });
  } else if (correctionValue) {
    // Handle correction - for now, just ask them to re-enter
    await prisma.conversationContext.update({
      where: { userId: user.id },
      data: { pendingFoodEntry: Prisma.DbNull, lastIntent: null },
    });

    await sendSMS(
      user.phone,
      `Got it, that wasn't right. Can you tell me what you had? Be specific about portions if you can.`
    );
  } else {
    // They said no but didn't provide correction
    await sendSMS(
      user.phone,
      "No problem. What should I change? You can tell me the correct portions or items."
    );
  }
}

/**
 * Log confirmed food entry
 */
async function logFood(
  user: User,
  parsed: ParsedFood,
  inputType: FoodInputType,
  rawInput: string,
  photoUrl?: string
): Promise<void> {
  const dailyLog = await getOrCreateDailyLog(user);

  // Create food entry
  await prisma.foodEntry.create({
    data: {
      userId: user.id,
      dailyLogId: dailyLog.id,
      mealType: parsed.mealType,
      inputType,
      rawInput,
      photoUrl,
      foodItems: JSON.parse(JSON.stringify(parsed.items)),
      calories: parsed.totalCalories,
      protein: parsed.totalProtein,
      userConfirmed: true,
    },
  });

  // Update daily log totals
  const newCalories = dailyLog.caloriesTotal + parsed.totalCalories;
  const newProtein = dailyLog.proteinTotal + parsed.totalProtein;

  const mealFlags: Record<string, boolean> = {};
  if (parsed.mealType === 'breakfast') mealFlags.breakfastLogged = true;
  if (parsed.mealType === 'lunch') mealFlags.lunchLogged = true;
  if (parsed.mealType === 'dinner') mealFlags.dinnerLogged = true;

  const updatedLog = await prisma.dailyLog.update({
    where: { id: dailyLog.id },
    data: {
      caloriesTotal: newCalories,
      proteinTotal: newProtein,
      ...mealFlags,
    },
  });

  // Update streak
  await updateStreak(user);

  // Send confirmation
  await sendSMS(
    user.phone,
    formatLoggedResponse(
      parsed,
      {
        caloriesTotal: newCalories,
        proteinTotal: newProtein,
        calorieTarget: dailyLog.calorieTarget,
        proteinTarget: dailyLog.proteinTarget,
      },
      parsed.mealType
    )
  );
}

/**
 * Update user's logging streak
 */
async function updateStreak(user: User): Promise<void> {
  const today = getTodayDate(user.timezone);
  const todayStr = today.toISOString().split('T')[0];
  const lastLoggedStr = user.streakLastLogged?.toISOString().split('T')[0];

  if (todayStr === lastLoggedStr) {
    // Already logged today, no streak update needed
    return;
  }

  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];

  let newStreak: number;
  let streakJustBroken: number | null = null;

  if (lastLoggedStr === yesterdayStr) {
    // Consecutive day - increment streak
    newStreak = user.loggingStreakDays + 1;
  } else if (!lastLoggedStr) {
    // First time logging
    newStreak = 1;
  } else {
    // Streak broken
    if (user.loggingStreakDays >= 7) {
      streakJustBroken = user.loggingStreakDays;
    }
    newStreak = 1;
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      loggingStreakDays: newStreak,
      streakLastLogged: today,
      totalDaysLogged: user.totalDaysLogged + (todayStr !== lastLoggedStr ? 1 : 0),
      streakJustBroken,
      lastMessageAt: new Date(),
    },
  });

  // Send streak recovery message when streak breaks
  if (streakJustBroken !== null && streakJustBroken >= 3) {
    const daysSinceLastLog = lastLoggedStr
      ? Math.floor((today.getTime() - new Date(lastLoggedStr).getTime()) / (1000 * 60 * 60 * 24))
      : 0;

    let recoveryMessage: string;

    if (streakJustBroken >= 14) {
      // Long streak broken - emphasize the accomplishment
      recoveryMessage = `Your ${streakJustBroken}-day streak ended, but that's ${streakJustBroken} days of progress that can't be erased. Day 1 starts now. 💪`;
    } else if (streakJustBroken >= 7) {
      // Week+ streak broken
      recoveryMessage = `That was a solid ${streakJustBroken}-day run. Life happens. You're back, and that's what matters.`;
    } else {
      // 3-6 day streak broken
      recoveryMessage = `Starting fresh. ${daysSinceLastLog > 3 ? "Everything okay? " : ""}Back at it. 👊`;
    }

    // Send after a short delay so it doesn't interrupt the food log response
    setTimeout(async () => {
      await sendSMS(user.phone, recoveryMessage);
    }, 3000);
  }

  // Check for streak milestones
  interface StreakMilestone {
    message: string;
    effect: SendStyle;
  }

  const milestoneConfig: Record<number, StreakMilestone> = {
    7: {
      message: "One week streak! 🔥 Consistency is everything. Keep going.",
      effect: 'confetti',
    },
    14: {
      message: "Two weeks straight. You're building a real habit. 💪",
      effect: 'confetti',
    },
    21: {
      message: "Three weeks! 🎯 They say it takes 21 days to form a habit. You're there.",
      effect: 'celebration',
    },
    30: {
      message: "30 DAYS! 🏆 You're in the top 10% of people who try to track. This is becoming part of who you are.",
      effect: 'celebration',
    },
    50: {
      message: "50 days. Incredible. This isn't a streak anymore — it's just what you do.",
      effect: 'fireworks',
    },
    100: {
      message: "💯 ONE HUNDRED DAYS. You've logged more consistently than most people ever will. Respect.",
      effect: 'fireworks',
    },
  };

  const milestone = milestoneConfig[newStreak];
  if (milestone) {
    // Send milestone message after a short delay with celebratory effect
    setTimeout(async () => {
      await sendSMSWithEffect(user.phone, milestone.message, milestone.effect);
    }, 2000);
  }
}

/**
 * Handle "same as yesterday" quick log
 */
export async function handleQuickLog(
  user: User,
  mealType: MealType
): Promise<void> {
  const yesterday = new Date(getTodayDate(user.timezone));
  yesterday.setDate(yesterday.getDate() - 1);

  const yesterdayEntry = await prisma.foodEntry.findFirst({
    where: {
      userId: user.id,
      mealType,
      loggedAt: {
        gte: yesterday,
        lt: getTodayDate(user.timezone),
      },
    },
    orderBy: { loggedAt: 'desc' },
  });

  if (!yesterdayEntry) {
    await sendSMS(
      user.phone,
      `I don't have a ${mealType} logged from yesterday. What did you have today?`
    );
    return;
  }

  const items = yesterdayEntry.foodItems as unknown as FoodItem[];
  const itemSummary = items.map(i => i.name).join(', ');

  const pendingEntry = {
    items,
    totalCalories: yesterdayEntry.calories,
    totalProtein: yesterdayEntry.protein,
    confidence: 'high',
    mealType,
  };

  await prisma.conversationContext.upsert({
    where: { userId: user.id },
    create: {
      userId: user.id,
      pendingFoodEntry: JSON.parse(JSON.stringify(pendingEntry)),
      lastIntent: 'quick_log',
    },
    update: {
      pendingFoodEntry: JSON.parse(JSON.stringify(pendingEntry)),
      lastIntent: 'quick_log',
      lastMessageAt: new Date(),
    },
  });

  await sendSMS(
    user.phone,
    `Yesterday's ${mealType} was ${itemSummary} (${yesterdayEntry.calories} cal, ${yesterdayEntry.protein}g protein). Log that again?`
  );
}

/**
 * Get today's food summary
 */
export async function getTodaySummary(user: User): Promise<string> {
  const dailyLog = await getOrCreateDailyLog(user);

  const calorieTarget = dailyLog.calorieTarget || user.calorieTarget || 2000;
  const proteinTarget = dailyLog.proteinTarget || user.proteinTarget || 150;

  const caloriesRemaining = Math.max(0, calorieTarget - dailyLog.caloriesTotal);
  const proteinRemaining = Math.max(0, proteinTarget - dailyLog.proteinTotal);

  const calPct = percentage(dailyLog.caloriesTotal, calorieTarget);
  const protPct = percentage(dailyLog.proteinTotal, proteinTarget);

  const meals = [
    dailyLog.breakfastLogged ? 'Breakfast ✓' : 'Breakfast ✗',
    dailyLog.lunchLogged ? 'Lunch ✓' : 'Lunch ✗',
    dailyLog.dinnerLogged ? 'Dinner ✓' : 'Dinner ✗',
  ].join(', ');

  let message = `Today so far:\n`;
  message += `🔥 ${dailyLog.caloriesTotal.toLocaleString()} / ${calorieTarget.toLocaleString()} cal (${caloriesRemaining.toLocaleString()} remaining)\n`;
  message += `💪 ${dailyLog.proteinTotal} / ${proteinTarget}g protein (${proteinRemaining}g remaining)\n\n`;
  message += `Meals logged: ${meals}`;

  // Add contextual tip
  if (proteinRemaining > 40 && caloriesRemaining < 300) {
    message += `\n\nTip: You're low on calories but need ${proteinRemaining}g protein. Try a protein shake or Greek yogurt.`;
  } else if (calPct > 90 && protPct < 70) {
    message += `\n\nHeads up: Calories are almost done but protein is at ${protPct}%. Prioritize protein for your remaining intake.`;
  }

  return message;
}
