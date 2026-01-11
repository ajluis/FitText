import { User, MealType, FoodInputType, Prisma } from '@prisma/client';
import prisma from '../lib/db';
import anthropic, { CLAUDE_MODEL, CLAUDE_VISION_MODEL, MAX_TOKENS } from '../lib/claude';
import { sendSMS } from '../services/sendblue';
import { getTodayDate, getCurrentTimeDecimal, percentage } from '../lib/calculations';
import { MEAL_WINDOWS } from '../config';

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

/**
 * Parse food from text description using LLM
 */
async function parseFoodFromText(
  description: string,
  user: User
): Promise<ParsedFood> {
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

  try {
    const response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: MAX_TOKENS.foodParsing,
      system: systemPrompt,
      messages: [{ role: 'user', content: description }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);

    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        items: parsed.items || [],
        totalCalories: parsed.totalCalories || 0,
        totalProtein: parsed.totalProtein || 0,
        confidence: parsed.confidence || 'medium',
        mealType: getMealTypeFromTime(user.timezone),
      };
    }
  } catch (error) {
    console.error('Food parsing error:', error);
  }

  // Fallback
  return {
    items: [],
    totalCalories: 0,
    totalProtein: 0,
    confidence: 'low',
    mealType: getMealTypeFromTime(user.timezone),
  };
}

/**
 * Parse food from photo using Vision AI
 */
async function parseFoodFromPhoto(
  photoUrl: string,
  user: User
): Promise<ParsedFood> {
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

  try {
    // Fetch the image
    const imageResponse = await fetch(photoUrl);
    const imageBuffer = await imageResponse.arrayBuffer();
    const base64Image = Buffer.from(imageBuffer).toString('base64');
    const mediaType = imageResponse.headers.get('content-type') || 'image/jpeg';

    const response = await anthropic.messages.create({
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
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);

    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        items: parsed.items || [],
        totalCalories: parsed.totalCalories || 0,
        totalProtein: parsed.totalProtein || 0,
        confidence: parsed.confidence || 'medium',
        mealType: getMealTypeFromTime(user.timezone),
      };
    }
  } catch (error) {
    console.error('Photo parsing error:', error);
  }

  // Fallback
  return {
    items: [],
    totalCalories: 0,
    totalProtein: 0,
    confidence: 'low',
    mealType: getMealTypeFromTime(user.timezone),
  };
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
  // Parse the food
  const parsed = await parseFoodFromText(message, user);

  if (parsed.items.length === 0) {
    await sendSMS(
      user.phone,
      "I couldn't figure out what that was. Can you describe it differently? Like 'chicken breast 6oz' or 'bowl of rice'."
    );
    return;
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
  const parsed = await parseFoodFromPhoto(photoUrl, user);

  if (parsed.items.length === 0) {
    await sendSMS(
      user.phone,
      "I'm having trouble identifying the food in that photo. Can you try again with better lighting, or just tell me what's on the plate?"
    );
    return;
  }

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

  // Check for streak milestones
  const milestones = [7, 14, 21, 30, 50, 100];
  if (milestones.includes(newStreak)) {
    const messages: Record<number, string> = {
      7: "One week streak! 🔥 Consistency is everything. Keep going.",
      14: "Two weeks straight. You're building a real habit. 💪",
      21: "Three weeks! 🎯 They say it takes 21 days to form a habit. You're there.",
      30: "30 DAYS! 🏆 You're in the top 10% of people who try to track. This is becoming part of who you are.",
      50: "50 days. Incredible. This isn't a streak anymore — it's just what you do.",
      100: "💯 ONE HUNDRED DAYS. You've logged more consistently than most people ever will. Respect.",
    };

    // Send milestone message after a short delay
    setTimeout(async () => {
      await sendSMS(user.phone, messages[newStreak]);
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
