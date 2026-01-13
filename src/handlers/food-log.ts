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
import heicConvert from 'heic-convert';

// Threshold for asking meal vs snack (calories)
const SMALL_FOOD_THRESHOLD = 400;

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
 * Detect image type from magic bytes (file signature)
 * More reliable than content-type headers
 */
function detectImageType(data: Uint8Array): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | 'image/heic' | null {
  if (data.length < 12) {
    console.log('Image data too short for format detection');
    return null;
  }

  // JPEG: starts with FF D8 FF
  if (data[0] === 0xFF && data[1] === 0xD8 && data[2] === 0xFF) {
    return 'image/jpeg';
  }

  // PNG: starts with 89 50 4E 47 (‰PNG)
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47) {
    return 'image/png';
  }

  // GIF: starts with 47 49 46 38 (GIF8)
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) {
    return 'image/gif';
  }

  // WebP: starts with 52 49 46 46 (RIFF) and has WEBP at offset 8
  if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
      data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) {
    return 'image/webp';
  }

  // HEIC/HEIF: has 'ftyp' at offset 4 - needs conversion
  if (data[4] === 0x66 && data[5] === 0x74 && data[6] === 0x79 && data[7] === 0x70) {
    console.log('Detected HEIC/HEIF format - will convert to JPEG');
    return 'image/heic';
  }

  console.log(`Unknown format. First 12 bytes: ${Array.from(data.slice(0, 12)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
  return null;
}

/**
 * Convert HEIC image to JPEG using heic-convert
 */
async function convertHeicToJpeg(imageBuffer: Buffer): Promise<Buffer> {
  console.log('Converting HEIC to JPEG...');
  // Pass buffer directly - heic-convert should handle Node Buffer
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const jpegBuffer = await (heicConvert as any)({
    buffer: imageBuffer,
    format: 'JPEG',
    quality: 0.85,
  });
  const result = Buffer.from(jpegBuffer);
  console.log(`Converted HEIC to JPEG: ${imageBuffer.length} bytes -> ${result.length} bytes`);
  return result;
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

  // Fetch and validate image
  let base64Image: string;
  let mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

  try {
    console.log(`Fetching photo from URL: ${photoUrl.substring(0, 100)}...`);
    const imageResponse = await fetchWithTimeout(photoUrl, { timeoutMs: 15000 });

    if (!imageResponse.ok) {
      console.error(`Image fetch failed with status ${imageResponse.status}`);
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
    const uint8Array = new Uint8Array(imageBuffer);

    // Detect actual image type from magic bytes
    const detectedType = detectImageType(uint8Array);
    const contentType = imageResponse.headers.get('content-type') || 'unknown';

    console.log(`Image details: content-type=${contentType}, detected=${detectedType}, size=${imageBuffer.byteLength} bytes`);

    if (!detectedType) {
      // Truly unsupported format
      return {
        success: false,
        error: {
          type: 'image_fetch_error',
          message: 'Unsupported image format',
          userMessage: "That image format isn't supported. Try taking the photo with your camera app instead of from your photo library, or just describe what you're eating.",
        },
      };
    }

    // Convert HEIC to JPEG if needed
    let finalBuffer: Buffer;
    if (detectedType === 'image/heic') {
      try {
        finalBuffer = await convertHeicToJpeg(Buffer.from(imageBuffer));
        mediaType = 'image/jpeg';
      } catch (conversionError) {
        console.error('HEIC conversion failed:', conversionError);
        return {
          success: false,
          error: {
            type: 'image_fetch_error',
            message: 'Failed to convert HEIC image',
            userMessage: "I couldn't process that photo format. Try taking the photo directly with your camera, or describe what you're eating.",
          },
        };
      }
    } else {
      finalBuffer = Buffer.from(imageBuffer);
      mediaType = detectedType;
    }

    base64Image = finalBuffer.toString('base64');

    // Validate base64 length is reasonable
    if (base64Image.length < 100) {
      console.error('Base64 image too small, likely corrupt');
      return {
        success: false,
        error: {
          type: 'image_fetch_error',
          message: 'Image appears corrupt or empty',
          userMessage: "That image looks corrupt. Can you try sending it again?",
        },
      };
    }

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
                  media_type: mediaType,
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
    console.error('Food photo parsing failed:', {
      errorType: result.error?.type,
      errorMessage: result.error?.message,
      attempts: result.attempts,
    });
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
function formatFoodConfirmation(parsed: ParsedFood, mealType: MealType, askMealType: boolean = false): string {
  if (parsed.items.length === 0) {
    return "I couldn't identify the food. Can you describe it differently?";
  }

  let message = `Here's what I ${parsed.confidence === 'low' ? 'think I ' : ''}see:\n`;

  for (const item of parsed.items) {
    message += `• ${item.name} (${item.quantity}) — ${item.calories} cal, ${item.protein}g protein\n`;
  }

  message += `\nTotal: ${parsed.totalCalories} cal, ${parsed.totalProtein}g protein`;

  // For small foods, ask if it's a meal or snack
  if (askMealType) {
    message += `\n\nMeal or snack?`;
  } else if (parsed.confidence !== 'high') {
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

  // Add daily totals (round to whole numbers to avoid floating point display issues)
  const calorieTarget = dailyLog.calorieTarget || 2000;
  const proteinTarget = dailyLog.proteinTarget || 150;
  const caloriesRemaining = Math.round(calorieTarget - dailyLog.caloriesTotal);
  const proteinRemaining = Math.round(proteinTarget - dailyLog.proteinTotal);
  const proteinTotal = Math.round(dailyLog.proteinTotal);

  message += `\n\nToday so far: ${dailyLog.caloriesTotal.toLocaleString()} cal, ${proteinTotal}g protein`;
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

  // For small foods without explicit meal type, ask if it's a meal or snack
  const needsMealType = !userMealType && parsed.totalCalories < SMALL_FOOD_THRESHOLD;

  // For high confidence AND not needing meal type confirmation, log directly
  // Otherwise, store pending and ask for confirmation
  if (parsed.confidence === 'high' && !needsMealType) {
    await logFood(user, parsed, 'text', message);
  } else {
    // Store pending entry for confirmation
    await prisma.conversationContext.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        pendingFoodEntry: { ...parsed, needsMealType } as unknown as object,
        lastIntent: 'food_log',
      },
      update: {
        pendingFoodEntry: { ...parsed, needsMealType } as unknown as object,
        lastIntent: 'food_log',
        lastMessageAt: new Date(),
      },
    });

    await sendSMS(user.phone, formatFoodConfirmation(parsed, parsed.mealType, needsMealType));
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

  // For small foods, ask if it's a meal or snack
  const needsMealType = parsed.totalCalories < SMALL_FOOD_THRESHOLD;

  // Always ask for confirmation with photos
  await prisma.conversationContext.upsert({
    where: { userId: user.id },
    create: {
      userId: user.id,
      pendingFoodEntry: { ...parsed, photoUrl, needsMealType } as unknown as object,
      lastIntent: 'food_photo',
    },
    update: {
      pendingFoodEntry: { ...parsed, photoUrl, needsMealType } as unknown as object,
      lastIntent: 'food_photo',
      lastMessageAt: new Date(),
    },
  });

  await sendSMS(user.phone, formatFoodConfirmation(parsed, parsed.mealType, needsMealType));
}

/**
 * Parse a correction and update the pending food entry
 */
async function parseFoodCorrection(
  correctionMessage: string,
  pendingItems: FoodItem[],
  user: User
): Promise<{ success: true; updatedItems: FoodItem[] } | { success: false; error: string }> {
  const itemsList = pendingItems.map((item, i) => `${i + 1}. ${item.name} (${item.quantity}) - ${item.calories} cal, ${item.protein}g protein`).join('\n');

  const systemPrompt = `You are a nutrition parser. The user is correcting a food entry.

CURRENT ITEMS:
${itemsList}

The user is providing a correction. Figure out which item they're correcting and provide the updated nutrition.

Rules:
1. Match the correction to the most likely item (e.g., "chobani greek yogurt" matches "Greek yogurt")
2. Use accurate nutrition for the specified brand/type if mentioned
3. Calculate for the quantity they specify

Common nutrition references:
- Chobani nonfat Greek yogurt: 90 cal, 16g protein per 3/4 cup (170g)
- Fage 0% Greek yogurt: 100 cal, 18g protein per 3/4 cup
- Generic Greek yogurt nonfat: 100 cal, 17g protein per cup

Return JSON only:
{
  "matchedItemIndex": number (0-based index of item being corrected, or -1 if adding new item),
  "updatedItem": { "name": "food name", "quantity": "amount", "calories": number, "protein": number }
}`;

  const result = await callClaudeWithRetry(
    () =>
      anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: MAX_TOKENS.foodParsing,
        system: systemPrompt,
        messages: [{ role: 'user', content: correctionMessage }],
      }),
    { label: 'Food correction parsing' }
  );

  if (!result.success) {
    return { success: false, error: 'Failed to parse correction' };
  }

  const response = result.data!;
  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);

  if (!jsonMatch) {
    return { success: false, error: 'Could not parse correction' };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const updatedItems = [...pendingItems];

    if (parsed.matchedItemIndex >= 0 && parsed.matchedItemIndex < updatedItems.length) {
      // Update existing item
      updatedItems[parsed.matchedItemIndex] = parsed.updatedItem;
    } else {
      // Add as new item
      updatedItems.push(parsed.updatedItem);
    }

    return { success: true, updatedItems };
  } catch {
    return { success: false, error: 'Invalid correction format' };
  }
}

/**
 * Parse meal type from user response
 */
function parseMealTypeResponse(message: string): MealType | null {
  const lower = message.toLowerCase().trim();

  // Direct meal type words
  if (lower === 'snack' || lower.includes('as a snack') || lower.includes('as snack')) {
    return 'snack';
  }
  if (lower === 'meal' || lower === 'breakfast' || lower.includes('as breakfast')) {
    return 'breakfast';
  }
  if (lower === 'lunch' || lower.includes('as lunch') || lower.includes('as a lunch')) {
    return 'lunch';
  }
  if (lower === 'dinner' || lower.includes('as dinner') || lower.includes('as a dinner')) {
    return 'dinner';
  }

  return null;
}

/**
 * Handle meal type selection for pending food entry
 */
export async function handleMealTypeSelection(
  user: User,
  message: string
): Promise<boolean> {
  const context = await prisma.conversationContext.findUnique({
    where: { userId: user.id },
  });

  if (!context?.pendingFoodEntry) {
    return false;
  }

  const pending = context.pendingFoodEntry as unknown as ParsedFood & { photoUrl?: string; needsMealType?: boolean };

  // Only handle if we're waiting for meal type
  if (!pending.needsMealType) {
    return false;
  }

  const mealType = parseMealTypeResponse(message);
  if (!mealType) {
    return false;
  }

  // Update meal type and log
  pending.mealType = mealType;
  const inputType: FoodInputType = pending.photoUrl ? 'photo' : 'text';
  await logFood(user, pending, inputType, pending.photoUrl || 'confirmed');

  // Clear pending
  await prisma.conversationContext.update({
    where: { userId: user.id },
    data: { pendingFoodEntry: Prisma.DbNull, lastIntent: null },
  });

  return true;
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

  const pending = context.pendingFoodEntry as unknown as ParsedFood & { photoUrl?: string; needsMealType?: boolean };

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
    // Smart correction - parse the correction and update specific items
    const correctionResult = await parseFoodCorrection(correctionValue, pending.items, user);

    if (correctionResult.success) {
      // Calculate new totals
      const totalCalories = correctionResult.updatedItems.reduce((sum, item) => sum + item.calories, 0);
      const totalProtein = correctionResult.updatedItems.reduce((sum, item) => sum + item.protein, 0);

      // Update pending entry
      const updatedPending: ParsedFood & { photoUrl?: string } = {
        ...pending,
        items: correctionResult.updatedItems,
        totalCalories,
        totalProtein,
        confidence: 'high', // User corrected it
      };

      await prisma.conversationContext.update({
        where: { userId: user.id },
        data: {
          pendingFoodEntry: JSON.parse(JSON.stringify(updatedPending)),
          lastIntent: 'food_log',
        },
      });

      // Show updated entry for confirmation
      const itemsList = correctionResult.updatedItems
        .map(item => `• ${item.name} (${item.quantity}) — ${item.calories} cal, ${item.protein}g protein`)
        .join('\n');

      await sendSMS(
        user.phone,
        `Updated:\n${itemsList}\n\nTotal: ${totalCalories} cal, ${totalProtein}g protein\n\nLook right?`
      );
    } else {
      // Couldn't parse correction, ask for clarification
      await sendSMS(user.phone, "not sure what to change - can you be more specific?");
    }
  } else {
    // They said no but didn't provide correction
    await sendSMS(
      user.phone,
      "what should I change?"
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

  // Round to whole numbers to avoid floating point display issues
  const caloriesRemaining = Math.round(Math.max(0, calorieTarget - dailyLog.caloriesTotal));
  const proteinRemaining = Math.round(Math.max(0, proteinTarget - dailyLog.proteinTotal));
  const proteinTotal = Math.round(dailyLog.proteinTotal);

  const calPct = percentage(dailyLog.caloriesTotal, calorieTarget);
  const protPct = percentage(dailyLog.proteinTotal, proteinTarget);

  const meals = [
    dailyLog.breakfastLogged ? 'Breakfast ✓' : 'Breakfast ✗',
    dailyLog.lunchLogged ? 'Lunch ✓' : 'Lunch ✗',
    dailyLog.dinnerLogged ? 'Dinner ✓' : 'Dinner ✗',
  ].join(', ');

  let message = `Today so far:\n`;
  message += `🔥 ${dailyLog.caloriesTotal.toLocaleString()} / ${calorieTarget.toLocaleString()} cal (${caloriesRemaining.toLocaleString()} remaining)\n`;
  message += `💪 ${proteinTotal} / ${proteinTarget}g protein (${proteinRemaining}g remaining)\n\n`;
  message += `Meals logged: ${meals}`;

  // Add contextual tip
  if (proteinRemaining > 40 && caloriesRemaining < 300) {
    message += `\n\nTip: You're low on calories but need ${proteinRemaining}g protein. Try a protein shake or Greek yogurt.`;
  } else if (calPct > 90 && protPct < 70) {
    message += `\n\nHeads up: Calories are almost done but protein is at ${protPct}%. Prioritize protein for your remaining intake.`;
  }

  return message;
}
