import { User } from '@prisma/client';
import prisma from '../lib/db';
import { classifyMessage, Intent, ClassifiedMessage } from '../services/message-router';
import { sendSMS } from '../services/sendblue';

// Import handlers
import { startOnboarding, processOnboardingMessage, needsOnboarding } from './onboarding';
import { handleFoodLog, handleFoodPhoto, handleFoodConfirmation, getTodaySummary } from './food-log';
import { handleWorkoutLog } from './workout-log';
import { handleWeightLogMessage, handleWeightConfirmation, confirmWeightLog } from './weight-log';
import { handleCommand } from './commands';
import { enterSettings, isInSettings, processSettingsMessage } from './settings';
import { handleQuestion, handleGreeting, handleFreeform } from '../services/coaching-ai';
import { handleSettingsChange } from '../services/settings-ai';

/**
 * Main message handler - routes incoming messages to appropriate handlers
 */
export async function handleInboundMessage(
  phone: string,
  content: string,
  mediaUrl?: string
): Promise<void> {
  // Ignore tapback reactions (Loved "...", Liked "...", etc.)
  const tapbackPattern = /^(Loved|Liked|Disliked|Laughed at|Emphasized|Questioned)\s+".+"/i;
  if (tapbackPattern.test(content)) {
    console.log('Ignoring tapback reaction');
    return;
  }

  console.log(`Inbound message from ${phone}: ${content.substring(0, 50)}...`);

  // Get or create user
  let user = await prisma.user.findUnique({
    where: { phone },
  });

  // New user - start onboarding
  if (!user) {
    await startOnboarding(phone);
    return;
  }

  // Update last message timestamp
  await prisma.user.update({
    where: { id: user.id },
    data: { lastMessageAt: new Date() },
  });

  // Check if user needs to complete onboarding
  if (await needsOnboarding(user)) {
    await processOnboardingMessage(user, content);
    return;
  }

  // Check if user is in settings menu
  if (await isInSettings(user.id)) {
    await processSettingsMessage(user, content);
    return;
  }

  // Check for pending confirmations in conversation context
  const context = await prisma.conversationContext.findUnique({
    where: { userId: user.id },
  });

  // Classify the message
  const classified = await classifyMessage(content, !!mediaUrl, {
    lastIntent: context?.lastIntent || undefined,
    user,
  });

  console.log(`Classified as: ${classified.intent} (${classified.confidence})`);

  // Handle based on classification and context
  await routeMessage(user, classified, content, mediaUrl, context);
}

/**
 * Route message to appropriate handler based on classification
 */
async function routeMessage(
  user: User,
  classified: ClassifiedMessage,
  content: string,
  mediaUrl?: string,
  context?: { lastIntent: string | null; pendingFoodEntry: unknown; pendingWorkoutEntry: unknown } | null
): Promise<void> {
  // Handle confirmations with context
  if (classified.intent === 'confirmation' && context?.lastIntent) {
    await handleConfirmation(user, classified, context);
    return;
  }

  // Handle corrections with context
  if (classified.intent === 'correction' && context?.lastIntent) {
    await handleCorrection(user, classified, context);
    return;
  }

  // Route based on intent
  switch (classified.intent) {
    case 'food_photo':
      if (mediaUrl) {
        await handleFoodPhoto(user, mediaUrl);
      } else {
        await sendSMS(user.phone, "I didn't receive a photo. Try sending one again, or just describe what you ate.");
      }
      break;

    case 'food_log':
      await handleFoodLog(user, content);
      break;

    case 'workout_log':
      await handleWorkoutLog(user, content);
      break;

    case 'weight_log':
      await handleWeightLogMessage(user, content);
      break;

    case 'command':
      if (classified.command) {
        await handleCommand(user, classified.command);
      }
      break;

    case 'settings_change':
      const settingsResponse = await handleSettingsChange(user, content);
      await sendSMS(user.phone, settingsResponse);
      break;

    case 'question':
      await handleQuestion(user, content);
      break;

    case 'greeting':
      await handleGreeting(user);
      break;

    case 'freeform':
      await handleFreeform(user, content);
      break;

    case 'confirmation':
      // No context - treat as freeform
      await handleFreeform(user, content);
      break;

    case 'correction':
      // No context - ask what they want to correct
      await sendSMS(user.phone, "not following - what do you want to change?");
      break;

    default:
      await sendSMS(user.phone, "?");
  }
}

/**
 * Handle confirmation responses
 */
async function handleConfirmation(
  user: User,
  classified: ClassifiedMessage,
  context: { lastIntent: string | null; pendingFoodEntry: unknown; pendingWorkoutEntry: unknown }
): Promise<void> {
  const isConfirmed = classified.isAffirmative === true;

  switch (context.lastIntent) {
    case 'food_log':
    case 'food_photo':
    case 'quick_log':
      await handleFoodConfirmation(user, isConfirmed);
      break;

    case 'weight_log':
      await handleWeightConfirmation(user, isConfirmed);
      break;

    default:
      // No specific handler, treat as freeform
      await handleFreeform(user, classified.rawMessage);
  }
}

/**
 * Handle correction responses
 */
async function handleCorrection(
  user: User,
  classified: ClassifiedMessage,
  context: { lastIntent: string | null; pendingFoodEntry: unknown; pendingWorkoutEntry: unknown }
): Promise<void> {
  switch (context.lastIntent) {
    case 'food_log':
    case 'food_photo':
      // User wants to correct food entry - pass full message for smart parsing
      await handleFoodConfirmation(user, false, classified.rawMessage);
      break;

    case 'weight_log':
      // User wants to correct weight
      if (classified.correctionValue) {
        const weight = parseFloat(classified.correctionValue);
        if (!isNaN(weight) && weight >= 80 && weight <= 500) {
          await confirmWeightLog(user, weight);
        } else {
          await handleWeightConfirmation(user, false);
        }
      } else {
        await handleWeightConfirmation(user, false);
      }
      break;

    default:
      await sendSMS(user.phone, "What would you like to correct? You can re-enter the information.");
  }
}

/**
 * Export individual handlers for direct use
 */
export {
  startOnboarding,
  processOnboardingMessage,
  handleFoodLog,
  handleFoodPhoto,
  handleWorkoutLog,
  handleWeightLogMessage,
  handleCommand,
  enterSettings,
  processSettingsMessage,
  handleQuestion,
  handleGreeting,
  handleFreeform,
};
