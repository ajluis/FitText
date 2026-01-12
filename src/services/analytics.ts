/**
 * Analytics service for tracking adherence, patterns, and insights
 */
import { User } from '@prisma/client';
import prisma from '../lib/db';
import { getTodayDate } from '../lib/calculations';

// ============================================
// TYPES
// ============================================

export interface AdherenceMetrics {
  calorieAdherence: number; // % of days within 10% of target
  proteinAdherence: number; // % of days hitting 90%+ of protein target
  loggingConsistency: number; // % of days with any food logged
  overallScore: number; // 0-100 composite score
  daysAnalyzed: number;
}

export interface DayPattern {
  day: string; // 'Monday', 'Tuesday', etc.
  avgCalories: number;
  avgProtein: number;
  adherenceRate: number;
  logCount: number;
}

export interface WeekdayVsWeekend {
  weekday: {
    avgCalories: number;
    avgProtein: number;
    adherenceRate: number;
  };
  weekend: {
    avgCalories: number;
    avgProtein: number;
    adherenceRate: number;
  };
  pattern: 'consistent' | 'weekday_better' | 'weekend_better';
}

export interface UserInsights {
  adherence: AdherenceMetrics;
  dayPatterns: DayPattern[];
  weekdayVsWeekend: WeekdayVsWeekend;
  adjustmentRate: number; // How often user corrects AI estimates
  mealConsistency: {
    breakfast: number; // % of days this meal logged
    lunch: number;
    dinner: number;
  };
  bestDay: string | null;
  worstDay: string | null;
  suggestions: string[];
}

// ============================================
// ADHERENCE METRICS
// ============================================

/**
 * Calculate adherence metrics for a user over a given period
 */
export async function getAdherenceMetrics(
  user: User,
  days: number = 30
): Promise<AdherenceMetrics> {
  const today = getTodayDate(user.timezone);
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - days);

  const dailyLogs = await prisma.dailyLog.findMany({
    where: {
      userId: user.id,
      date: {
        gte: startDate,
        lte: today,
      },
    },
  });

  if (dailyLogs.length === 0) {
    return {
      calorieAdherence: 0,
      proteinAdherence: 0,
      loggingConsistency: 0,
      overallScore: 0,
      daysAnalyzed: 0,
    };
  }

  const calorieTarget = user.calorieTarget || 2000;
  const proteinTarget = user.proteinTarget || 150;

  // Days within 10% of calorie target
  const daysHitCalories = dailyLogs.filter(log => {
    if (log.caloriesTotal === 0) return false;
    const deviation = Math.abs(log.caloriesTotal - calorieTarget) / calorieTarget;
    return deviation <= 0.1;
  }).length;

  // Days hitting 90%+ of protein
  const daysHitProtein = dailyLogs.filter(log => {
    return log.proteinTotal >= proteinTarget * 0.9;
  }).length;

  // Days with any food logged
  const daysLogged = dailyLogs.filter(log => log.caloriesTotal > 0).length;

  const calorieAdherence = Math.round((daysHitCalories / dailyLogs.length) * 100);
  const proteinAdherence = Math.round((daysHitProtein / dailyLogs.length) * 100);
  const loggingConsistency = Math.round((daysLogged / days) * 100);

  // Composite score: weighted average
  const overallScore = Math.round(
    (calorieAdherence * 0.35) + (proteinAdherence * 0.35) + (loggingConsistency * 0.3)
  );

  return {
    calorieAdherence,
    proteinAdherence,
    loggingConsistency,
    overallScore,
    daysAnalyzed: dailyLogs.length,
  };
}

// ============================================
// PATTERN RECOGNITION
// ============================================

/**
 * Analyze patterns by day of week
 */
export async function getDayPatterns(
  user: User,
  days: number = 30
): Promise<DayPattern[]> {
  const today = getTodayDate(user.timezone);
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - days);

  const dailyLogs = await prisma.dailyLog.findMany({
    where: {
      userId: user.id,
      date: {
        gte: startDate,
        lte: today,
      },
      caloriesTotal: { gt: 0 },
    },
  });

  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const calorieTarget = user.calorieTarget || 2000;

  const byDay: Record<number, { calories: number[]; protein: number[]; hitTarget: number }> = {};
  for (let i = 0; i < 7; i++) {
    byDay[i] = { calories: [], protein: [], hitTarget: 0 };
  }

  dailyLogs.forEach(log => {
    const dayOfWeek = log.date.getDay();
    byDay[dayOfWeek].calories.push(log.caloriesTotal);
    byDay[dayOfWeek].protein.push(log.proteinTotal);
    const deviation = Math.abs(log.caloriesTotal - calorieTarget) / calorieTarget;
    if (deviation <= 0.1) {
      byDay[dayOfWeek].hitTarget++;
    }
  });

  return dayNames.map((name, i) => {
    const data = byDay[i];
    const count = data.calories.length;
    return {
      day: name,
      avgCalories: count > 0 ? Math.round(data.calories.reduce((a, b) => a + b, 0) / count) : 0,
      avgProtein: count > 0 ? Math.round(data.protein.reduce((a, b) => a + b, 0) / count) : 0,
      adherenceRate: count > 0 ? Math.round((data.hitTarget / count) * 100) : 0,
      logCount: count,
    };
  });
}

/**
 * Compare weekday vs weekend performance
 */
export async function getWeekdayVsWeekend(
  user: User,
  days: number = 30
): Promise<WeekdayVsWeekend> {
  const patterns = await getDayPatterns(user, days);

  const weekdayPatterns = patterns.filter(p =>
    ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'].includes(p.day)
  );
  const weekendPatterns = patterns.filter(p =>
    ['Saturday', 'Sunday'].includes(p.day)
  );

  const avgWeekday = {
    avgCalories: weekdayPatterns.length > 0
      ? Math.round(weekdayPatterns.reduce((a, b) => a + b.avgCalories, 0) / weekdayPatterns.length)
      : 0,
    avgProtein: weekdayPatterns.length > 0
      ? Math.round(weekdayPatterns.reduce((a, b) => a + b.avgProtein, 0) / weekdayPatterns.length)
      : 0,
    adherenceRate: weekdayPatterns.length > 0
      ? Math.round(weekdayPatterns.reduce((a, b) => a + b.adherenceRate, 0) / weekdayPatterns.length)
      : 0,
  };

  const avgWeekend = {
    avgCalories: weekendPatterns.length > 0
      ? Math.round(weekendPatterns.reduce((a, b) => a + b.avgCalories, 0) / weekendPatterns.length)
      : 0,
    avgProtein: weekendPatterns.length > 0
      ? Math.round(weekendPatterns.reduce((a, b) => a + b.avgProtein, 0) / weekendPatterns.length)
      : 0,
    adherenceRate: weekendPatterns.length > 0
      ? Math.round(weekendPatterns.reduce((a, b) => a + b.adherenceRate, 0) / weekendPatterns.length)
      : 0,
  };

  let pattern: 'consistent' | 'weekday_better' | 'weekend_better';
  const diff = Math.abs(avgWeekday.adherenceRate - avgWeekend.adherenceRate);
  if (diff <= 10) {
    pattern = 'consistent';
  } else if (avgWeekday.adherenceRate > avgWeekend.adherenceRate) {
    pattern = 'weekday_better';
  } else {
    pattern = 'weekend_better';
  }

  return {
    weekday: avgWeekday,
    weekend: avgWeekend,
    pattern,
  };
}

// ============================================
// MEAL CONSISTENCY
// ============================================

/**
 * Calculate meal consistency (% of days each meal is logged)
 */
export async function getMealConsistency(
  user: User,
  days: number = 30
): Promise<{ breakfast: number; lunch: number; dinner: number }> {
  const today = getTodayDate(user.timezone);
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - days);

  const dailyLogs = await prisma.dailyLog.findMany({
    where: {
      userId: user.id,
      date: {
        gte: startDate,
        lte: today,
      },
    },
  });

  if (dailyLogs.length === 0) {
    return { breakfast: 0, lunch: 0, dinner: 0 };
  }

  const breakfastDays = dailyLogs.filter(log => log.breakfastLogged).length;
  const lunchDays = dailyLogs.filter(log => log.lunchLogged).length;
  const dinnerDays = dailyLogs.filter(log => log.dinnerLogged).length;

  return {
    breakfast: Math.round((breakfastDays / dailyLogs.length) * 100),
    lunch: Math.round((lunchDays / dailyLogs.length) * 100),
    dinner: Math.round((dinnerDays / dailyLogs.length) * 100),
  };
}

// ============================================
// ADJUSTMENT RATE
// ============================================

/**
 * Calculate how often the user corrects AI estimates
 */
export async function getAdjustmentRate(
  user: User,
  days: number = 30
): Promise<number> {
  const today = getTodayDate(user.timezone);
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - days);

  // Count total food entries
  const totalEntries = await prisma.foodEntry.count({
    where: {
      userId: user.id,
      loggedAt: {
        gte: startDate,
        lte: today,
      },
    },
  });

  if (totalEntries === 0) return 0;

  // Count entries that were adjusted (have wasAdjusted flag or show edit pattern)
  // For now, we'll check conversation context for correction intent
  const conversationContexts = await prisma.conversationContext.findMany({
    where: {
      userId: user.id,
      lastIntent: 'correction',
      lastMessageAt: {
        gte: startDate,
        lte: today,
      },
    },
  });

  // Approximate adjustment rate based on correction intents
  const adjustedCount = conversationContexts.length;
  return Math.round((adjustedCount / totalEntries) * 100);
}

// ============================================
// EXERCISE PROGRESSION
// ============================================

export interface ExerciseProgression {
  exerciseName: string;
  sessions: number;
  volumeTrend: 'increasing' | 'plateau' | 'declining' | 'insufficient_data';
  avgVolume: number;
  maxWeight: number;
  totalSets: number;
  weeklyFrequency: number;
}

export interface WorkoutAnalytics {
  totalWorkouts: number;
  weeklyAverage: number;
  exerciseProgressions: ExerciseProgression[];
  topExercises: string[];
  consistencyRate: number;
  volumeTrend: 'increasing' | 'plateau' | 'declining' | 'insufficient_data';
}

interface ExerciseSet {
  reps: number;
  weight: number;
}

interface Exercise {
  name: string;
  sets: ExerciseSet[];
}

/**
 * Analyze exercise progression over time
 */
export async function getExerciseProgression(
  user: User,
  days: number = 30
): Promise<WorkoutAnalytics> {
  const today = getTodayDate(user.timezone);
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - days);

  const workouts = await prisma.workoutEntry.findMany({
    where: {
      userId: user.id,
      loggedAt: {
        gte: startDate,
        lte: today,
      },
    },
    orderBy: { loggedAt: 'asc' },
  });

  if (workouts.length === 0) {
    return {
      totalWorkouts: 0,
      weeklyAverage: 0,
      exerciseProgressions: [],
      topExercises: [],
      consistencyRate: 0,
      volumeTrend: 'insufficient_data',
    };
  }

  // Calculate weekly average
  const weeks = days / 7;
  const weeklyAverage = Math.round((workouts.length / weeks) * 10) / 10;

  // Calculate consistency (% of weeks with target workouts)
  const targetPerWeek = user.weeklyWorkoutTarget || 3;
  const weeksWithTarget = Math.floor(workouts.length / targetPerWeek);
  const consistencyRate = Math.min(100, Math.round((weeksWithTarget / weeks) * 100));

  // Track exercise data
  const exerciseData: Record<string, {
    sessions: number;
    volumes: number[];
    maxWeight: number;
    totalSets: number;
    lastLoggedAt: Date;
  }> = {};

  // Track total volume over time (for overall trend)
  const weeklyVolumes: number[] = [];
  let currentWeekVolume = 0;
  let currentWeekStart = new Date(workouts[0]?.loggedAt || today);
  currentWeekStart.setDate(currentWeekStart.getDate() - currentWeekStart.getDay());

  for (const workout of workouts) {
    // Check if we've moved to a new week
    const workoutWeekStart = new Date(workout.loggedAt);
    workoutWeekStart.setDate(workoutWeekStart.getDate() - workoutWeekStart.getDay());

    if (workoutWeekStart.getTime() !== currentWeekStart.getTime()) {
      if (currentWeekVolume > 0) {
        weeklyVolumes.push(currentWeekVolume);
      }
      currentWeekVolume = 0;
      currentWeekStart = workoutWeekStart;
    }

    // Process exercises
    if (workout.exercises) {
      const exercises = workout.exercises as unknown as Exercise[];
      for (const exercise of exercises) {
        const name = exercise.name;
        if (!exerciseData[name]) {
          exerciseData[name] = {
            sessions: 0,
            volumes: [],
            maxWeight: 0,
            totalSets: 0,
            lastLoggedAt: workout.loggedAt,
          };
        }

        exerciseData[name].sessions++;
        exerciseData[name].lastLoggedAt = workout.loggedAt;

        let sessionVolume = 0;
        for (const set of exercise.sets) {
          sessionVolume += set.weight * set.reps;
          if (set.weight > exerciseData[name].maxWeight) {
            exerciseData[name].maxWeight = set.weight;
          }
          exerciseData[name].totalSets++;
        }
        exerciseData[name].volumes.push(sessionVolume);
        currentWeekVolume += sessionVolume;
      }
    }

    // Add cardio/other workout volume if tracked
    if (workout.totalVolume) {
      currentWeekVolume += workout.totalVolume;
    }
  }

  // Add final week
  if (currentWeekVolume > 0) {
    weeklyVolumes.push(currentWeekVolume);
  }

  // Calculate overall volume trend
  let volumeTrend: 'increasing' | 'plateau' | 'declining' | 'insufficient_data' = 'insufficient_data';
  if (weeklyVolumes.length >= 3) {
    const firstHalf = weeklyVolumes.slice(0, Math.floor(weeklyVolumes.length / 2));
    const secondHalf = weeklyVolumes.slice(Math.floor(weeklyVolumes.length / 2));
    const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
    const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;

    const changePercent = ((secondAvg - firstAvg) / firstAvg) * 100;
    if (changePercent > 10) {
      volumeTrend = 'increasing';
    } else if (changePercent < -10) {
      volumeTrend = 'declining';
    } else {
      volumeTrend = 'plateau';
    }
  }

  // Build exercise progressions
  const exerciseProgressions: ExerciseProgression[] = Object.entries(exerciseData)
    .map(([name, data]) => {
      let trend: 'increasing' | 'plateau' | 'declining' | 'insufficient_data' = 'insufficient_data';

      if (data.volumes.length >= 3) {
        const firstHalf = data.volumes.slice(0, Math.floor(data.volumes.length / 2));
        const secondHalf = data.volumes.slice(Math.floor(data.volumes.length / 2));
        const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
        const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;

        const changePercent = ((secondAvg - firstAvg) / firstAvg) * 100;
        if (changePercent > 10) {
          trend = 'increasing';
        } else if (changePercent < -10) {
          trend = 'declining';
        } else {
          trend = 'plateau';
        }
      }

      return {
        exerciseName: name,
        sessions: data.sessions,
        volumeTrend: trend,
        avgVolume: Math.round(data.volumes.reduce((a, b) => a + b, 0) / data.volumes.length),
        maxWeight: data.maxWeight,
        totalSets: data.totalSets,
        weeklyFrequency: Math.round((data.sessions / weeks) * 10) / 10,
      };
    })
    .sort((a, b) => b.sessions - a.sessions);

  // Top exercises by frequency
  const topExercises = exerciseProgressions.slice(0, 5).map(e => e.exerciseName);

  return {
    totalWorkouts: workouts.length,
    weeklyAverage,
    exerciseProgressions: exerciseProgressions.slice(0, 10), // Top 10
    topExercises,
    consistencyRate,
    volumeTrend,
  };
}

/**
 * Format exercise progression for SMS display
 */
export function formatExerciseProgressionForSMS(analytics: WorkoutAnalytics): string {
  if (analytics.totalWorkouts === 0) {
    return "No workouts logged this month.";
  }

  let message = `💪 Training Analytics (30 days)\n\n`;
  message += `Workouts: ${analytics.totalWorkouts} (${analytics.weeklyAverage}/week)\n`;
  message += `Consistency: ${analytics.consistencyRate}%\n`;

  if (analytics.volumeTrend !== 'insufficient_data') {
    const trendEmoji = analytics.volumeTrend === 'increasing' ? '📈' :
                       analytics.volumeTrend === 'declining' ? '📉' : '➡️';
    message += `Volume trend: ${trendEmoji} ${analytics.volumeTrend}\n`;
  }

  if (analytics.exerciseProgressions.length > 0) {
    message += `\nTop exercises:\n`;
    for (const exercise of analytics.exerciseProgressions.slice(0, 3)) {
      const trend = exercise.volumeTrend === 'increasing' ? '↑' :
                   exercise.volumeTrend === 'declining' ? '↓' : '→';
      message += `• ${exercise.exerciseName}: ${exercise.sessions}x, max ${exercise.maxWeight}lbs ${trend}\n`;
    }
  }

  return message;
}

// ============================================
// COMPREHENSIVE INSIGHTS
// ============================================

/**
 * Get comprehensive user insights for /progress command
 */
export async function getUserInsights(user: User, days: number = 30): Promise<UserInsights> {
  const [adherence, dayPatterns, weekdayVsWeekend, mealConsistency, adjustmentRate] =
    await Promise.all([
      getAdherenceMetrics(user, days),
      getDayPatterns(user, days),
      getWeekdayVsWeekend(user, days),
      getMealConsistency(user, days),
      getAdjustmentRate(user, days),
    ]);

  // Find best and worst days
  const loggedPatterns = dayPatterns.filter(p => p.logCount >= 2);
  let bestDay: string | null = null;
  let worstDay: string | null = null;

  if (loggedPatterns.length >= 2) {
    const sorted = [...loggedPatterns].sort((a, b) => b.adherenceRate - a.adherenceRate);
    bestDay = sorted[0].day;
    worstDay = sorted[sorted.length - 1].day;
  }

  // Generate suggestions based on data
  const suggestions = generateSuggestions({
    adherence,
    weekdayVsWeekend,
    mealConsistency,
    adjustmentRate,
    bestDay,
    worstDay,
  });

  return {
    adherence,
    dayPatterns,
    weekdayVsWeekend,
    adjustmentRate,
    mealConsistency,
    bestDay,
    worstDay,
    suggestions,
  };
}

/**
 * Generate personalized suggestions based on analytics
 */
function generateSuggestions(data: {
  adherence: AdherenceMetrics;
  weekdayVsWeekend: WeekdayVsWeekend;
  mealConsistency: { breakfast: number; lunch: number; dinner: number };
  adjustmentRate: number;
  bestDay: string | null;
  worstDay: string | null;
}): string[] {
  const suggestions: string[] = [];

  // Protein adherence suggestion
  if (data.adherence.proteinAdherence < 50) {
    suggestions.push("Your protein is low most days. Try adding a protein source to each meal.");
  }

  // Calorie adherence suggestion
  if (data.adherence.calorieAdherence < 50) {
    suggestions.push("You're hitting your calorie target less than half the time. Consider meal prepping or planning ahead.");
  }

  // Weekend pattern suggestion
  if (data.weekdayVsWeekend.pattern === 'weekday_better') {
    suggestions.push(`Weekends are your weak spot (${data.weekdayVsWeekend.weekend.adherenceRate}% vs ${data.weekdayVsWeekend.weekday.adherenceRate}% adherence). Try planning weekend meals in advance.`);
  }

  // Meal consistency suggestions
  if (data.mealConsistency.breakfast < 30) {
    suggestions.push("You rarely log breakfast. Skipping or just forgetting to log it?");
  }
  if (data.mealConsistency.dinner < 50) {
    suggestions.push("Dinner gets missed often. Try logging right after you eat while it's fresh.");
  }

  // Adjustment rate suggestion
  if (data.adjustmentRate > 30) {
    suggestions.push("You correct my estimates a lot. Try being more specific with portions (e.g., '6oz chicken' instead of 'chicken').");
  }

  // Best/worst day suggestion
  if (data.bestDay && data.worstDay && data.bestDay !== data.worstDay) {
    suggestions.push(`${data.bestDay}s are your best day. What's different? Try replicating that on ${data.worstDay}s.`);
  }

  // Limit to 3 suggestions
  return suggestions.slice(0, 3);
}

/**
 * Format insights for SMS display
 */
export function formatInsightsForSMS(insights: UserInsights): string {
  let message = `📊 Your Analytics (30 days)\n\n`;

  // Overall score
  message += `Overall Score: ${insights.adherence.overallScore}/100\n\n`;

  // Adherence breakdown
  message += `Adherence:\n`;
  message += `• Calorie target: ${insights.adherence.calorieAdherence}% of days\n`;
  message += `• Protein target: ${insights.adherence.proteinAdherence}% of days\n`;
  message += `• Logging rate: ${insights.adherence.loggingConsistency}% of days\n\n`;

  // Pattern insight
  if (insights.weekdayVsWeekend.pattern !== 'consistent') {
    const better = insights.weekdayVsWeekend.pattern === 'weekday_better' ? 'Weekdays' : 'Weekends';
    message += `Pattern: ${better} are stronger\n\n`;
  }

  // Suggestions
  if (insights.suggestions.length > 0) {
    message += `💡 Suggestions:\n`;
    insights.suggestions.forEach(s => {
      message += `• ${s}\n`;
    });
  }

  return message;
}
