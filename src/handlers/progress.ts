import { User } from '@prisma/client';
import prisma from '../lib/db';
import { getTodayDate, percentage } from '../lib/calculations';
import { getAdherenceMetrics, getUserInsights, formatInsightsForSMS } from '../services/analytics';

/**
 * Get comprehensive progress summary
 */
export async function getProgressSummary(user: User): Promise<string> {
  let response = 'Your progress 📊\n\n';

  // Weight section
  const weightProgress = await getWeightSection(user);
  response += weightProgress + '\n\n';

  // Trends section
  const trends = await getTrendsSection(user);
  response += trends + '\n\n';

  // Adherence section
  const adherence = await getAdherenceMetrics(user, 30);
  if (adherence.daysAnalyzed >= 7) {
    response += `📋 Adherence (30 days)\n`;
    response += `• Calorie target: ${adherence.calorieAdherence}% of days\n`;
    response += `• Protein target: ${adherence.proteinAdherence}% of days\n`;
    response += `• Overall score: ${adherence.overallScore}/100\n\n`;
  }

  // Streak
  response += `🔥 Streak: ${user.loggingStreakDays} days`;

  // Projection if applicable
  const projection = await getProjection(user);
  if (projection) {
    response += '\n\n' + projection;
  }

  return response;
}

/**
 * Get weight section of progress
 */
async function getWeightSection(user: User): Promise<string> {
  const entries = await prisma.weightEntry.findMany({
    where: { userId: user.id },
    orderBy: { date: 'asc' },
  });

  if (entries.length === 0) {
    return `⚖️ Weight\nNo weight entries yet`;
  }

  const first = entries[0];
  const last = entries[entries.length - 1];
  const change = last.weight - first.weight;
  const daysSinceStart = Math.ceil(
    (last.date.getTime() - first.date.getTime()) / (1000 * 60 * 60 * 24)
  );

  let section = `⚖️ Weight\n`;
  section += `Started: ${first.weight} lbs (${formatDate(first.date)})\n`;
  section += `Current: ${last.weight} lbs\n`;

  if (change !== 0) {
    const direction = change < 0 ? 'Lost' : 'Gained';
    section += `${direction}: ${Math.abs(change).toFixed(1)} lbs`;
    if (daysSinceStart > 7) {
      section += ` in ${Math.round(daysSinceStart / 7)} weeks`;
    }
  }

  return section;
}

/**
 * Get trends section of progress
 */
async function getTrendsSection(user: User): Promise<string> {
  const today = new Date();
  const sevenDaysAgo = new Date(today);
  sevenDaysAgo.setDate(today.getDate() - 7);

  const recentLogs = await prisma.dailyLog.findMany({
    where: {
      userId: user.id,
      date: {
        gte: sevenDaysAgo,
      },
    },
  });

  if (recentLogs.length === 0) {
    return `📈 Trends (last 7 days)\nNo data`;
  }

  const avgCalories = Math.round(
    recentLogs.reduce((sum, log) => sum + log.caloriesTotal, 0) / recentLogs.length
  );
  const avgProtein = Math.round(
    recentLogs.reduce((sum, log) => sum + log.proteinTotal, 0) / recentLogs.length
  );
  const workoutsThisWeek = await prisma.workoutEntry.count({
    where: {
      userId: user.id,
      loggedAt: {
        gte: sevenDaysAgo,
      },
    },
  });

  const calorieTarget = user.calorieTarget || 2000;
  const proteinTarget = user.proteinTarget || 150;

  let section = `📈 Trends (last 7 days)\n`;
  section += `Avg calories: ${avgCalories.toLocaleString()}/day (target: ${calorieTarget.toLocaleString()})`;

  if (avgCalories <= calorieTarget * 1.05) {
    section += ' ✓';
  }
  section += '\n';

  section += `Avg protein: ${avgProtein}g/day (target: ${proteinTarget}g)`;
  const proteinPct = percentage(avgProtein, proteinTarget);
  if (proteinPct < 90) {
    section += ` — ${proteinPct}%`;
  } else {
    section += ' ✓';
  }
  section += '\n';

  section += `Workouts: ${workoutsThisWeek}/${user.weeklyWorkoutTarget}`;
  if (workoutsThisWeek >= user.weeklyWorkoutTarget) {
    section += ' ✓';
  }

  return section;
}

/**
 * Get projection if applicable
 */
async function getProjection(user: User): Promise<string | null> {
  if (!user.targetWeight || !user.currentWeight) {
    return null;
  }

  // Get weight entries from last 30 days
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const entries = await prisma.weightEntry.findMany({
    where: {
      userId: user.id,
      date: {
        gte: thirtyDaysAgo,
      },
    },
    orderBy: { date: 'asc' },
  });

  if (entries.length < 7) {
    return null;
  }

  const first = entries[0];
  const last = entries[entries.length - 1];
  const daysBetween = Math.ceil(
    (last.date.getTime() - first.date.getTime()) / (1000 * 60 * 60 * 24)
  );

  if (daysBetween < 7) {
    return null;
  }

  const totalChange = last.weight - first.weight;
  const weeklyRate = (totalChange / daysBetween) * 7;

  // Only project if moving toward goal
  const weightToGo = user.currentWeight - user.targetWeight;
  const movingTowardGoal =
    (weightToGo > 0 && weeklyRate < 0) || (weightToGo < 0 && weeklyRate > 0);

  if (!movingTowardGoal || Math.abs(weeklyRate) < 0.2) {
    return null;
  }

  const weeksToGoal = Math.abs(weightToGo / weeklyRate);

  return `At this pace, you'd hit ${user.targetWeight} lbs in about ${Math.round(weeksToGoal)} weeks.`;
}

/**
 * Format date for display
 */
function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Get detailed analytics for power users
 */
export async function getDetailedAnalytics(user: User): Promise<string> {
  const insights = await getUserInsights(user, 30);
  return formatInsightsForSMS(insights);
}
