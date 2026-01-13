import { Queue, Worker, Job } from 'bullmq';
import { ReminderType } from '@prisma/client';
import prisma from '../lib/db';
import { sendSMS } from './sendblue';
import { getTodayDate, getDayOfWeek } from '../lib/calculations';
import { config } from '../config';

// Job types
const JOB_TYPES = {
  CHECK_REMINDERS: 'check_reminders',
  SEND_DAILY_SUMMARY: 'send_daily_summary',
  CHECK_INACTIVE_USERS: 'check_inactive_users',
  CHECK_WEEKLY_SUMMARY: 'check_weekly_summary',
} as const;

type JobType = typeof JOB_TYPES[keyof typeof JOB_TYPES];

interface ReminderJobData {
  type: JobType;
}

// Redis connection options for BullMQ
const redisConnection = {
  host: new URL(config.redis.url).hostname || 'localhost',
  port: parseInt(new URL(config.redis.url).port || '6379', 10),
  password: new URL(config.redis.url).password || undefined,
};

// Create queue
const reminderQueue = new Queue<ReminderJobData>('reminders', {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: 100,
    removeOnFail: 50,
  },
});

// Reminder message templates
const REMINDER_MESSAGES = {
  breakfast: [
    "Good morning! ☀️ What's for breakfast?",
    "Morning! What did you have to start the day?",
    "Hey! Breakfast logged yet? What'd you have?",
  ],
  lunch: [
    "Lunch time! What are you having?",
    "Afternoon check-in — what's for lunch?",
    "Hey, what did you have for lunch?",
  ],
  dinner: [
    "Evening! What's for dinner tonight?",
    "What's on the menu for dinner?",
    "Hey! What did you have for dinner?",
  ],
  morning_checkin: [
    "Good morning! What's the food/workout plan today?",
    "Morning! Ready to crush it today? What's on the agenda?",
  ],
  evening_checkin: [
    "How did today go? Anything you want to note?",
    "End of day check-in — how are you feeling about today?",
  ],
  weigh_in: [
    "It's weigh-in day! ⚖️\n\nStep on the scale and text me the number. Remember: same time, same conditions for best comparison.",
  ],
  missed_day: [
    "Hey, I didn't hear from you yesterday. Everything okay?\n\nNo pressure — just checking in. Ready to log today when you are.",
  ],
  multi_day_absence: [
    "Hey — haven't heard from you in a few days. Just wanted to check in.\n\nIf things got busy, no worries. If you want to pause reminders for a bit, just text /pause.\n\nI'm here when you're ready.",
  ],
};

/**
 * Get a random message from the template array
 */
function getRandomMessage(messages: string[]): string {
  return messages[Math.floor(Math.random() * messages.length)];
}

/**
 * Check if reminder was already sent today
 */
async function wasReminderSentToday(
  userId: string,
  reminderType: ReminderType,
  timezone: string
): Promise<boolean> {
  const today = getTodayDate(timezone);

  const sent = await prisma.sentReminder.findUnique({
    where: {
      userId_reminderType_sentForDate: {
        userId,
        reminderType,
        sentForDate: today,
      },
    },
  });

  return !!sent;
}

/**
 * Mark reminder as sent
 */
async function markReminderSent(
  userId: string,
  reminderType: ReminderType,
  timezone: string
): Promise<void> {
  const today = getTodayDate(timezone);

  await prisma.sentReminder.upsert({
    where: {
      userId_reminderType_sentForDate: {
        userId,
        reminderType,
        sentForDate: today,
      },
    },
    create: {
      userId,
      reminderType,
      sentForDate: today,
    },
    update: {
      sentAt: new Date(),
    },
  });
}

/**
 * Check and send meal reminders for all users
 */
async function checkMealReminders(): Promise<void> {
  const users = await prisma.user.findMany({
    where: {
      onboardingComplete: true,
      remindersPaused: false,
      accountabilityLevel: { in: ['medium', 'high'] },
    },
    include: {
      reminders: true,
    },
  });

  for (const user of users) {
    try {
      // Check if paused and should auto-resume
      if (user.remindersPausedUntil && user.remindersPausedUntil < new Date()) {
        await prisma.user.update({
          where: { id: user.id },
          data: { remindersPaused: false, remindersPausedUntil: null },
        });
      }

      if (user.remindersPaused) continue;

      const now = new Date();
      const currentTime = now.toLocaleTimeString('en-US', {
        timeZone: user.timezone,
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
      });

      // Get today's log
      const today = getTodayDate(user.timezone);
      const dailyLog = await prisma.dailyLog.findUnique({
        where: {
          userId_date: {
            userId: user.id,
            date: today,
          },
        },
      });

      // Check breakfast reminder (only if enabled)
      if (
        user.reminderBreakfastEnabled &&
        currentTime >= user.reminderBreakfastTime &&
        currentTime < user.reminderLunchTime &&
        (!dailyLog || !dailyLog.breakfastLogged)
      ) {
        const alreadySent = await wasReminderSentToday(user.id, 'breakfast', user.timezone);
        if (!alreadySent) {
          await sendSMS(user.phone, getRandomMessage(REMINDER_MESSAGES.breakfast));
          await markReminderSent(user.id, 'breakfast', user.timezone);
        }
      }

      // Check lunch reminder (only if enabled)
      if (
        user.reminderLunchEnabled &&
        currentTime >= user.reminderLunchTime &&
        currentTime < user.reminderDinnerTime &&
        (!dailyLog || !dailyLog.lunchLogged)
      ) {
        const alreadySent = await wasReminderSentToday(user.id, 'lunch', user.timezone);
        if (!alreadySent) {
          await sendSMS(user.phone, getRandomMessage(REMINDER_MESSAGES.lunch));
          await markReminderSent(user.id, 'lunch', user.timezone);
        }
      }

      // Check dinner reminder (only if enabled)
      // Add upper bound of 23:30 to prevent midnight edge cases
      if (
        user.reminderDinnerEnabled &&
        currentTime >= user.reminderDinnerTime &&
        currentTime < '23:30' &&
        (!dailyLog || !dailyLog.dinnerLogged)
      ) {
        const alreadySent = await wasReminderSentToday(user.id, 'dinner', user.timezone);
        if (!alreadySent) {
          await sendSMS(user.phone, getRandomMessage(REMINDER_MESSAGES.dinner));
          await markReminderSent(user.id, 'dinner', user.timezone);
        }
      }
    } catch (error) {
      console.error(`Error checking reminders for user ${user.id}:`, error);
    }
  }
}

/**
 * Check and send morning/evening check-ins for high accountability users
 */
async function checkHighAccountabilityReminders(): Promise<void> {
  const users = await prisma.user.findMany({
    where: {
      onboardingComplete: true,
      remindersPaused: false,
      accountabilityLevel: 'high',
    },
  });

  for (const user of users) {
    try {
      const now = new Date();
      const currentTime = now.toLocaleTimeString('en-US', {
        timeZone: user.timezone,
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
      });

      // Morning check-in around 7am
      if (currentTime >= '07:00' && currentTime < '08:00') {
        const alreadySent = await wasReminderSentToday(user.id, 'morning_checkin', user.timezone);
        if (!alreadySent) {
          await sendSMS(user.phone, getRandomMessage(REMINDER_MESSAGES.morning_checkin));
          await markReminderSent(user.id, 'morning_checkin', user.timezone);
        }
      }

      // Evening check-in around 9:30pm
      if (currentTime >= '21:30' && currentTime < '22:00') {
        const alreadySent = await wasReminderSentToday(user.id, 'evening_checkin', user.timezone);
        if (!alreadySent) {
          await sendSMS(user.phone, getRandomMessage(REMINDER_MESSAGES.evening_checkin));
          await markReminderSent(user.id, 'evening_checkin', user.timezone);
        }
      }
    } catch (error) {
      console.error(`Error checking high accountability reminders for user ${user.id}:`, error);
    }
  }
}

/**
 * Check and send weigh-in reminders
 */
async function checkWeighInReminders(): Promise<void> {
  const users = await prisma.user.findMany({
    where: {
      onboardingComplete: true,
      remindersPaused: false,
      accountabilityLevel: { in: ['medium', 'high'] },
    },
  });

  for (const user of users) {
    try {
      const currentDay = getDayOfWeek(user.timezone);
      if (currentDay !== user.weighInDay) continue;

      const now = new Date();
      const currentTime = now.toLocaleTimeString('en-US', {
        timeZone: user.timezone,
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
      });

      // Send weigh-in reminder at 8am
      if (currentTime >= '08:00' && currentTime < '09:00') {
        const alreadySent = await wasReminderSentToday(user.id, 'weigh_in', user.timezone);
        if (!alreadySent) {
          // Get last weight for context
          const lastWeight = await prisma.weightEntry.findFirst({
            where: { userId: user.id },
            orderBy: { date: 'desc' },
          });

          let message = getRandomMessage(REMINDER_MESSAGES.weigh_in);
          if (lastWeight) {
            message += `\n\nLast week: ${lastWeight.weight} lbs`;
          }

          await sendSMS(user.phone, message);
          await markReminderSent(user.id, 'weigh_in', user.timezone);
        }
      }
    } catch (error) {
      console.error(`Error checking weigh-in reminder for user ${user.id}:`, error);
    }
  }
}

/**
 * Send daily summaries
 */
async function sendDailySummaries(): Promise<void> {
  const users = await prisma.user.findMany({
    where: {
      onboardingComplete: true,
      remindersPaused: false,
    },
  });

  for (const user of users) {
    try {
      const now = new Date();
      const currentTime = now.toLocaleTimeString('en-US', {
        timeZone: user.timezone,
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
      });

      // Check if it's time for daily summary
      if (currentTime >= user.dailySummaryTime && currentTime < addMinutes(user.dailySummaryTime, 30)) {
        const alreadySent = await wasReminderSentToday(user.id, 'daily_summary', user.timezone);
        if (!alreadySent) {
          await sendDailySummary(user);
          await markReminderSent(user.id, 'daily_summary', user.timezone);
        }
      }
    } catch (error) {
      console.error(`Error sending daily summary for user ${user.id}:`, error);
    }
  }
}

/**
 * Send daily summary to a user
 */
async function sendDailySummary(user: { id: string; phone: string; timezone: string; calorieTarget: number | null; proteinTarget: number | null; loggingStreakDays: number; streakJustBroken: number | null }): Promise<void> {
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

  let message = 'Daily wrap-up 📊\n\n';

  if (!dailyLog || (dailyLog.caloriesTotal === 0 && !dailyLog.workoutLogged)) {
    // Nothing logged today
    message += "I didn't get any logs from you today.\n\n";
    message += "If you ate but didn't log, no worries — happens to everyone. ";
    message += "If you're struggling to stay consistent, let me know and we can adjust.\n\n";

    if (user.streakJustBroken) {
      message += `Your streak was ${user.streakJustBroken} days. `;
      // Clear the broken streak flag
      await prisma.user.update({
        where: { id: user.id },
        data: { streakJustBroken: null },
      });
    }

    message += "Let's start fresh tomorrow. 💪";
  } else {
    // Format summary
    const calPct = Math.round((dailyLog.caloriesTotal / calorieTarget) * 100);
    const protPct = Math.round((dailyLog.proteinTotal / proteinTarget) * 100);

    message += `🔥 Calories: ${dailyLog.caloriesTotal.toLocaleString()} / ${calorieTarget.toLocaleString()} (${calPct}%)\n`;
    message += `💪 Protein: ${dailyLog.proteinTotal} / ${proteinTarget}g (${protPct}%)\n`;
    message += `🏋️ Workout: ${dailyLog.workoutLogged ? '✓' : 'Rest day'}\n\n`;

    // Add contextual feedback
    const calorieDiff = dailyLog.caloriesTotal - calorieTarget;
    const proteinDiff = dailyLog.proteinTotal - proteinTarget;

    if (calPct >= 90 && calPct <= 110 && protPct >= 90) {
      message += "Solid day! Right on target. 💪";
    } else if (calorieDiff > 300) {
      message += `Calories ran a bit high today. It happens — just data, not judgment. Tomorrow's a new day.`;
      if (protPct < 80) {
        message += `\n\nTip: Front-loading protein at breakfast makes it easier to hit.`;
      }
    } else if (protPct < 80) {
      message += `Protein was light today at ${protPct}%. Try to prioritize it tomorrow.`;
    } else {
      message += "Keep up the good work!";
    }

    message += `\n\nStreak: ${user.loggingStreakDays} days 🔥`;
  }

  // Mark summary as sent in daily log
  if (dailyLog) {
    await prisma.dailyLog.update({
      where: { id: dailyLog.id },
      data: {
        summarySent: true,
        summarySentAt: new Date(),
      },
    });
  }

  await sendSMS(user.phone, message);
}

/**
 * Check for inactive users and send follow-up
 */
async function checkInactiveUsers(): Promise<void> {
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

  // Users who haven't logged in 1 day (missed day reminder)
  const oneDayInactive = await prisma.user.findMany({
    where: {
      onboardingComplete: true,
      remindersPaused: false,
      accountabilityLevel: { in: ['medium', 'high'] },
      lastMessageAt: {
        lt: oneDayAgo,
        gte: threeDaysAgo,
      },
    },
  });

  for (const user of oneDayInactive) {
    const alreadySent = await wasReminderSentToday(user.id, 'morning_checkin', user.timezone);
    if (!alreadySent) {
      await sendSMS(user.phone, getRandomMessage(REMINDER_MESSAGES.missed_day));
      await markReminderSent(user.id, 'morning_checkin', user.timezone);
    }
  }

  // Users who haven't logged in 3+ days (multi-day absence)
  const threeDayInactive = await prisma.user.findMany({
    where: {
      onboardingComplete: true,
      remindersPaused: false,
      lastMessageAt: {
        lt: threeDaysAgo,
      },
    },
  });

  for (const user of threeDayInactive) {
    // Only send once per 3-day period
    const lastSent = await prisma.sentReminder.findFirst({
      where: {
        userId: user.id,
        reminderType: 'evening_checkin', // Reuse for multi-day
        sentAt: {
          gte: threeDaysAgo,
        },
      },
    });

    if (!lastSent) {
      await sendSMS(user.phone, getRandomMessage(REMINDER_MESSAGES.multi_day_absence));
      await prisma.sentReminder.create({
        data: {
          userId: user.id,
          reminderType: 'evening_checkin',
          sentForDate: getTodayDate(user.timezone),
        },
      });
    }
  }
}

/**
 * Send weekly summaries on Sunday evening
 */
async function sendWeeklySummaries(): Promise<void> {
  const users = await prisma.user.findMany({
    where: {
      onboardingComplete: true,
    },
  });

  for (const user of users) {
    try {
      const currentDay = getDayOfWeek(user.timezone);
      if (currentDay !== 'SU') continue;

      const now = new Date();
      const currentTime = now.toLocaleTimeString('en-US', {
        timeZone: user.timezone,
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
      });

      // Send at 7pm on Sunday
      if (currentTime >= '19:00' && currentTime < '20:00') {
        const alreadySent = await wasReminderSentToday(user.id, 'hydration', user.timezone); // Reuse for weekly
        if (!alreadySent) {
          await sendWeeklySummary(user);
          await markReminderSent(user.id, 'hydration', user.timezone);
        }
      }
    } catch (error) {
      console.error(`Error sending weekly summary for user ${user.id}:`, error);
    }
  }
}

/**
 * Send weekly summary to a user
 */
async function sendWeeklySummary(user: { id: string; phone: string; timezone: string; calorieTarget: number | null; proteinTarget: number | null; weeklyWorkoutTarget: number; loggingStreakDays: number }): Promise<void> {
  const today = new Date();
  const startOfWeek = new Date(today);
  startOfWeek.setDate(today.getDate() - 7);
  startOfWeek.setHours(0, 0, 0, 0);

  // Get this week's data
  const dailyLogs = await prisma.dailyLog.findMany({
    where: {
      userId: user.id,
      date: {
        gte: startOfWeek,
      },
    },
  });

  const workouts = await prisma.workoutEntry.findMany({
    where: {
      userId: user.id,
      loggedAt: {
        gte: startOfWeek,
      },
    },
  });

  const weightEntries = await prisma.weightEntry.findMany({
    where: {
      userId: user.id,
      date: {
        gte: startOfWeek,
      },
    },
    orderBy: { date: 'desc' },
  });

  // Calculate averages
  const daysLogged = dailyLogs.length;
  const avgCalories = daysLogged > 0
    ? Math.round(dailyLogs.reduce((sum, log) => sum + log.caloriesTotal, 0) / daysLogged)
    : 0;
  const avgProtein = daysLogged > 0
    ? Math.round(dailyLogs.reduce((sum, log) => sum + log.proteinTotal, 0) / daysLogged)
    : 0;

  const calorieTarget = user.calorieTarget || 2000;
  const proteinTarget = user.proteinTarget || 150;

  // Get previous week for comparison
  const twoWeeksAgo = new Date(startOfWeek);
  twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 7);

  const prevWeekLogs = await prisma.dailyLog.findMany({
    where: {
      userId: user.id,
      date: {
        gte: twoWeeksAgo,
        lt: startOfWeek,
      },
    },
  });

  const prevAvgCalories = prevWeekLogs.length > 0
    ? Math.round(prevWeekLogs.reduce((sum, log) => sum + log.caloriesTotal, 0) / prevWeekLogs.length)
    : null;
  const prevAvgProtein = prevWeekLogs.length > 0
    ? Math.round(prevWeekLogs.reduce((sum, log) => sum + log.proteinTotal, 0) / prevWeekLogs.length)
    : null;

  let message = 'Weekly Summary 📈\n\n';
  message += 'This week vs last:\n';
  message += `• Avg calories: ${avgCalories.toLocaleString()}/day`;
  if (prevAvgCalories) {
    const diff = avgCalories - prevAvgCalories;
    message += ` (${diff >= 0 ? '↑' : '↓'} ${Math.abs(diff)})`;
  }
  message += '\n';

  message += `• Avg protein: ${avgProtein}g/day`;
  if (prevAvgProtein) {
    const diff = avgProtein - prevAvgProtein;
    message += ` (${diff >= 0 ? '↑' : '↓'} ${Math.abs(diff)})`;
  }
  message += '\n';

  message += `• Workouts: ${workouts.length}`;
  if (workouts.length >= user.weeklyWorkoutTarget) {
    message += ' ✓';
  }
  message += '\n';

  if (weightEntries.length > 0) {
    message += `• Weight: ${weightEntries[0].weight} lbs\n`;
  }

  // Highlights
  const highlights: string[] = [];

  const proteinDaysHit = dailyLogs.filter(log => log.proteinTotal >= proteinTarget * 0.9).length;
  if (proteinDaysHit >= 5) {
    highlights.push(`Hit protein target ${proteinDaysHit}/${daysLogged} days`);
  }

  if (user.loggingStreakDays >= 7) {
    highlights.push(`${user.loggingStreakDays}-day logging streak`);
  }

  // Monthly consistency celebration (non-consecutive days)
  const monthAgo = new Date(today);
  monthAgo.setDate(today.getDate() - 28);
  const monthlyLogs = await prisma.dailyLog.findMany({
    where: {
      userId: user.id,
      date: {
        gte: monthAgo,
      },
      caloriesTotal: { gt: 0 },
    },
  });

  const monthlyDaysLogged = monthlyLogs.length;
  const monthlyPercentage = Math.round((monthlyDaysLogged / 28) * 100);
  if (monthlyDaysLogged >= 20) {
    highlights.push(`${monthlyDaysLogged}/28 days logged this month (${monthlyPercentage}%) — real consistency!`);
  } else if (monthlyDaysLogged >= 14 && monthlyDaysLogged < 20) {
    highlights.push(`${monthlyDaysLogged} days logged this month — building consistency!`);
  }

  if (highlights.length > 0) {
    message += '\n🔥 Highlights:\n';
    for (const h of highlights) {
      message += `• ${h}\n`;
    }
  }

  message += '\nKeep it up! 💪';

  await sendSMS(user.phone, message);
}

/**
 * Add minutes to a time string
 */
function addMinutes(time: string, minutes: number): string {
  const [hours, mins] = time.split(':').map(Number);
  const totalMins = hours * 60 + mins + minutes;
  const newHours = Math.floor(totalMins / 60) % 24;
  const newMins = totalMins % 60;
  return `${newHours.toString().padStart(2, '0')}:${newMins.toString().padStart(2, '0')}`;
}

/**
 * Process reminder jobs
 */
async function processReminderJob(job: Job<ReminderJobData>): Promise<void> {
  console.log(`Processing reminder job: ${job.data.type}`);

  switch (job.data.type) {
    case 'check_reminders':
      await checkMealReminders();
      await checkHighAccountabilityReminders();
      await checkWeighInReminders();
      break;

    case 'send_daily_summary':
      await sendDailySummaries();
      break;

    case 'check_inactive_users':
      await checkInactiveUsers();
      break;

    case 'check_weekly_summary':
      await sendWeeklySummaries();
      break;
  }
}

/**
 * Start the scheduler worker
 */
export async function startScheduler(): Promise<void> {
  // Create worker
  const worker = new Worker<ReminderJobData>('reminders', processReminderJob, {
    connection: redisConnection,
    concurrency: 1, // Process one at a time to avoid rate limits
  });

  worker.on('completed', (job) => {
    console.log(`Reminder job completed: ${job.id}`);
  });

  worker.on('failed', (job, err) => {
    console.error(`Reminder job failed: ${job?.id}`, err);
  });

  // Schedule recurring jobs
  // Check reminders every 15 minutes
  await reminderQueue.add(
    JOB_TYPES.CHECK_REMINDERS,
    { type: JOB_TYPES.CHECK_REMINDERS },
    {
      repeat: {
        pattern: '*/15 * * * *', // Every 15 minutes
      },
    }
  );

  // Check daily summaries every 30 minutes
  await reminderQueue.add(
    JOB_TYPES.SEND_DAILY_SUMMARY,
    { type: JOB_TYPES.SEND_DAILY_SUMMARY },
    {
      repeat: {
        pattern: '*/30 * * * *', // Every 30 minutes
      },
    }
  );

  // Check inactive users once a day at 10am
  await reminderQueue.add(
    JOB_TYPES.CHECK_INACTIVE_USERS,
    { type: JOB_TYPES.CHECK_INACTIVE_USERS },
    {
      repeat: {
        pattern: '0 10 * * *', // 10am daily
      },
    }
  );

  // Check weekly summaries on Sunday
  await reminderQueue.add(
    JOB_TYPES.CHECK_WEEKLY_SUMMARY,
    { type: JOB_TYPES.CHECK_WEEKLY_SUMMARY },
    {
      repeat: {
        pattern: '0 19 * * 0', // 7pm Sunday
      },
    }
  );

  console.log('Scheduler started');
}

/**
 * Stop the scheduler
 */
export async function stopScheduler(): Promise<void> {
  await reminderQueue.close();
  console.log('Scheduler stopped');
}

export { reminderQueue };
