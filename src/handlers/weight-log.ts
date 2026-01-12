import { User, Prisma } from '@prisma/client';
import prisma from '../lib/db';
import { sendSMS, sendSMSWithEffect, SendStyle } from '../services/sendblue';
import { getTodayDate, parseWeight } from '../lib/calculations';

/**
 * Handle weight logging from message
 */
export async function handleWeightLogMessage(
  user: User,
  message: string
): Promise<void> {
  // Try to parse weight from message
  const weight = parseWeight(message);

  if (!weight) {
    await sendSMS(
      user.phone,
      "I couldn't parse that weight. Just send a number, like '185' or '185.5 lbs'."
    );
    return;
  }

  await handleWeightLog(user, weight);
}

/**
 * Handle weight logging
 */
export async function handleWeightLog(
  user: User,
  weight: number
): Promise<void> {
  const today = getTodayDate(user.timezone);

  // Check for unrealistic change
  if (user.currentWeight) {
    const change = Math.abs(weight - user.currentWeight);
    if (change > 10) {
      // More than 10 lbs change in a day is unusual
      await sendSMS(
        user.phone,
        `${weight} lbs would be a ${change.toFixed(1)} lb change from ${user.currentWeight} lbs. Is that right? Reply 'yes' to confirm or correct the number.`
      );

      // Store pending confirmation
      await prisma.conversationContext.upsert({
        where: { userId: user.id },
        create: {
          userId: user.id,
          pendingFoodEntry: { type: 'weight', weight } as unknown as object,
          lastIntent: 'weight_log',
        },
        update: {
          pendingFoodEntry: { type: 'weight', weight } as unknown as object,
          lastIntent: 'weight_log',
          lastMessageAt: new Date(),
        },
      });
      return;
    }
  }

  await confirmWeightLog(user, weight);
}

/**
 * Confirm and save weight log
 */
export async function confirmWeightLog(
  user: User,
  weight: number
): Promise<void> {
  const today = getTodayDate(user.timezone);

  // Create weight entry
  await prisma.weightEntry.create({
    data: {
      userId: user.id,
      date: today,
      weight,
      timeOfDay: 'morning', // Assume morning if not specified
    },
  });

  // Update user's current weight
  const previousWeight = user.currentWeight;
  await prisma.user.update({
    where: { id: user.id },
    data: { currentWeight: weight },
  });

  // Update daily log if exists
  const dailyLog = await prisma.dailyLog.findUnique({
    where: {
      userId_date: {
        userId: user.id,
        date: today,
      },
    },
  });

  if (dailyLog) {
    await prisma.dailyLog.update({
      where: { id: dailyLog.id },
      data: { weight },
    });
  }

  // Clear any pending context
  await prisma.conversationContext.update({
    where: { userId: user.id },
    data: { pendingFoodEntry: Prisma.DbNull, lastIntent: null },
  }).catch(() => {}); // Ignore if doesn't exist

  // Send response
  let response = `Weight logged: ${weight} lbs ⚖️`;

  if (previousWeight) {
    const change = weight - previousWeight;
    if (Math.abs(change) >= 0.1) {
      const direction = change < 0 ? 'down' : 'up';
      response += `\n${direction === 'down' ? '↓' : '↑'} ${Math.abs(change).toFixed(1)} lbs from last`;
    }
  }

  // Get trend
  const trend = await getWeightTrend(user.id);
  if (trend) {
    response += `\n\n${trend}`;
  }

  await sendSMS(user.phone, response);

  // Check for weight milestones (send as separate message after a delay with effect)
  const milestone = await checkWeightMilestones(user, weight);
  if (milestone) {
    setTimeout(async () => {
      await sendSMSWithEffect(user.phone, milestone.message, milestone.effect);
    }, 2000);
  }
}

interface WeightMilestone {
  message: string;
  effect: SendStyle;
}

/**
 * Check for weight milestones and return celebration message with effect
 */
async function checkWeightMilestones(user: User, currentWeight: number): Promise<WeightMilestone | null> {
  // Get first weight entry as starting point
  const firstEntry = await prisma.weightEntry.findFirst({
    where: { userId: user.id },
    orderBy: { date: 'asc' },
  });

  if (!firstEntry) return null;

  const startWeight = firstEntry.weight;
  const changeFromStart = startWeight - currentWeight; // Positive = loss, negative = gain
  const absChange = Math.abs(changeFromStart);

  // Check for goal proximity
  if (user.targetWeight) {
    const toGoal = Math.abs(currentWeight - user.targetWeight);

    if (currentWeight === user.targetWeight) {
      // Hit goal weight - FIREWORKS!
      return {
        message: `🎉 You hit your goal weight of ${user.targetWeight} lbs! Incredible achievement. Time to set a new goal?`,
        effect: 'fireworks',
      };
    } else if (toGoal <= 5 && toGoal > 0) {
      return {
        message: `You're within 5 lbs of your goal (${user.targetWeight} lbs). So close! 🎯`,
        effect: 'shooting_star',
      };
    }
  }

  // Check for milestone losses (only celebrate loss milestones for now)
  if (changeFromStart > 0) {
    // Losing weight
    const milestones = [5, 10, 15, 20, 25, 30, 40, 50];

    for (const milestone of milestones.reverse()) {
      if (absChange >= milestone) {
        // Check if we already celebrated this milestone
        const previousEntry = await prisma.weightEntry.findFirst({
          where: {
            userId: user.id,
            date: { lt: getTodayDate(user.timezone) },
          },
          orderBy: { date: 'desc' },
        });

        const prevChangeFromStart = previousEntry ? startWeight - previousEntry.weight : 0;

        if (prevChangeFromStart < milestone) {
          // Just crossed this milestone!
          // Major milestones (20+ lbs) get celebration, smaller get confetti
          const effect: SendStyle = milestone >= 20 ? 'celebration' : 'confetti';
          return {
            message: `🎉 That's ${milestone} lbs down from where you started (${startWeight} lbs)! ${getMilestoneMotivation(milestone)}`,
            effect,
          };
        }
        break;
      }
    }
  }

  return null;
}

/**
 * Get motivational message for weight milestone
 */
function getMilestoneMotivation(lbsLost: number): string {
  if (lbsLost >= 50) return "Life-changing progress. You should be incredibly proud.";
  if (lbsLost >= 30) return "You've transformed. The discipline is paying off.";
  if (lbsLost >= 20) return "Major milestone. This is real, lasting change.";
  if (lbsLost >= 15) return "Significant progress. You're doing the work.";
  if (lbsLost >= 10) return "Double digits! Keep this momentum going.";
  if (lbsLost >= 5) return "First milestone hit. You're on your way!";
  return "Keep it up!";
}

/**
 * Handle weight confirmation
 */
export async function handleWeightConfirmation(
  user: User,
  confirmed: boolean
): Promise<void> {
  const context = await prisma.conversationContext.findUnique({
    where: { userId: user.id },
  });

  const pending = context?.pendingFoodEntry as { type: string; weight: number } | null;

  if (!pending || pending.type !== 'weight') {
    await sendSMS(user.phone, "I don't have a pending weight to confirm.");
    return;
  }

  if (confirmed) {
    await confirmWeightLog(user, pending.weight);
  } else {
    await prisma.conversationContext.update({
      where: { userId: user.id },
      data: { pendingFoodEntry: Prisma.DbNull, lastIntent: null },
    });
    await sendSMS(user.phone, "No problem. What's the correct weight?");
  }
}

/**
 * Get weight trend summary
 */
async function getWeightTrend(userId: string): Promise<string | null> {
  const entries = await prisma.weightEntry.findMany({
    where: { userId },
    orderBy: { date: 'desc' },
    take: 14, // Last 2 weeks
  });

  if (entries.length < 3) {
    return null;
  }

  // Calculate 7-day average if we have enough data
  const recent7 = entries.slice(0, Math.min(7, entries.length));
  const older7 = entries.slice(7, Math.min(14, entries.length));

  if (older7.length < 3) {
    return null;
  }

  const recentAvg = recent7.reduce((sum, e) => sum + e.weight, 0) / recent7.length;
  const olderAvg = older7.reduce((sum, e) => sum + e.weight, 0) / older7.length;
  const weeklyChange = recentAvg - olderAvg;

  if (Math.abs(weeklyChange) < 0.3) {
    return "Trend: Stable weight this week";
  } else if (weeklyChange < 0) {
    return `Trend: Down ${Math.abs(weeklyChange).toFixed(1)} lbs this week 📉`;
  } else {
    return `Trend: Up ${weeklyChange.toFixed(1)} lbs this week 📈`;
  }
}

/**
 * Get weight progress summary
 */
export async function getWeightProgress(user: User): Promise<string> {
  const entries = await prisma.weightEntry.findMany({
    where: { userId: user.id },
    orderBy: { date: 'desc' },
    take: 30,
  });

  if (entries.length === 0) {
    return "No weight entries yet. Text your weight anytime (like '185') to start tracking.";
  }

  const current = entries[0].weight;
  const oldest = entries[entries.length - 1];
  const totalChange = current - oldest.weight;
  const daysSinceStart = Math.ceil(
    (new Date().getTime() - oldest.date.getTime()) / (1000 * 60 * 60 * 24)
  );

  let response = `⚖️ Weight Progress\n\n`;
  response += `Current: ${current} lbs\n`;

  if (entries.length > 1) {
    response += `Started: ${oldest.weight} lbs (${daysSinceStart} days ago)\n`;
    response += `Change: ${totalChange > 0 ? '+' : ''}${totalChange.toFixed(1)} lbs\n`;

    if (daysSinceStart >= 7) {
      const weeklyRate = (totalChange / daysSinceStart) * 7;
      response += `Weekly avg: ${weeklyRate > 0 ? '+' : ''}${weeklyRate.toFixed(1)} lbs/week`;
    }
  }

  if (user.targetWeight) {
    const remaining = current - user.targetWeight;
    response += `\n\nTarget: ${user.targetWeight} lbs`;
    if (remaining > 0) {
      response += ` (${remaining.toFixed(1)} lbs to go)`;

      // Project time to goal if losing weight
      if (totalChange < 0 && daysSinceStart >= 7) {
        const weeklyRate = Math.abs((totalChange / daysSinceStart) * 7);
        if (weeklyRate > 0.1) {
          const weeksToGoal = remaining / weeklyRate;
          response += `\nAt current pace: ~${Math.round(weeksToGoal)} weeks`;
        }
      }
    } else {
      response += ` ✓ Goal reached!`;
    }
  }

  return response;
}
