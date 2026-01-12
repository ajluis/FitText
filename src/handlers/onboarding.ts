import { OnboardingStep, PrimaryGoal, ActivityLevel, Sex, User } from '@prisma/client';
import prisma from '../lib/db';
import { config } from '../config';
import { sendSMS, sendSMSWithEffect } from '../services/sendblue';
import { parseHeight, parseWeight, calculateTargets } from '../lib/calculations';
import { isMenuSelection } from '../services/message-router';
import {
  processOnboardingWithAI,
  buildCollectedData,
  getMissingFields,
  getNextField,
  cleanExtractedFields,
  ExtractedFields,
  CollectedData,
} from '../services/onboarding-ai';

// Step numbers for progress indicator (no longer displayed but kept for reference)
const STEP_NUMBERS: Partial<Record<OnboardingStep, { current: number; total: number }>> = {
  awaiting_goal: { current: 1, total: 9 },
  awaiting_weight: { current: 2, total: 9 },
  awaiting_timezone: { current: 3, total: 9 },
  awaiting_height: { current: 4, total: 9 },
  awaiting_age: { current: 5, total: 9 },
  awaiting_sex: { current: 6, total: 9 },
  awaiting_target_confirm: { current: 7, total: 9 },
  awaiting_restrictions: { current: 8, total: 9 },
  awaiting_accountability: { current: 9, total: 9 },
};

/**
 * Get step indicator for a message
 */
function getStepIndicator(step: OnboardingStep): string {
  const stepInfo = STEP_NUMBERS[step];
  if (!stepInfo) return '';
  return `(Step ${stepInfo.current}/${stepInfo.total}) `;
}

/**
 * Send an onboarding message (no step indicator)
 */
async function sendOnboardingMessage(
  phone: string,
  _step: OnboardingStep,
  message: string
): Promise<void> {
  await sendSMS(phone, message);
}

// Static messages
const MESSAGES = {
  welcome: `Hey this is Alex from FitText. Excited to get working with you.`,

  welcomeFollowup: `You can send me a photo of what you eat or just a description and I'll log it here to meet your goals. Can I ask a few questions first?`,

  firstQuestion: `What's your main goal?

1️⃣ Fat loss
2️⃣ Build muscle
3️⃣ Body recomposition
4️⃣ General health

(Or just tell me in your own words!)`,

  complete: `You're all set! 🎉

Here's how to use me:
• Text what you eat → I'll log it
• Send a food photo → I'll estimate macros
• Text your workouts → I'll track them
• Text /progress → See your stats
• Text /settings → Adjust preferences
• Ask me anything → I'll help

What did you have for your last meal? Let's log it now.`,

  help: `Need help during setup?

Commands:
• 'back' — Go to previous question
• 'restart' — Start setup over
• '/help' — Show this message

Just answer the question to continue, or use a command above.`,
};

// Goal display names
const GOAL_DISPLAY: Record<PrimaryGoal, string> = {
  fat_loss: 'fat loss',
  muscle_gain: 'building muscle',
  recomp: 'body recomposition',
  general_health: 'general health',
};

// Map step to next step based on what's collected
const FIELD_TO_STEP: Record<string, OnboardingStep> = {
  primaryGoal: 'awaiting_goal',
  currentWeight: 'awaiting_weight',
  timezone: 'awaiting_timezone',
  heightInches: 'awaiting_height',
  age: 'awaiting_age',
  sex: 'awaiting_sex',
  targetsConfirmed: 'awaiting_target_confirm',
  dietaryRestrictions: 'awaiting_restrictions',
  accountabilityLevel: 'awaiting_accountability',
};

/**
 * Get or create onboarding state for a user
 */
async function getOrCreateOnboardingState(userId: string) {
  let state = await prisma.onboardingState.findUnique({
    where: { userId },
  });

  if (!state) {
    state = await prisma.onboardingState.create({
      data: {
        userId,
        currentStep: 'welcome',
      },
    });
  }

  return state;
}

/**
 * Update onboarding step
 */
async function updateStep(userId: string, step: OnboardingStep) {
  await prisma.onboardingState.update({
    where: { userId },
    data: {
      currentStep: step,
      lastInteraction: new Date(),
    },
  });
}

/**
 * Start onboarding for a new user
 */
export async function startOnboarding(phone: string): Promise<void> {
  console.log(`Starting onboarding for new user: ${phone}`);

  // Create user
  const user = await prisma.user.create({
    data: { phone },
  });

  // Create onboarding state
  await prisma.onboardingState.create({
    data: {
      userId: user.id,
      currentStep: 'welcome',
    },
  });

  // Send welcome sequence: 3 messages
  // 1. Welcome message
  await sendSMS(phone, MESSAGES.welcome);

  // 2. Follow-up explaining the service
  await sendSMS(phone, MESSAGES.welcomeFollowup);

  // 3. Contact card (VCF)
  const vcfUrl = `${config.server.webhookBaseUrl}/static/coach.vcf`;
  console.log(`Sending VCF to ${phone}: ${vcfUrl}`);
  await sendSMS(phone, '', vcfUrl);
}

/**
 * Determine the current step based on collected data
 */
function determineStep(data: CollectedData): OnboardingStep {
  const nextField = getNextField(data);

  if (!nextField) {
    return 'complete';
  }

  return FIELD_TO_STEP[nextField] || 'awaiting_goal';
}

/**
 * Format target confirmation message
 */
function formatTargetConfirmation(calories: number, protein: number, goal: string): string {
  return `Based on your info, here are your daily targets:

🎯 Calories: ${calories.toLocaleString()} cal
🎯 Protein: ${protein}g

These are set for ${goal}. You can adjust anytime by texting /settings.

Sound good?`;
}

/**
 * Update user with extracted fields
 */
async function updateUserWithFields(
  userId: string,
  fields: ExtractedFields
): Promise<User> {
  const updateData: Record<string, unknown> = {};

  if (fields.primaryGoal) {
    updateData.primaryGoal = fields.primaryGoal;
    updateData.goalSetAt = new Date();
  }
  if (fields.currentWeight !== undefined) {
    updateData.currentWeight = fields.currentWeight;
  }
  if (fields.heightInches !== undefined) {
    updateData.heightInches = fields.heightInches;
  }
  if (fields.age !== undefined) {
    updateData.age = fields.age;
  }
  if (fields.sex) {
    updateData.sex = fields.sex;
  }
  if (fields.activityLevel) {
    updateData.activityLevel = fields.activityLevel;
  }
  if (fields.timezone) {
    updateData.timezone = fields.timezone;
  }
  if (fields.dietaryRestrictions !== undefined) {
    updateData.dietaryRestrictions = fields.dietaryRestrictions;
  }
  if (fields.accountabilityLevel) {
    updateData.accountabilityLevel = fields.accountabilityLevel;
  }

  if (Object.keys(updateData).length > 0) {
    return await prisma.user.update({
      where: { id: userId },
      data: updateData,
    });
  }

  return await prisma.user.findUniqueOrThrow({ where: { id: userId } });
}

/**
 * Try fallback parsing for common fields when LLM fails
 */
function tryFallbackParsing(
  message: string,
  step: OnboardingStep
): ExtractedFields | null {
  const input = message.trim();
  const lowerInput = input.toLowerCase();

  switch (step) {
    case 'awaiting_goal': {
      const selection = isMenuSelection(input);
      const goalMap: Record<number, PrimaryGoal> = {
        1: 'fat_loss',
        2: 'muscle_gain',
        3: 'recomp',
        4: 'general_health',
      };
      if (selection && goalMap[selection]) {
        return { primaryGoal: goalMap[selection] };
      }
      // Try text matching
      if (lowerInput.includes('fat') || lowerInput.includes('lose') || lowerInput.includes('weight loss')) {
        return { primaryGoal: 'fat_loss' };
      }
      if (lowerInput.includes('muscle') || lowerInput.includes('bulk') || lowerInput.includes('gain')) {
        return { primaryGoal: 'muscle_gain' };
      }
      if (lowerInput.includes('recomp')) {
        return { primaryGoal: 'recomp' };
      }
      if (lowerInput.includes('health') || lowerInput.includes('maintain')) {
        return { primaryGoal: 'general_health' };
      }
      break;
    }

    case 'awaiting_weight': {
      const weight = parseWeight(input);
      if (weight) {
        return { currentWeight: weight };
      }
      break;
    }

    case 'awaiting_height': {
      const height = parseHeight(input);
      if (height) {
        return { heightInches: height };
      }
      break;
    }

    case 'awaiting_age': {
      const age = parseInt(input, 10);
      if (age && age >= 13 && age <= 120) {
        return { age };
      }
      break;
    }

    case 'awaiting_sex': {
      if (lowerInput.includes('male') && !lowerInput.includes('female')) {
        return { sex: 'male' };
      }
      if (lowerInput.includes('female') || lowerInput === 'f') {
        return { sex: 'female' };
      }
      if (lowerInput === 'm') {
        return { sex: 'male' };
      }
      break;
    }

    case 'awaiting_target_confirm': {
      const affirmatives = ['yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'sounds good', 'good', 'y'];
      if (affirmatives.some(a => lowerInput.includes(a))) {
        return { targetsConfirmed: true };
      }
      break;
    }

    case 'awaiting_restrictions': {
      if (lowerInput === 'none' || lowerInput === 'no' || lowerInput === 'n/a' || lowerInput === 'na') {
        return { dietaryRestrictions: [] };
      }
      // Parse comma-separated restrictions
      const restrictions = input
        .split(/[,;]/)
        .map(r => r.trim().toLowerCase())
        .filter(r => r.length > 0);
      if (restrictions.length > 0) {
        return { dietaryRestrictions: restrictions };
      }
      break;
    }

    case 'awaiting_accountability': {
      const selection = isMenuSelection(input);
      const levelMap: Record<number, 'light' | 'medium' | 'high'> = {
        1: 'light',
        2: 'medium',
        3: 'high',
      };
      if (selection && levelMap[selection]) {
        return { accountabilityLevel: levelMap[selection] };
      }
      break;
    }
  }

  return null;
}

/**
 * Handle escape commands
 */
async function handleEscapeCommand(
  user: User,
  command: string | null | undefined,
  currentStep: OnboardingStep
): Promise<boolean> {
  if (!command) return false;

  switch (command) {
    case 'help':
      await sendSMS(user.phone, MESSAGES.help);
      return true;

    case 'restart':
      // Reset user data (keeping accountabilityLevel at default since it's required)
      await prisma.user.update({
        where: { id: user.id },
        data: {
          primaryGoal: null,
          currentWeight: null,
          heightInches: null,
          age: null,
          sex: null,
          activityLevel: null,
          dietaryRestrictions: [],
          // accountabilityLevel has a default, don't reset it
          calorieTarget: null,
          proteinTarget: null,
        },
      });
      await updateStep(user.id, 'awaiting_goal');
      await sendOnboardingMessage(user.phone, 'awaiting_goal', "Let's start fresh!\n\n" + MESSAGES.firstQuestion);
      return true;

    case 'back':
      // Go to previous step by resetting the current field
      // This is a simplified approach - just tell them what info we have
      const collected = buildCollectedData(user);
      const summary = Object.entries(collected)
        .filter(([, v]) => v !== null && v !== undefined)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n');

      if (summary) {
        await sendSMS(
          user.phone,
          `Here's what I have so far:\n${summary}\n\nWhat would you like to change? Or just continue answering to proceed.`
        );
      } else {
        await sendSMS(user.phone, "You're at the beginning! Just answer to continue.");
      }
      return true;
  }

  return false;
}

/**
 * Process onboarding message - main LLM-driven flow
 */
export async function processOnboardingMessage(
  user: User,
  message: string
): Promise<void> {
  const state = await getOrCreateOnboardingState(user.id);
  const input = message.trim();

  // Handle welcome response - any message moves to first question
  if (state.currentStep === 'welcome') {
    await updateStep(user.id, 'awaiting_goal');
    await sendOnboardingMessage(user.phone, 'awaiting_goal', MESSAGES.firstQuestion);
    return;
  }

  // If already complete, shouldn't be here
  if (state.currentStep === 'complete') {
    return;
  }

  // Build current context
  const collectedData = buildCollectedData(user);

  // Try LLM processing
  let extractedFields: ExtractedFields = {};
  let response: string;
  let usedFallback = false;

  try {
    const aiResult = await processOnboardingWithAI(
      user,
      input,
      state.currentStep,
      collectedData
    );

    // Handle escape commands
    if (aiResult.intent === 'escape_command') {
      const handled = await handleEscapeCommand(user, aiResult.escapeCommand, state.currentStep);
      if (handled) return;
    }

    extractedFields = cleanExtractedFields(aiResult.extractedFields);
    response = aiResult.response;
  } catch (error) {
    console.error('Onboarding AI processing failed:', error);

    // Fall back to regex parsing
    const fallbackFields = tryFallbackParsing(input, state.currentStep);
    if (fallbackFields) {
      extractedFields = fallbackFields;
      usedFallback = true;
    }

    // Generate a simple response
    response = "Got it!";
  }

  // If no fields extracted and we haven't used fallback, try fallback now
  if (Object.keys(extractedFields).length === 0 && !usedFallback) {
    const fallbackFields = tryFallbackParsing(input, state.currentStep);
    if (fallbackFields) {
      extractedFields = fallbackFields;
    }
  }

  // Update user with extracted fields
  let updatedUser = user;
  if (Object.keys(extractedFields).length > 0) {
    updatedUser = await updateUserWithFields(user.id, extractedFields);
  }

  // Rebuild collected data after update
  const newCollectedData = buildCollectedData(updatedUser);
  const missingFields = getMissingFields(newCollectedData);

  // Check if we need to calculate and show targets
  const needsTargetCalc =
    updatedUser.currentWeight &&
    updatedUser.heightInches &&
    updatedUser.age &&
    updatedUser.sex &&
    updatedUser.primaryGoal &&
    !newCollectedData.targetsConfirmed &&
    !newCollectedData.calorieTarget;

  if (needsTargetCalc) {
    // Calculate targets (using 'light' as default activity level)
    const targets = calculateTargets(
      {
        currentWeight: updatedUser.currentWeight!,
        heightInches: updatedUser.heightInches!,
        age: updatedUser.age!,
        sex: updatedUser.sex!,
        activityLevel: updatedUser.activityLevel || 'light',
      },
      updatedUser.primaryGoal!
    );

    // Save targets
    await prisma.user.update({
      where: { id: user.id },
      data: {
        tdee: targets.tdee,
        calorieTarget: targets.calorieTarget,
        proteinTarget: targets.proteinTarget,
        weeklyWorkoutTarget: targets.weeklyWorkoutTarget,
      },
    });

    // Show target confirmation
    await updateStep(user.id, 'awaiting_target_confirm');
    const goalDisplay = updatedUser.primaryGoal ? GOAL_DISPLAY[updatedUser.primaryGoal] : 'your goal';
    const confirmMsg = formatTargetConfirmation(targets.calorieTarget, targets.proteinTarget, goalDisplay);
    await sendOnboardingMessage(user.phone, 'awaiting_target_confirm', confirmMsg);
    return;
  }

  // Determine next step
  const nextStep = determineStep(newCollectedData);
  await updateStep(user.id, nextStep);

  // Check for completion
  if (nextStep === 'complete') {
    // Mark complete
    await prisma.user.update({
      where: { id: user.id },
      data: { onboardingComplete: true },
    });

    // Create default reminders
    const level = (updatedUser.accountabilityLevel as 'light' | 'medium' | 'high') || 'medium';
    await createDefaultReminders(user.id, level);

    // Send completion with confetti!
    await sendSMSWithEffect(user.phone, MESSAGES.complete, 'confetti');
    return;
  }

  // Send the AI response with step indicator
  // If we used fallback or response is too short, enhance it
  if (usedFallback || response.length < 20) {
    const nextField = getNextField(newCollectedData);
    response = getPromptForField(nextField);
  }

  await sendOnboardingMessage(user.phone, nextStep, response);
}

/**
 * Get a prompt for a specific field
 */
function getPromptForField(field: string | null): string {
  switch (field) {
    case 'primaryGoal':
      return MESSAGES.firstQuestion;
    case 'currentWeight':
      return "What's your current weight?";
    case 'timezone':
      return `What timezone are you in?

1️⃣ Eastern
2️⃣ Central
3️⃣ Mountain
4️⃣ Pacific

(Or type your timezone like "Europe/London")`;
    case 'heightInches':
      return "And your height? (Like 5'10 or 70 inches)";
    case 'age':
      return "How old are you?";
    case 'sex':
      return "Male or female? (Just for calorie calculations)";
    case 'dietaryRestrictions':
      return "Any dietary restrictions? (vegetarian, vegan, gluten-free, etc.) Reply 'none' if not.";
    case 'accountabilityLevel':
      return `Last one — how much accountability do you want?

1️⃣ Light — Daily summary only
2️⃣ Medium — Reminders if you miss meals (recommended)
3️⃣ High — All reminders + morning/evening check-ins`;
    default:
      return "Let's continue!";
  }
}

/**
 * Create default reminders based on accountability level
 */
async function createDefaultReminders(
  userId: string,
  level: 'light' | 'medium' | 'high'
): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return;

  const reminders: {
    reminderType: 'breakfast' | 'lunch' | 'dinner' | 'daily_summary' | 'weigh_in' | 'morning_checkin' | 'evening_checkin';
    scheduledTime: string;
    enabled: boolean;
  }[] = [];

  // Daily summary for all levels
  reminders.push({
    reminderType: 'daily_summary',
    scheduledTime: user.dailySummaryTime,
    enabled: true,
  });

  // Weigh-in reminder for medium and high
  if (level === 'medium' || level === 'high') {
    reminders.push({
      reminderType: 'weigh_in',
      scheduledTime: '08:00',
      enabled: true,
    });
  }

  // Meal reminders for medium and high
  if (level === 'medium' || level === 'high') {
    reminders.push(
      { reminderType: 'breakfast', scheduledTime: user.reminderBreakfastTime, enabled: true },
      { reminderType: 'lunch', scheduledTime: user.reminderLunchTime, enabled: true },
      { reminderType: 'dinner', scheduledTime: user.reminderDinnerTime, enabled: true }
    );
  }

  // Morning/evening check-ins for high only
  if (level === 'high') {
    reminders.push(
      { reminderType: 'morning_checkin', scheduledTime: '07:00', enabled: true },
      { reminderType: 'evening_checkin', scheduledTime: '21:30', enabled: true }
    );
  }

  // Create all reminders
  for (const reminder of reminders) {
    await prisma.reminder.upsert({
      where: {
        userId_reminderType: {
          userId,
          reminderType: reminder.reminderType,
        },
      },
      create: {
        userId,
        ...reminder,
      },
      update: reminder,
    });
  }
}

/**
 * Check if user needs onboarding
 */
export async function needsOnboarding(user: User): Promise<boolean> {
  if (user.onboardingComplete) {
    return false;
  }

  const state = await prisma.onboardingState.findUnique({
    where: { userId: user.id },
  });

  return !state || state.currentStep !== 'complete';
}

/**
 * Check for abandoned onboarding (for scheduler)
 */
export async function checkAbandonedOnboarding(): Promise<void> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24 hours ago

  const abandonedStates = await prisma.onboardingState.findMany({
    where: {
      currentStep: { not: 'complete' },
      lastInteraction: { lt: cutoff },
    },
    include: { user: true },
  });

  for (const state of abandonedStates) {
    // Only send reminder once (check if we've sent recently)
    const recentReminder = await prisma.sentReminder.findFirst({
      where: {
        userId: state.userId,
        reminderType: 'morning_checkin', // Reuse this type for onboarding reminder
        sentAt: { gt: cutoff },
      },
    });

    if (!recentReminder) {
      await sendSMS(
        state.user.phone,
        "Hey! We didn't finish setting you up. Want to pick up where we left off? Just reply to continue, or say 'restart' to begin again."
      );
    }
  }
}
