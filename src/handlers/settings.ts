import { User, SettingsMenu, PrimaryGoal, ActivityLevel, WeekDay, AccountabilityLevel } from '@prisma/client';
import prisma from '../lib/db';
import { sendSMS } from '../services/sendblue';
import { isMenuSelection, isExitCommand } from '../services/message-router';
import { parseHeight, parseWeight, parseTime, formatTime, calculateTargets } from '../lib/calculations';

// Goal display names
const GOAL_DISPLAY: Record<PrimaryGoal, string> = {
  fat_loss: 'Fat loss',
  muscle_gain: 'Build muscle',
  recomp: 'Body recomposition',
  general_health: 'General health',
};

const GOAL_MAP: Record<number, PrimaryGoal> = {
  1: 'fat_loss',
  2: 'muscle_gain',
  3: 'recomp',
  4: 'general_health',
};

const ACTIVITY_DISPLAY: Record<ActivityLevel, string> = {
  sedentary: 'Sedentary',
  light: 'Lightly active',
  moderate: 'Moderately active',
  active: 'Active',
  very_active: 'Very active',
};

const ACTIVITY_MAP: Record<number, ActivityLevel> = {
  1: 'sedentary',
  2: 'light',
  3: 'moderate',
  4: 'active',
};

const DAY_DISPLAY: Record<WeekDay, string> = {
  SU: 'Sunday',
  MO: 'Monday',
  TU: 'Tuesday',
  WE: 'Wednesday',
  TH: 'Thursday',
  FR: 'Friday',
  SA: 'Saturday',
};

const DAY_MAP: Record<number, WeekDay> = {
  1: 'SU',
  2: 'MO',
  3: 'TU',
  4: 'WE',
  5: 'TH',
  6: 'FR',
  7: 'SA',
};

const ACCOUNTABILITY_MAP: Record<number, AccountabilityLevel> = {
  1: 'light',
  2: 'medium',
  3: 'high',
};

/**
 * Get or create settings state
 */
async function getOrCreateSettingsState(userId: string) {
  let state = await prisma.settingsState.findUnique({
    where: { userId },
  });

  if (!state) {
    state = await prisma.settingsState.create({
      data: {
        userId,
        inSettings: true,
        currentMenu: 'main',
      },
    });
  }

  return state;
}

/**
 * Update settings state
 */
async function updateSettingsState(
  userId: string,
  data: { currentMenu?: SettingsMenu; awaitingInputFor?: string | null; inSettings?: boolean }
) {
  await prisma.settingsState.update({
    where: { userId },
    data: {
      ...data,
      enteredAt: new Date(),
    },
  });
}

/**
 * Exit settings
 */
async function exitSettings(user: User): Promise<void> {
  await prisma.settingsState.update({
    where: { userId: user.id },
    data: {
      inSettings: false,
      currentMenu: 'main',
      awaitingInputFor: null,
    },
  });
  await sendSMS(user.phone, "Settings saved. Text /settings anytime to come back.");
}

/**
 * Enter settings - show main menu
 */
export async function enterSettings(user: User): Promise<void> {
  await prisma.settingsState.upsert({
    where: { userId: user.id },
    create: {
      userId: user.id,
      inSettings: true,
      currentMenu: 'main',
    },
    update: {
      inSettings: true,
      currentMenu: 'main',
      awaitingInputFor: null,
      enteredAt: new Date(),
    },
  });

  await sendSMS(user.phone, getMainMenu());
}

/**
 * Check if user is in settings
 */
export async function isInSettings(userId: string): Promise<boolean> {
  const state = await prisma.settingsState.findUnique({
    where: { userId },
  });

  if (!state?.inSettings) return false;

  // Auto-exit after 10 minutes of inactivity
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
  if (state.enteredAt < tenMinutesAgo) {
    await prisma.settingsState.update({
      where: { userId },
      data: { inSettings: false },
    });
    return false;
  }

  return true;
}

/**
 * Process settings message
 */
export async function processSettingsMessage(user: User, message: string): Promise<void> {
  const state = await getOrCreateSettingsState(user.id);
  const input = message.trim();
  const lower = input.toLowerCase();

  // Check for exit commands
  if (isExitCommand(input)) {
    await exitSettings(user);
    return;
  }

  // If awaiting specific input
  if (state.awaitingInputFor) {
    await handleAwaitingInput(user, state.awaitingInputFor, input);
    return;
  }

  const selection = isMenuSelection(input);

  switch (state.currentMenu) {
    case 'main':
      await handleMainMenu(user, selection);
      break;
    case 'goals':
      await handleGoalsMenu(user, selection, lower);
      break;
    case 'reminders':
      await handleRemindersMenu(user, selection, lower);
      break;
    case 'stats':
      await handleStatsMenu(user, selection);
      break;
    case 'restrictions':
      await handleRestrictionsInput(user, input);
      break;
    case 'profile':
      await handleProfileMenu(user, selection);
      break;
    default:
      await sendSMS(user.phone, getMainMenu());
  }
}

// Menu content generators
function getMainMenu(): string {
  return `⚙️ Settings

1️⃣ Goals & targets
2️⃣ Reminders & check-ins
3️⃣ Update my stats
4️⃣ Dietary restrictions
5️⃣ View my profile

Reply with a number, or 'done' to exit.`;
}

function getGoalsMenu(user: User): string {
  return `/settings → Goals & targets

Current goal: ${GOAL_DISPLAY[user.primaryGoal || 'general_health']}
Calorie target: ${user.calorieTarget?.toLocaleString() || 'Not set'} cal
Protein target: ${user.proteinTarget || 'Not set'}g

What would you like to change?
1️⃣ Change goal
2️⃣ Adjust calorie target
3️⃣ Adjust protein target
4️⃣ Set target weight
5️⃣ Back to settings`;
}

function getRemindersMenu(user: User): string {
  return `/settings → Reminders

Accountability level: ${user.accountabilityLevel.charAt(0).toUpperCase() + user.accountabilityLevel.slice(1)}
Breakfast reminder: ${formatTime(user.reminderBreakfastTime)}
Lunch reminder: ${formatTime(user.reminderLunchTime)}
Dinner reminder: ${formatTime(user.reminderDinnerTime)}
Daily summary: ${formatTime(user.dailySummaryTime)}
Weigh-in day: ${DAY_DISPLAY[user.weighInDay]}
Hydration reminders: ${user.hydrationReminders ? 'On' : 'Off'}

What would you like to change?
1️⃣ Accountability level
2️⃣ Meal reminder times
3️⃣ Daily summary time
4️⃣ Weigh-in day
5️⃣ Hydration reminders
6️⃣ Back to settings`;
}

function getStatsMenu(user: User): string {
  return `/settings → Update stats

Current weight: ${user.currentWeight || 'Not set'} lbs
Height: ${user.heightInches ? `${Math.floor(user.heightInches / 12)}'${user.heightInches % 12}"` : 'Not set'}
Age: ${user.age || 'Not set'}
Activity level: ${user.activityLevel ? ACTIVITY_DISPLAY[user.activityLevel] : 'Not set'}

What would you like to update?
1️⃣ Weight
2️⃣ Height
3️⃣ Age
4️⃣ Activity level
5️⃣ Back to settings`;
}

function getProfileView(user: User): string {
  const startWeight = user.currentWeight; // TODO: Track start weight separately
  const weightChange = 0; // TODO: Calculate from history

  return `/settings → Your profile

📊 Stats
Weight: ${user.currentWeight || 'Not set'} lbs
Height: ${user.heightInches ? `${Math.floor(user.heightInches / 12)}'${user.heightInches % 12}"` : 'Not set'}
Age: ${user.age || 'Not set'}
TDEE: ${user.tdee?.toLocaleString() || 'Not calculated'} cal

🎯 Targets
Goal: ${GOAL_DISPLAY[user.primaryGoal || 'general_health']}
Calories: ${user.calorieTarget?.toLocaleString() || 'Not set'} cal/day
Protein: ${user.proteinTarget || 'Not set'}g/day
${user.targetWeight ? `Target weight: ${user.targetWeight} lbs` : ''}

📅 Progress
Days logged: ${user.totalDaysLogged}
Current streak: ${user.loggingStreakDays} days
Member since: ${user.createdAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}

Reply 'back' to return to settings.`;
}

// Menu handlers
async function handleMainMenu(user: User, selection: number | null): Promise<void> {
  switch (selection) {
    case 1:
      await updateSettingsState(user.id, { currentMenu: 'goals' });
      await sendSMS(user.phone, getGoalsMenu(user));
      break;
    case 2:
      await updateSettingsState(user.id, { currentMenu: 'reminders' });
      await sendSMS(user.phone, getRemindersMenu(user));
      break;
    case 3:
      await updateSettingsState(user.id, { currentMenu: 'stats' });
      await sendSMS(user.phone, getStatsMenu(user));
      break;
    case 4:
      await updateSettingsState(user.id, { currentMenu: 'restrictions' });
      await sendSMS(user.phone, `Current dietary restrictions: ${user.dietaryRestrictions.length > 0 ? user.dietaryRestrictions.join(', ') : 'None'}

Enter your dietary restrictions (comma-separated), or 'none' to clear:

Examples: vegetarian, gluten-free, dairy-free, nut allergy`);
      break;
    case 5:
      await updateSettingsState(user.id, { currentMenu: 'profile' });
      await sendSMS(user.phone, getProfileView(user));
      break;
    default:
      await sendSMS(user.phone, "I didn't catch that. Reply with a number 1-5, or 'done' to exit.");
  }
}

async function handleGoalsMenu(user: User, selection: number | null, input: string): Promise<void> {
  switch (selection) {
    case 1:
      await updateSettingsState(user.id, { awaitingInputFor: 'goal' });
      await sendSMS(user.phone, `What's your new goal?
1️⃣ Fat loss
2️⃣ Build muscle
3️⃣ Body recomposition
4️⃣ General health`);
      break;
    case 2:
      await updateSettingsState(user.id, { awaitingInputFor: 'calorie_target' });
      await sendSMS(user.phone, `Your current calorie target is ${user.calorieTarget?.toLocaleString() || 'not set'}. What would you like to set it to?`);
      break;
    case 3:
      await updateSettingsState(user.id, { awaitingInputFor: 'protein_target' });
      await sendSMS(user.phone, `Your current protein target is ${user.proteinTarget || 'not set'}g. What would you like to set it to?`);
      break;
    case 4:
      await updateSettingsState(user.id, { awaitingInputFor: 'target_weight' });
      await sendSMS(user.phone, `${user.targetWeight ? `Your current target weight is ${user.targetWeight} lbs.` : 'No target weight set.'} What's your target weight? (or 'clear' to remove)`);
      break;
    case 5:
      await updateSettingsState(user.id, { currentMenu: 'main' });
      await sendSMS(user.phone, getMainMenu());
      break;
    default:
      if (input === 'back') {
        await updateSettingsState(user.id, { currentMenu: 'main' });
        await sendSMS(user.phone, getMainMenu());
      } else {
        await sendSMS(user.phone, "Reply with a number 1-5, or 'back'.");
      }
  }
}

async function handleRemindersMenu(user: User, selection: number | null, input: string): Promise<void> {
  switch (selection) {
    case 1:
      await updateSettingsState(user.id, { awaitingInputFor: 'accountability' });
      await sendSMS(user.phone, `How much accountability do you want?

1️⃣ Light — Daily summary only
2️⃣ Medium — Reminders if meals not logged
3️⃣ High — All reminders + morning/evening check-ins

Currently: ${user.accountabilityLevel.charAt(0).toUpperCase() + user.accountabilityLevel.slice(1)}`);
      break;
    case 2:
      await updateSettingsState(user.id, { awaitingInputFor: 'meal_times' });
      await sendSMS(user.phone, `Which meal time to change?
1️⃣ Breakfast (currently ${formatTime(user.reminderBreakfastTime)})
2️⃣ Lunch (currently ${formatTime(user.reminderLunchTime)})
3️⃣ Dinner (currently ${formatTime(user.reminderDinnerTime)})`);
      break;
    case 3:
      await updateSettingsState(user.id, { awaitingInputFor: 'summary_time' });
      await sendSMS(user.phone, `When should I send your daily summary?

Current: ${formatTime(user.dailySummaryTime)}
Reply with a new time (like '9pm' or '21:00')`);
      break;
    case 4:
      await updateSettingsState(user.id, { awaitingInputFor: 'weigh_in_day' });
      await sendSMS(user.phone, `Which day for weekly weigh-in?
1️⃣ Sunday
2️⃣ Monday
3️⃣ Tuesday
4️⃣ Wednesday
5️⃣ Thursday
6️⃣ Friday
7️⃣ Saturday

Currently: ${DAY_DISPLAY[user.weighInDay]}`);
      break;
    case 5:
      await prisma.user.update({
        where: { id: user.id },
        data: { hydrationReminders: !user.hydrationReminders },
      });
      await sendSMS(user.phone, `Hydration reminders ${!user.hydrationReminders ? 'enabled' : 'disabled'}.`);
      // Refresh user and show menu
      const updatedUser = await prisma.user.findUnique({ where: { id: user.id } });
      if (updatedUser) {
        await sendSMS(updatedUser.phone, getRemindersMenu(updatedUser));
      }
      break;
    case 6:
      await updateSettingsState(user.id, { currentMenu: 'main' });
      await sendSMS(user.phone, getMainMenu());
      break;
    default:
      if (input === 'back') {
        await updateSettingsState(user.id, { currentMenu: 'main' });
        await sendSMS(user.phone, getMainMenu());
      } else {
        await sendSMS(user.phone, "Reply with a number 1-6, or 'back'.");
      }
  }
}

async function handleStatsMenu(user: User, selection: number | null): Promise<void> {
  switch (selection) {
    case 1:
      await updateSettingsState(user.id, { awaitingInputFor: 'weight' });
      await sendSMS(user.phone, `Current weight: ${user.currentWeight || 'Not set'} lbs

Enter your new weight:`);
      break;
    case 2:
      await updateSettingsState(user.id, { awaitingInputFor: 'height' });
      await sendSMS(user.phone, `Enter your height (like 5'10 or 70 inches):`);
      break;
    case 3:
      await updateSettingsState(user.id, { awaitingInputFor: 'age' });
      await sendSMS(user.phone, `Enter your age:`);
      break;
    case 4:
      await updateSettingsState(user.id, { awaitingInputFor: 'activity' });
      await sendSMS(user.phone, `How active are you?
1️⃣ Sedentary
2️⃣ Lightly active
3️⃣ Moderately active
4️⃣ Active

Currently: ${user.activityLevel ? ACTIVITY_DISPLAY[user.activityLevel] : 'Not set'}`);
      break;
    case 5:
      await updateSettingsState(user.id, { currentMenu: 'main' });
      await sendSMS(user.phone, getMainMenu());
      break;
    default:
      await sendSMS(user.phone, "Reply with a number 1-5.");
  }
}

async function handleRestrictionsInput(user: User, input: string): Promise<void> {
  const lower = input.toLowerCase().trim();

  if (lower === 'back') {
    await updateSettingsState(user.id, { currentMenu: 'main' });
    await sendSMS(user.phone, getMainMenu());
    return;
  }

  let restrictions: string[] = [];
  if (lower !== 'none' && lower !== 'clear') {
    restrictions = input
      .split(/[,;]/)
      .map(r => r.trim().toLowerCase())
      .filter(r => r.length > 0);
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { dietaryRestrictions: restrictions },
  });

  await sendSMS(user.phone, `Dietary restrictions updated to: ${restrictions.length > 0 ? restrictions.join(', ') : 'None'}`);
  await updateSettingsState(user.id, { currentMenu: 'main' });
  await sendSMS(user.phone, getMainMenu());
}

async function handleProfileMenu(user: User, selection: number | null): Promise<void> {
  // Profile is view-only, any input goes back
  await updateSettingsState(user.id, { currentMenu: 'main' });
  await sendSMS(user.phone, getMainMenu());
}

// Handle awaiting input
async function handleAwaitingInput(user: User, field: string, input: string): Promise<void> {
  const lower = input.toLowerCase().trim();

  if (lower === 'back' || lower === 'cancel') {
    await updateSettingsState(user.id, { awaitingInputFor: null });
    const state = await prisma.settingsState.findUnique({ where: { userId: user.id } });
    if (state?.currentMenu === 'goals') {
      await sendSMS(user.phone, getGoalsMenu(user));
    } else if (state?.currentMenu === 'reminders') {
      await sendSMS(user.phone, getRemindersMenu(user));
    } else if (state?.currentMenu === 'stats') {
      await sendSMS(user.phone, getStatsMenu(user));
    } else {
      await sendSMS(user.phone, getMainMenu());
    }
    return;
  }

  switch (field) {
    case 'goal': {
      const selection = isMenuSelection(input);
      if (selection && selection >= 1 && selection <= 4) {
        const goal = GOAL_MAP[selection];
        // Recalculate targets
        if (user.currentWeight && user.heightInches && user.age && user.sex && user.activityLevel) {
          const targets = calculateTargets(
            {
              currentWeight: user.currentWeight,
              heightInches: user.heightInches,
              age: user.age,
              sex: user.sex,
              activityLevel: user.activityLevel,
            },
            goal
          );
          await prisma.user.update({
            where: { id: user.id },
            data: {
              primaryGoal: goal,
              goalSetAt: new Date(),
              tdee: targets.tdee,
              calorieTarget: targets.calorieTarget,
              proteinTarget: targets.proteinTarget,
              weeklyWorkoutTarget: targets.weeklyWorkoutTarget,
            },
          });
          await sendSMS(user.phone, `Goal updated to ${GOAL_DISPLAY[goal]}.

Your new targets:
🎯 Calories: ${targets.calorieTarget.toLocaleString()} cal
🎯 Protein: ${targets.proteinTarget}g`);
        } else {
          await prisma.user.update({
            where: { id: user.id },
            data: { primaryGoal: goal, goalSetAt: new Date() },
          });
          await sendSMS(user.phone, `Goal updated to ${GOAL_DISPLAY[goal]}.`);
        }
        await updateSettingsState(user.id, { awaitingInputFor: null, currentMenu: 'goals' });
        const updatedUser = await prisma.user.findUnique({ where: { id: user.id } });
        if (updatedUser) await sendSMS(updatedUser.phone, getGoalsMenu(updatedUser));
      } else {
        await sendSMS(user.phone, "Please reply with a number 1-4.");
      }
      break;
    }

    case 'calorie_target': {
      const calories = parseInt(input.replace(/[^\d]/g, ''), 10);
      if (calories && calories >= 1000 && calories <= 6000) {
        await prisma.user.update({
          where: { id: user.id },
          data: { calorieTarget: calories },
        });
        await sendSMS(user.phone, `Calorie target updated to ${calories.toLocaleString()} cal.`);
        await updateSettingsState(user.id, { awaitingInputFor: null, currentMenu: 'goals' });
        const updatedUser = await prisma.user.findUnique({ where: { id: user.id } });
        if (updatedUser) await sendSMS(updatedUser.phone, getGoalsMenu(updatedUser));
      } else {
        await sendSMS(user.phone, "Please enter a valid calorie target (1000-6000).");
      }
      break;
    }

    case 'protein_target': {
      const protein = parseInt(input.replace(/[^\d]/g, ''), 10);
      if (protein && protein >= 50 && protein <= 400) {
        await prisma.user.update({
          where: { id: user.id },
          data: { proteinTarget: protein },
        });
        await sendSMS(user.phone, `Protein target updated to ${protein}g.`);
        await updateSettingsState(user.id, { awaitingInputFor: null, currentMenu: 'goals' });
        const updatedUser = await prisma.user.findUnique({ where: { id: user.id } });
        if (updatedUser) await sendSMS(updatedUser.phone, getGoalsMenu(updatedUser));
      } else {
        await sendSMS(user.phone, "Please enter a valid protein target (50-400g).");
      }
      break;
    }

    case 'target_weight': {
      if (lower === 'clear' || lower === 'none') {
        await prisma.user.update({
          where: { id: user.id },
          data: { targetWeight: null },
        });
        await sendSMS(user.phone, "Target weight cleared.");
      } else {
        const weight = parseWeight(input);
        if (weight) {
          await prisma.user.update({
            where: { id: user.id },
            data: { targetWeight: weight },
          });
          await sendSMS(user.phone, `Target weight set to ${weight} lbs.`);
        } else {
          await sendSMS(user.phone, "Please enter a valid weight or 'clear'.");
          return;
        }
      }
      await updateSettingsState(user.id, { awaitingInputFor: null, currentMenu: 'goals' });
      const updatedUser = await prisma.user.findUnique({ where: { id: user.id } });
      if (updatedUser) await sendSMS(updatedUser.phone, getGoalsMenu(updatedUser));
      break;
    }

    case 'accountability': {
      const selection = isMenuSelection(input);
      if (selection && selection >= 1 && selection <= 3) {
        const level = ACCOUNTABILITY_MAP[selection];
        await prisma.user.update({
          where: { id: user.id },
          data: { accountabilityLevel: level },
        });
        await sendSMS(user.phone, `Accountability level set to ${level}.`);
        await updateSettingsState(user.id, { awaitingInputFor: null, currentMenu: 'reminders' });
        const updatedUser = await prisma.user.findUnique({ where: { id: user.id } });
        if (updatedUser) await sendSMS(updatedUser.phone, getRemindersMenu(updatedUser));
      } else {
        await sendSMS(user.phone, "Please reply with a number 1-3.");
      }
      break;
    }

    case 'meal_times': {
      const selection = isMenuSelection(input);
      if (selection && selection >= 1 && selection <= 3) {
        const mealField = ['reminderBreakfastTime', 'reminderLunchTime', 'reminderDinnerTime'][selection - 1];
        const mealName = ['Breakfast', 'Lunch', 'Dinner'][selection - 1];
        await updateSettingsState(user.id, { awaitingInputFor: `${mealField}` });
        await sendSMS(user.phone, `Enter new time for ${mealName} reminder (like '9am' or '9:30'):`);
      } else {
        await sendSMS(user.phone, "Please reply with 1, 2, or 3.");
      }
      break;
    }

    case 'reminderBreakfastTime':
    case 'reminderLunchTime':
    case 'reminderDinnerTime': {
      const time = parseTime(input);
      if (time) {
        await prisma.user.update({
          where: { id: user.id },
          data: { [field]: time },
        });
        await sendSMS(user.phone, `Reminder time updated to ${formatTime(time)}.`);
        await updateSettingsState(user.id, { awaitingInputFor: null, currentMenu: 'reminders' });
        const updatedUser = await prisma.user.findUnique({ where: { id: user.id } });
        if (updatedUser) await sendSMS(updatedUser.phone, getRemindersMenu(updatedUser));
      } else {
        await sendSMS(user.phone, "Please enter a valid time (like '9am' or '9:30').");
      }
      break;
    }

    case 'summary_time': {
      const time = parseTime(input);
      if (time) {
        await prisma.user.update({
          where: { id: user.id },
          data: { dailySummaryTime: time },
        });
        await sendSMS(user.phone, `Daily summary time updated to ${formatTime(time)}.`);
        await updateSettingsState(user.id, { awaitingInputFor: null, currentMenu: 'reminders' });
        const updatedUser = await prisma.user.findUnique({ where: { id: user.id } });
        if (updatedUser) await sendSMS(updatedUser.phone, getRemindersMenu(updatedUser));
      } else {
        await sendSMS(user.phone, "Please enter a valid time (like '9pm' or '21:00').");
      }
      break;
    }

    case 'weigh_in_day': {
      const selection = isMenuSelection(input);
      if (selection && selection >= 1 && selection <= 7) {
        const day = DAY_MAP[selection];
        await prisma.user.update({
          where: { id: user.id },
          data: { weighInDay: day },
        });
        await sendSMS(user.phone, `Weigh-in day set to ${DAY_DISPLAY[day]}.`);
        await updateSettingsState(user.id, { awaitingInputFor: null, currentMenu: 'reminders' });
        const updatedUser = await prisma.user.findUnique({ where: { id: user.id } });
        if (updatedUser) await sendSMS(updatedUser.phone, getRemindersMenu(updatedUser));
      } else {
        await sendSMS(user.phone, "Please reply with a number 1-7.");
      }
      break;
    }

    case 'weight': {
      const weight = parseWeight(input);
      if (weight) {
        await prisma.user.update({
          where: { id: user.id },
          data: { currentWeight: weight },
        });
        // Also log as weight entry
        const { handleWeightLog } = await import('./weight-log');
        const updatedUser = await prisma.user.findUnique({ where: { id: user.id } });
        if (updatedUser) {
          await handleWeightLog(updatedUser, weight);
        }
        await sendSMS(user.phone, `Weight updated to ${weight} lbs.`);
        await updateSettingsState(user.id, { awaitingInputFor: null, currentMenu: 'stats' });
        const finalUser = await prisma.user.findUnique({ where: { id: user.id } });
        if (finalUser) await sendSMS(finalUser.phone, getStatsMenu(finalUser));
      } else {
        await sendSMS(user.phone, "Please enter a valid weight (like '185' or '185 lbs').");
      }
      break;
    }

    case 'height': {
      const height = parseHeight(input);
      if (height) {
        await prisma.user.update({
          where: { id: user.id },
          data: { heightInches: height },
        });
        await recalculateTargets(user.id);
        await sendSMS(user.phone, `Height updated to ${Math.floor(height / 12)}'${height % 12}".`);
        await updateSettingsState(user.id, { awaitingInputFor: null, currentMenu: 'stats' });
        const updatedUser = await prisma.user.findUnique({ where: { id: user.id } });
        if (updatedUser) await sendSMS(updatedUser.phone, getStatsMenu(updatedUser));
      } else {
        await sendSMS(user.phone, "Please enter a valid height (like 5'10 or 70 inches).");
      }
      break;
    }

    case 'age': {
      const age = parseInt(input, 10);
      if (age && age >= 13 && age <= 120) {
        await prisma.user.update({
          where: { id: user.id },
          data: { age },
        });
        await recalculateTargets(user.id);
        await sendSMS(user.phone, `Age updated to ${age}.`);
        await updateSettingsState(user.id, { awaitingInputFor: null, currentMenu: 'stats' });
        const updatedUser = await prisma.user.findUnique({ where: { id: user.id } });
        if (updatedUser) await sendSMS(updatedUser.phone, getStatsMenu(updatedUser));
      } else {
        await sendSMS(user.phone, "Please enter a valid age.");
      }
      break;
    }

    case 'activity': {
      const selection = isMenuSelection(input);
      if (selection && selection >= 1 && selection <= 4) {
        const activity = ACTIVITY_MAP[selection];
        await prisma.user.update({
          where: { id: user.id },
          data: { activityLevel: activity },
        });
        await recalculateTargets(user.id);
        await sendSMS(user.phone, `Activity level updated to ${ACTIVITY_DISPLAY[activity]}.`);
        await updateSettingsState(user.id, { awaitingInputFor: null, currentMenu: 'stats' });
        const updatedUser = await prisma.user.findUnique({ where: { id: user.id } });
        if (updatedUser) await sendSMS(updatedUser.phone, getStatsMenu(updatedUser));
      } else {
        await sendSMS(user.phone, "Please reply with a number 1-4.");
      }
      break;
    }

    default:
      await updateSettingsState(user.id, { awaitingInputFor: null });
      await sendSMS(user.phone, getMainMenu());
  }
}

/**
 * Recalculate targets when stats change
 */
async function recalculateTargets(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.currentWeight || !user.heightInches || !user.age || !user.sex || !user.activityLevel || !user.primaryGoal) {
    return;
  }

  const targets = calculateTargets(
    {
      currentWeight: user.currentWeight,
      heightInches: user.heightInches,
      age: user.age,
      sex: user.sex,
      activityLevel: user.activityLevel,
    },
    user.primaryGoal
  );

  await prisma.user.update({
    where: { id: userId },
    data: {
      tdee: targets.tdee,
      calorieTarget: targets.calorieTarget,
      proteinTarget: targets.proteinTarget,
      weeklyWorkoutTarget: targets.weeklyWorkoutTarget,
    },
  });
}
