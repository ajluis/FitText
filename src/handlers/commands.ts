import { User } from '@prisma/client';
import prisma from '../lib/db';
import { sendSMS } from '../services/sendblue';
import { enterSettings, enterSettingsAt } from './settings';
import { getTodaySummary } from './food-log';
import { getWeeklyWorkoutSummary } from './workout-log';
import { getWeightProgress } from './weight-log';
import { getProgressSummary } from './progress';
import { getCurrentTimeDecimal, getTodayDate } from '../lib/calculations';
import { handleBuildCommand, handleBuildExit, isInBuildMode } from './build';

/**
 * Handle slash commands
 */
export async function handleCommand(
  user: User,
  command: string
): Promise<void> {
  const cmd = command.toLowerCase().trim();

  // Extract base command and arguments
  const parts = cmd.split(/\s+/);
  const baseCmd = parts[0];
  const args = parts.slice(1).join(' ');

  switch (baseCmd) {
    case '/settings':
      // Support /settings goals, /settings reminders, etc.
      if (args) {
        await enterSettingsAt(user, args);
      } else {
        await enterSettings(user);
      }
      break;

    case '/progress':
      const progress = await getProgressSummary(user);
      await sendSMS(user.phone, progress);
      break;

    case '/today':
      const today = await getTodaySummary(user);
      await sendSMS(user.phone, today);
      break;

    case '/week':
      const week = await getWeeklySummary(user);
      await sendSMS(user.phone, week);
      break;

    case '/help':
      await sendSMS(user.phone, getHelpMessage());
      break;

    case '/pause':
      await handlePause(user, args || undefined);
      break;

    case '/resume':
      await handleResume(user);
      break;

    // New shortcut commands
    case '/goals':
      await enterSettingsAt(user, 'goals');
      break;

    case '/weight':
      const weightProgress = await getWeightProgress(user);
      await sendSMS(user.phone, weightProgress);
      break;

    case '/macros':
      const macros = await getMacrosSummary(user);
      await sendSMS(user.phone, macros);
      break;

    case '/status':
      const status = await getQuickStatus(user);
      await sendSMS(user.phone, status);
      break;

    case '/yesterday':
      const yesterday = await getYesterdaySummary(user);
      await sendSMS(user.phone, yesterday);
      break;

    case '/build':
      await handleBuildCommand(user);
      break;

    case '/exit':
    case '/done':
      // Check if in build mode
      if (await isInBuildMode(user.id)) {
        await handleBuildExit(user);
      } else {
        await sendSMS(user.phone, 'Nothing to exit from.');
      }
      break;

    default:
      await sendSMS(
        user.phone,
        `I don't recognize that command. Try /help to see available commands.`
      );
  }
}

/**
 * Get help message
 */
function getHelpMessage(): string {
  return `📱 FitText Commands

Quick access:
/status — Quick snapshot (streak, today, week)
/macros — Today's calories & protein
/yesterday — What you ate yesterday
/weight — Weight progress
/goals — Jump to goals settings

Full commands:
/today — Today's detailed log
/week — Weekly summary
/progress — Overall progress
/settings — All settings
/pause [time] — Pause reminders (e.g., /pause 4h)
/resume — Resume reminders

Just text naturally to log:
• "Had eggs and toast"
• "Chipotle bowl"
• "Did chest and back"
• "185.5" (weight)
• Send a food photo`;
}

/**
 * Get weekly summary
 */
async function getWeeklySummary(user: User): Promise<string> {
  const workout = await getWeeklyWorkoutSummary(user);
  const nutrition = await getWeeklyNutritionSummary(user);

  return `Weekly Summary 📊\n\n${nutrition}\n\n${workout}`;
}

/**
 * Get weekly nutrition summary
 */
async function getWeeklyNutritionSummary(user: User): Promise<string> {
  const today = new Date();
  const dayOfWeek = today.getDay();
  const startOfWeek = new Date(today);
  startOfWeek.setDate(today.getDate() - dayOfWeek);
  startOfWeek.setHours(0, 0, 0, 0);

  const dailyLogs = await prisma.dailyLog.findMany({
    where: {
      userId: user.id,
      date: {
        gte: startOfWeek,
      },
    },
  });

  if (dailyLogs.length === 0) {
    return "Nutrition: No days logged this week";
  }

  const totalCalories = dailyLogs.reduce((sum, log) => sum + log.caloriesTotal, 0);
  const totalProtein = dailyLogs.reduce((sum, log) => sum + log.proteinTotal, 0);
  const avgCalories = Math.round(totalCalories / dailyLogs.length);
  const avgProtein = Math.round(totalProtein / dailyLogs.length);

  const calorieTarget = user.calorieTarget || 2000;
  const proteinTarget = user.proteinTarget || 150;

  // Count days hitting targets
  const daysHitCalories = dailyLogs.filter(
    log => Math.abs(log.caloriesTotal - calorieTarget) / calorieTarget <= 0.1
  ).length;
  const daysHitProtein = dailyLogs.filter(
    log => log.proteinTotal >= proteinTarget * 0.9
  ).length;

  let response = `Nutrition (${dailyLogs.length} days logged):\n`;
  response += `• Avg calories: ${avgCalories.toLocaleString()}/day (target: ${calorieTarget.toLocaleString()})\n`;
  response += `• Avg protein: ${avgProtein}g/day (target: ${proteinTarget}g)\n`;
  response += `• Hit calorie target: ${daysHitCalories}/${dailyLogs.length} days\n`;
  response += `• Hit protein target: ${daysHitProtein}/${dailyLogs.length} days`;

  return response;
}

/**
 * Handle /pause command with optional duration
 */
async function handlePause(user: User, durationArg?: string): Promise<void> {
  let pauseHours = 24; // default
  let pauseMessage = '24 hours';

  if (durationArg) {
    const parsed = parsePauseDuration(durationArg, user.timezone);
    if (parsed) {
      pauseHours = parsed.hours;
      pauseMessage = parsed.message;
    }
  }

  const pauseUntil = new Date(Date.now() + pauseHours * 60 * 60 * 1000);

  await prisma.user.update({
    where: { id: user.id },
    data: {
      remindersPaused: true,
      remindersPausedUntil: pauseUntil,
    },
  });

  await sendSMS(
    user.phone,
    `Reminders paused for ${pauseMessage}. ⏸️\n\nText /resume anytime to turn them back on.`
  );
}

/**
 * Parse pause duration from user input
 * Supports: "4h", "4 hours", "until 6pm", "until tomorrow"
 */
function parsePauseDuration(
  input: string,
  timezone: string
): { hours: number; message: string } | null {
  const lower = input.toLowerCase().trim();

  // Pattern: "4h" or "4 hours" or "4hr"
  const hoursMatch = lower.match(/^(\d+)\s*h(ours?|r)?$/);
  if (hoursMatch) {
    const hours = parseInt(hoursMatch[1], 10);
    if (hours >= 1 && hours <= 168) {
      return { hours, message: `${hours} hour${hours > 1 ? 's' : ''}` };
    }
  }

  // Pattern: "until 6pm" or "until 18:00"
  const untilMatch = lower.match(/^until\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (untilMatch) {
    let targetHour = parseInt(untilMatch[1], 10);
    const targetMinute = untilMatch[2] ? parseInt(untilMatch[2], 10) : 0;
    const meridiem = untilMatch[3]?.toLowerCase();

    // Convert to 24-hour format
    if (meridiem === 'pm' && targetHour !== 12) {
      targetHour += 12;
    } else if (meridiem === 'am' && targetHour === 12) {
      targetHour = 0;
    }

    // Calculate hours until that time
    const now = new Date();
    const currentHour = getCurrentTimeDecimal(timezone);
    const targetTime = targetHour + targetMinute / 60;

    let hoursUntil = targetTime - currentHour;
    if (hoursUntil <= 0) {
      hoursUntil += 24; // Next day
    }

    if (hoursUntil >= 0.5 && hoursUntil <= 24) {
      const displayTime = formatTimeForDisplay(targetHour, targetMinute);
      return { hours: hoursUntil, message: `until ${displayTime}` };
    }
  }

  // Pattern: "until tomorrow" or "tomorrow"
  if (lower.includes('tomorrow')) {
    // Calculate hours until 8am tomorrow
    const currentHour = getCurrentTimeDecimal(timezone);
    const hoursUntil = 24 - currentHour + 8; // Until 8am tomorrow
    return { hours: Math.min(hoursUntil, 24), message: 'until tomorrow morning' };
  }

  return null;
}

/**
 * Format time for display
 */
function formatTimeForDisplay(hour: number, minute: number): string {
  const isPM = hour >= 12;
  const displayHour = hour % 12 || 12;
  const displayMinute = minute > 0 ? `:${minute.toString().padStart(2, '0')}` : '';
  return `${displayHour}${displayMinute}${isPM ? 'pm' : 'am'}`;
}

/**
 * Handle /resume command
 */
async function handleResume(user: User): Promise<void> {
  await prisma.user.update({
    where: { id: user.id },
    data: {
      remindersPaused: false,
      remindersPausedUntil: null,
    },
  });

  await sendSMS(user.phone, `Reminders resumed! ▶️`);
}

/**
 * Get today's macros summary (/macros command)
 */
async function getMacrosSummary(user: User): Promise<string> {
  const today = getTodayDate(user.timezone);

  const dailyLog = await prisma.dailyLog.findUnique({
    where: {
      userId_date: {
        userId: user.id,
        date: today,
      },
    },
  });

  const calorieTarget = user.calorieTarget || 2000;
  const proteinTarget = user.proteinTarget || 150;

  if (!dailyLog || (dailyLog.caloriesTotal === 0 && dailyLog.proteinTotal === 0)) {
    return `Today's Macros\n\nNo food logged yet.\n\nTargets:\n• Calories: ${calorieTarget.toLocaleString()}\n• Protein: ${proteinTarget}g`;
  }

  const caloriesRemaining = calorieTarget - dailyLog.caloriesTotal;
  const proteinRemaining = proteinTarget - dailyLog.proteinTotal;

  let response = `Today's Macros\n\n`;
  response += `Calories: ${dailyLog.caloriesTotal.toLocaleString()} / ${calorieTarget.toLocaleString()}`;
  if (caloriesRemaining > 0) {
    response += ` (${caloriesRemaining.toLocaleString()} left)`;
  } else if (caloriesRemaining < 0) {
    response += ` (${Math.abs(caloriesRemaining).toLocaleString()} over)`;
  } else {
    response += ` ✓`;
  }

  response += `\n\nProtein: ${dailyLog.proteinTotal}g / ${proteinTarget}g`;
  if (proteinRemaining > 0) {
    response += ` (${proteinRemaining}g left)`;
  } else {
    response += ` ✓`;
  }

  // Add suggestion if low on protein but have calories left
  if (proteinRemaining > 30 && caloriesRemaining > 200) {
    response += `\n\nTip: Need ${proteinRemaining}g protein with ${caloriesRemaining} cal left? Greek yogurt, chicken, or a shake.`;
  }

  return response;
}

/**
 * Get quick status (/status command)
 */
async function getQuickStatus(user: User): Promise<string> {
  const today = getTodayDate(user.timezone);

  // Get today's log
  const dailyLog = await prisma.dailyLog.findUnique({
    where: {
      userId_date: {
        userId: user.id,
        date: today,
      },
    },
  });

  // Get this week's workout count
  const dayOfWeek = today.getDay();
  const startOfWeek = new Date(today);
  startOfWeek.setDate(today.getDate() - dayOfWeek);

  const workoutsThisWeek = await prisma.workoutEntry.count({
    where: {
      userId: user.id,
      loggedAt: {
        gte: startOfWeek,
      },
    },
  });

  const calorieTarget = user.calorieTarget || 2000;
  const proteinTarget = user.proteinTarget || 150;

  let response = `Quick Status\n\n`;

  // Streak
  response += `🔥 ${user.loggingStreakDays} day streak\n\n`;

  // Today
  if (dailyLog && (dailyLog.caloriesTotal > 0 || dailyLog.proteinTotal > 0)) {
    const calPct = Math.round((dailyLog.caloriesTotal / calorieTarget) * 100);
    const protPct = Math.round((dailyLog.proteinTotal / proteinTarget) * 100);
    response += `Today: ${calPct}% cal, ${protPct}% protein`;
    if (dailyLog.workoutLogged) {
      response += ` 💪`;
    }
  } else {
    response += `Today: Nothing logged yet`;
  }

  // Week
  response += `\n\nWeek: ${workoutsThisWeek}/${user.weeklyWorkoutTarget} workouts`;
  if (workoutsThisWeek >= user.weeklyWorkoutTarget) {
    response += ` ✓`;
  }

  return response;
}

/**
 * Get yesterday's food summary (/yesterday command)
 */
async function getYesterdaySummary(user: User): Promise<string> {
  const today = getTodayDate(user.timezone);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  // Get yesterday's daily log
  const dailyLog = await prisma.dailyLog.findUnique({
    where: {
      userId_date: {
        userId: user.id,
        date: yesterday,
      },
    },
  });

  if (!dailyLog || (dailyLog.caloriesTotal === 0 && dailyLog.proteinTotal === 0)) {
    return `Yesterday\n\nNo food logged.`;
  }

  // Get food entries from yesterday
  const foodEntries = await prisma.foodEntry.findMany({
    where: {
      userId: user.id,
      dailyLogId: dailyLog.id,
    },
    orderBy: { loggedAt: 'asc' },
  });

  const calorieTarget = dailyLog.calorieTarget || user.calorieTarget || 2000;
  const proteinTarget = dailyLog.proteinTarget || user.proteinTarget || 150;

  let response = `Yesterday\n\n`;

  // Group by meal type
  const mealTypes = ['breakfast', 'lunch', 'dinner', 'snack'] as const;

  for (const mealType of mealTypes) {
    const mealEntries = foodEntries.filter(e => e.mealType === mealType);
    if (mealEntries.length === 0) continue;

    const mealLabel = mealType.charAt(0).toUpperCase() + mealType.slice(1);
    response += `${mealLabel}:\n`;

    for (const entry of mealEntries) {
      const items = entry.foodItems as { name: string; quantity: string; calories: number; protein: number }[];
      for (const item of items) {
        response += `• ${item.name} (${item.quantity}) — ${item.calories} cal, ${item.protein}g\n`;
      }
    }
    response += '\n';
  }

  // Totals
  response += `Total: ${dailyLog.caloriesTotal.toLocaleString()} cal, ${dailyLog.proteinTotal}g protein`;

  // Compare to targets
  const calDiff = dailyLog.caloriesTotal - calorieTarget;
  const protDiff = dailyLog.proteinTotal - proteinTarget;

  if (Math.abs(calDiff) > 100 || Math.abs(protDiff) > 10) {
    response += '\n(';
    if (calDiff > 100) response += `${calDiff.toLocaleString()} cal over`;
    else if (calDiff < -100) response += `${Math.abs(calDiff).toLocaleString()} cal under`;

    if (Math.abs(calDiff) > 100 && Math.abs(protDiff) > 10) response += ', ';

    if (protDiff > 10) response += `${protDiff}g protein over`;
    else if (protDiff < -10) response += `${Math.abs(protDiff)}g protein short`;
    response += ')';
  }

  return response;
}
