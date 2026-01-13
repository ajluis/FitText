import { User, WorkoutType } from '@prisma/client';
import prisma from '../lib/db';
import anthropic, { CLAUDE_MODEL, MAX_TOKENS } from '../lib/claude';
import { sendSMS } from '../services/sendblue';
import { getTodayDate } from '../lib/calculations';

// Types
export interface ParsedWorkout {
  workoutType: WorkoutType;
  durationMinutes?: number;
  // Cardio
  cardioType?: string;
  distance?: number;
  distanceUnit?: 'miles' | 'km';
  pace?: string;
  // Simple description of workout
  simpleDescription?: string;
  estimatedCaloriesBurned?: number;
}

/**
 * Parse workout from text using LLM
 */
async function parseWorkoutFromText(description: string): Promise<ParsedWorkout> {
  const systemPrompt = `You are a workout parser for a fitness tracking app. Parse the user's workout description.

Determine:
1. Workout type: "strength", "cardio", "mixed", or "other"
2. Duration in minutes (if mentioned)
3. For cardio: type (running, cycling, etc.), distance
4. A simple description of the workout

Return JSON only:
{
  "workoutType": "strength" | "cardio" | "mixed" | "other",
  "durationMinutes": number | null,
  "cardioType": string | null,
  "distance": number | null,
  "distanceUnit": "miles" | "km" | null,
  "simpleDescription": "Brief description of the workout"
}`;

  try {
    const response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: MAX_TOKENS.workoutParsing,
      system: systemPrompt,
      messages: [{ role: 'user', content: description }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);

    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const workout: ParsedWorkout = {
        workoutType: parsed.workoutType || 'other',
        durationMinutes: parsed.durationMinutes,
        cardioType: parsed.cardioType,
        distance: parsed.distance,
        distanceUnit: parsed.distanceUnit,
        simpleDescription: parsed.simpleDescription || description,
      };

      // Calculate pace for cardio
      if (workout.cardioType && workout.distance && workout.durationMinutes) {
        const paceMinutes = workout.durationMinutes / workout.distance;
        const paceMins = Math.floor(paceMinutes);
        const paceSecs = Math.round((paceMinutes - paceMins) * 60);
        workout.pace = `${paceMins}:${paceSecs.toString().padStart(2, '0')}/${workout.distanceUnit || 'mile'}`;
      }

      return workout;
    }
  } catch (error) {
    console.error('Workout parsing error:', error);
  }

  // Fallback - try basic detection
  const lower = description.toLowerCase();
  if (lower.includes('ran') || lower.includes('run') || lower.includes('mile') || lower.includes('cardio')) {
    return {
      workoutType: 'cardio',
      simpleDescription: description,
    };
  }

  return {
    workoutType: 'strength',
    simpleDescription: description,
  };
}

/**
 * Get or create today's daily log
 */
async function getOrCreateDailyLog(user: User) {
  const today = getTodayDate(user.timezone);

  let dailyLog = await prisma.dailyLog.findUnique({
    where: {
      userId_date: {
        userId: user.id,
        date: today,
      },
    },
  });

  if (!dailyLog) {
    dailyLog = await prisma.dailyLog.create({
      data: {
        userId: user.id,
        date: today,
        calorieTarget: user.calorieTarget,
        proteinTarget: user.proteinTarget,
      },
    });
  }

  return dailyLog;
}

/**
 * Format workout for response
 */
function formatWorkoutResponse(workout: ParsedWorkout, weeklyCount: number, weeklyTarget: number): string {
  let message = '';

  if (workout.cardioType) {
    // Cardio workout
    message = `Nice ${workout.cardioType}! `;
    if (workout.distance && workout.durationMinutes) {
      const mins = Math.floor(workout.durationMinutes);
      const secs = Math.round((workout.durationMinutes - mins) * 60);
      message += `Logged: ${workout.distance} ${workout.distanceUnit || 'miles'} in ${mins}:${secs.toString().padStart(2, '0')}`;
      if (workout.pace) {
        message += ` (${workout.pace} pace)`;
      }
    } else if (workout.distance) {
      message += `Logged: ${workout.distance} ${workout.distanceUnit || 'miles'}`;
    } else if (workout.durationMinutes) {
      message += `Logged: ${workout.durationMinutes} minutes`;
    }
  } else {
    // Simple workout
    message = `Logged: ${workout.simpleDescription || workout.workoutType} workout`;
    if (workout.durationMinutes) {
      message += ` (${workout.durationMinutes} min)`;
    }
  }

  message += `\n\nThis week: ${weeklyCount}/${weeklyTarget} workouts`;
  if (weeklyCount >= weeklyTarget) {
    message += ' ✓';
  }

  return message;
}

/**
 * Get weekly workout count
 */
async function getWeeklyWorkoutCount(user: User): Promise<number> {
  const today = getTodayDate(user.timezone);
  const dayOfWeek = today.getDay(); // 0 = Sunday
  const startOfWeek = new Date(today);
  startOfWeek.setDate(today.getDate() - dayOfWeek);

  const count = await prisma.workoutEntry.count({
    where: {
      userId: user.id,
      loggedAt: {
        gte: startOfWeek,
      },
    },
  });

  return count;
}

/**
 * Handle workout logging
 */
export async function handleWorkoutLog(
  user: User,
  message: string
): Promise<void> {
  // Parse the workout
  const parsed = await parseWorkoutFromText(message);

  // Get daily log
  const dailyLog = await getOrCreateDailyLog(user);

  // Create workout entry
  await prisma.workoutEntry.create({
    data: {
      userId: user.id,
      dailyLogId: dailyLog.id,
      workoutType: parsed.workoutType,
      durationMinutes: parsed.durationMinutes,
      cardioType: parsed.cardioType,
      distance: parsed.distance,
      distanceUnit: parsed.distanceUnit,
      simpleDescription: parsed.simpleDescription,
      estimatedCaloriesBurned: parsed.estimatedCaloriesBurned,
    },
  });

  // Update daily log
  await prisma.dailyLog.update({
    where: { id: dailyLog.id },
    data: {
      workoutLogged: true,
      workoutDurationMinutes: parsed.durationMinutes,
    },
  });

  // Get weekly count
  const weeklyCount = await getWeeklyWorkoutCount(user);

  // Format response
  const response = formatWorkoutResponse(parsed, weeklyCount, user.weeklyWorkoutTarget);

  await sendSMS(user.phone, response);
}

/**
 * Get weekly workout summary
 */
export async function getWeeklyWorkoutSummary(user: User): Promise<string> {
  const today = getTodayDate(user.timezone);
  const dayOfWeek = today.getDay();
  const startOfWeek = new Date(today);
  startOfWeek.setDate(today.getDate() - dayOfWeek);

  const workouts = await prisma.workoutEntry.findMany({
    where: {
      userId: user.id,
      loggedAt: {
        gte: startOfWeek,
      },
    },
    orderBy: { loggedAt: 'asc' },
  });

  if (workouts.length === 0) {
    return `This week's training: No workouts logged yet.\n\nTarget: ${user.weeklyWorkoutTarget} workouts`;
  }

  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  let message = "This week's training:\n";

  for (const workout of workouts) {
    const day = days[workout.loggedAt.getDay()];
    let desc = '';

    if (workout.cardioType) {
      desc = workout.cardioType;
      if (workout.distance) {
        desc += ` ${workout.distance} ${workout.distanceUnit || 'mi'}`;
      }
    } else if (workout.simpleDescription) {
      desc = workout.simpleDescription;
    } else {
      desc = workout.workoutType;
    }

    if (workout.durationMinutes) {
      desc += ` (${workout.durationMinutes} min)`;
    }

    message += `${day}: ${desc}\n`;
  }

  message += `\n${workouts.length}/${user.weeklyWorkoutTarget} workouts`;
  if (workouts.length >= user.weeklyWorkoutTarget) {
    message += ' ✓';
  }

  return message;
}
