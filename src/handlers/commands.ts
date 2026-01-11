import { User } from '@prisma/client';
import prisma from '../lib/db';
import { sendSMS } from '../services/sendblue';
import { enterSettings } from './settings';
import { getTodaySummary } from './food-log';
import { getWeeklyWorkoutSummary } from './workout-log';
import { getWeightProgress } from './weight-log';
import { getProgressSummary } from './progress';

/**
 * Handle slash commands
 */
export async function handleCommand(
  user: User,
  command: string
): Promise<void> {
  const cmd = command.toLowerCase().trim();

  switch (cmd) {
    case '/settings':
      await enterSettings(user);
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
      await handlePause(user);
      break;

    case '/resume':
      await handleResume(user);
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

/today — View today's food & workout log
/week — View this week's summary
/progress — See your overall progress
/settings — Adjust goals, reminders & more
/pause — Pause reminders temporarily
/resume — Resume reminders

Just text naturally to log:
• "Had eggs and toast for breakfast"
• "Chipotle bowl for lunch"
• "Did chest and back at the gym"
• "185.5" (to log weight)
• Send a food photo

Questions? Just ask! I'm here to help.`;
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
 * Handle /pause command
 */
async function handlePause(user: User): Promise<void> {
  // For now, pause for 24 hours by default
  // Could make this interactive to ask for duration

  const pauseUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await prisma.user.update({
    where: { id: user.id },
    data: {
      remindersPaused: true,
      remindersPausedUntil: pauseUntil,
    },
  });

  await sendSMS(
    user.phone,
    `Reminders paused for 24 hours. ⏸️\n\nText /resume anytime to turn them back on.`
  );
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
