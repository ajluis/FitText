import { OnboardingStep, PrimaryGoal, ActivityLevel, Sex, User } from '@prisma/client';
import prisma from '../lib/db';
import { sendSMS } from '../services/sendblue';
import { parseHeight, parseWeight, calculateTargets, formatTime } from '../lib/calculations';
import { isMenuSelection } from '../services/message-router';

// Onboarding messages
const MESSAGES = {
  welcome: `Hey! 👋 I'm FitText — your fitness coach that lives in your texts.

I'll help you track food, log workouts, and stay accountable. Everything happens right here in SMS — no app needed.

Ready to set up? It takes about 2 minutes.`,

  askGoal: `First, what's your main goal?

1️⃣ Fat loss
2️⃣ Build muscle
3️⃣ Body recomposition
4️⃣ General health

Just reply with the number.`,

  askWeight: (goal: string) => `Got it — ${goal}. Let's get your baseline.

What's your current weight? (Just the number, like 180)`,

  askHeight: `And your height? (Like 5'10 or 70 inches)`,

  askAge: `Age?`,

  askSex: `Last one for targets — are you male or female? (This affects calorie calculations)`,

  askActivity: `How active are you outside of intentional workouts?

1️⃣ Sedentary (desk job, minimal movement)
2️⃣ Lightly active (some walking, on feet occasionally)
3️⃣ Moderately active (on feet most of the day)
4️⃣ Very active (physical job, always moving)

Reply with the number.`,

  confirmTargets: (calories: number, protein: number, goal: string) => `Based on your info, here are your daily targets:

🎯 Calories: ${calories.toLocaleString()} cal
🎯 Protein: ${protein}g

These are set for ${goal}. You can adjust anytime by texting /settings.

Sound good?`,

  askRestrictions: `Any dietary restrictions I should know about?

Examples: vegetarian, vegan, gluten-free, dairy-free, low-FODMAP, nut allergy

Reply with any that apply, or 'none'.`,

  askAccountability: `Last thing — how much accountability do you want?

1️⃣ Light — Daily summary only, no check-ins
2️⃣ Medium — Reminders if I don't hear from you by meal times
3️⃣ High — All reminders + morning/evening check-ins

I recommend Medium to start. You can always change this.`,

  complete: `You're all set! 🎉

Here's how to use me:
• Text what you eat → I'll log it
• Send a food photo → I'll estimate macros
• Text your workouts → I'll track them
• Text /progress → See your stats
• Text /settings → Adjust preferences
• Ask me anything → I'll help

What did you have for your last meal? Let's log it now.`,

  // Error messages
  invalidGoal: `I didn't catch that. Please reply with a number 1-4:

1️⃣ Fat loss
2️⃣ Build muscle
3️⃣ Body recomp
4️⃣ General health`,

  invalidWeight: `I couldn't parse that weight. Just send a number, like "185" or "185 lbs".`,

  invalidHeight: `I couldn't parse that height. Try "5'10" or "70" (in inches).`,

  invalidAge: `Please enter your age as a number (like 32).`,

  invalidSex: `Please reply with "male" or "female" (this is just for calorie calculation accuracy).`,

  invalidActivity: `Please reply with a number 1-4:

1️⃣ Sedentary
2️⃣ Lightly active
3️⃣ Moderately active
4️⃣ Very active`,

  invalidAccountability: `Please reply with a number 1-3:

1️⃣ Light
2️⃣ Medium
3️⃣ High`,

  resumePrompt: `Hey! We didn't finish setting you up. Want to pick up where we left off? Just reply 'yes' to continue or 'start over' to begin again.`,
};

// Goal mapping
const GOAL_MAP: Record<number, PrimaryGoal> = {
  1: 'fat_loss',
  2: 'muscle_gain',
  3: 'recomp',
  4: 'general_health',
};

const GOAL_DISPLAY: Record<PrimaryGoal, string> = {
  fat_loss: 'fat loss',
  muscle_gain: 'building muscle',
  recomp: 'body recomposition',
  general_health: 'general health',
};

// Activity mapping
const ACTIVITY_MAP: Record<number, ActivityLevel> = {
  1: 'sedentary',
  2: 'light',
  3: 'moderate',
  4: 'active',
};

// Accountability mapping
const ACCOUNTABILITY_MAP: Record<number, 'light' | 'medium' | 'high'> = {
  1: 'light',
  2: 'medium',
  3: 'high',
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

  // Send welcome message
  await sendSMS(phone, MESSAGES.welcome);
}

/**
 * Process onboarding message
 */
export async function processOnboardingMessage(
  user: User,
  message: string
): Promise<void> {
  const state = await getOrCreateOnboardingState(user.id);
  const input = message.trim();
  const lowerInput = input.toLowerCase();

  switch (state.currentStep) {
    case 'welcome': {
      // Any response moves to goal question
      await updateStep(user.id, 'awaiting_goal');
      await sendSMS(user.phone, MESSAGES.askGoal);
      break;
    }

    case 'awaiting_goal': {
      const selection = isMenuSelection(input);
      if (selection && selection >= 1 && selection <= 4) {
        const goal = GOAL_MAP[selection];
        await prisma.user.update({
          where: { id: user.id },
          data: { primaryGoal: goal, goalSetAt: new Date() },
        });
        await updateStep(user.id, 'awaiting_weight');
        await sendSMS(user.phone, MESSAGES.askWeight(GOAL_DISPLAY[goal]));
      } else {
        await sendSMS(user.phone, MESSAGES.invalidGoal);
      }
      break;
    }

    case 'awaiting_weight': {
      const weight = parseWeight(input);
      if (weight) {
        await prisma.user.update({
          where: { id: user.id },
          data: { currentWeight: weight },
        });
        await updateStep(user.id, 'awaiting_height');
        await sendSMS(user.phone, MESSAGES.askHeight);
      } else {
        await sendSMS(user.phone, MESSAGES.invalidWeight);
      }
      break;
    }

    case 'awaiting_height': {
      const height = parseHeight(input);
      if (height) {
        await prisma.user.update({
          where: { id: user.id },
          data: { heightInches: height },
        });
        await updateStep(user.id, 'awaiting_age');
        await sendSMS(user.phone, MESSAGES.askAge);
      } else {
        await sendSMS(user.phone, MESSAGES.invalidHeight);
      }
      break;
    }

    case 'awaiting_age': {
      const age = parseInt(input, 10);
      if (age && age >= 13 && age <= 120) {
        await prisma.user.update({
          where: { id: user.id },
          data: { age },
        });
        await updateStep(user.id, 'awaiting_sex');
        await sendSMS(user.phone, MESSAGES.askSex);
      } else {
        await sendSMS(user.phone, MESSAGES.invalidAge);
      }
      break;
    }

    case 'awaiting_sex': {
      let sex: Sex | null = null;
      if (lowerInput.includes('male') && !lowerInput.includes('female')) {
        sex = 'male';
      } else if (lowerInput.includes('female') || lowerInput === 'f') {
        sex = 'female';
      } else if (lowerInput === 'm') {
        sex = 'male';
      }

      if (sex) {
        await prisma.user.update({
          where: { id: user.id },
          data: { sex },
        });
        await updateStep(user.id, 'awaiting_activity');
        await sendSMS(user.phone, MESSAGES.askActivity);
      } else {
        await sendSMS(user.phone, MESSAGES.invalidSex);
      }
      break;
    }

    case 'awaiting_activity': {
      const selection = isMenuSelection(input);
      if (selection && selection >= 1 && selection <= 4) {
        const activity = ACTIVITY_MAP[selection];
        await prisma.user.update({
          where: { id: user.id },
          data: { activityLevel: activity },
        });

        // Calculate targets
        const updatedUser = await prisma.user.findUnique({ where: { id: user.id } });
        if (updatedUser?.currentWeight && updatedUser.heightInches && updatedUser.age && updatedUser.sex && updatedUser.primaryGoal) {
          const targets = calculateTargets(
            {
              currentWeight: updatedUser.currentWeight,
              heightInches: updatedUser.heightInches,
              age: updatedUser.age,
              sex: updatedUser.sex,
              activityLevel: activity,
            },
            updatedUser.primaryGoal
          );

          await prisma.user.update({
            where: { id: user.id },
            data: {
              tdee: targets.tdee,
              calorieTarget: targets.calorieTarget,
              proteinTarget: targets.proteinTarget,
              weeklyWorkoutTarget: targets.weeklyWorkoutTarget,
            },
          });

          await updateStep(user.id, 'awaiting_target_confirm');
          await sendSMS(
            user.phone,
            MESSAGES.confirmTargets(
              targets.calorieTarget,
              targets.proteinTarget,
              GOAL_DISPLAY[updatedUser.primaryGoal]
            )
          );
        }
      } else {
        await sendSMS(user.phone, MESSAGES.invalidActivity);
      }
      break;
    }

    case 'awaiting_target_confirm': {
      // Accept any affirmative response
      const affirmatives = ['yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'sounds good', 'good', 'y'];
      if (affirmatives.some(a => lowerInput.includes(a))) {
        await updateStep(user.id, 'awaiting_restrictions');
        await sendSMS(user.phone, MESSAGES.askRestrictions);
      } else {
        // For now, just proceed anyway - they can adjust in settings
        await updateStep(user.id, 'awaiting_restrictions');
        await sendSMS(user.phone, MESSAGES.askRestrictions);
      }
      break;
    }

    case 'awaiting_restrictions': {
      let restrictions: string[] = [];
      if (lowerInput !== 'none' && lowerInput !== 'no' && lowerInput !== 'n/a' && lowerInput !== 'na') {
        // Parse comma-separated restrictions
        restrictions = input
          .split(/[,;]/)
          .map(r => r.trim().toLowerCase())
          .filter(r => r.length > 0);
      }

      await prisma.user.update({
        where: { id: user.id },
        data: { dietaryRestrictions: restrictions },
      });
      await updateStep(user.id, 'awaiting_accountability');
      await sendSMS(user.phone, MESSAGES.askAccountability);
      break;
    }

    case 'awaiting_accountability': {
      const selection = isMenuSelection(input);
      if (selection && selection >= 1 && selection <= 3) {
        const level = ACCOUNTABILITY_MAP[selection];
        await prisma.user.update({
          where: { id: user.id },
          data: {
            accountabilityLevel: level,
            onboardingComplete: true,
          },
        });

        // Create default reminders based on accountability level
        await createDefaultReminders(user.id, level);

        await updateStep(user.id, 'complete');
        await sendSMS(user.phone, MESSAGES.complete);
      } else {
        await sendSMS(user.phone, MESSAGES.invalidAccountability);
      }
      break;
    }

    case 'complete': {
      // Should not reach here, but handle gracefully
      // The message will be handled by the main router
      break;
    }
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
      await sendSMS(state.user.phone, MESSAGES.resumePrompt);
    }
  }
}
