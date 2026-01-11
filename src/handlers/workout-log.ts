import { User, WorkoutType, Prisma } from '@prisma/client';
import prisma from '../lib/db';
import anthropic, { CLAUDE_MODEL, MAX_TOKENS } from '../lib/claude';
import { sendSMS } from '../services/sendblue';
import { getTodayDate } from '../lib/calculations';

// Types
export interface ExerciseSet {
  reps: number;
  weight: number;
}

export interface Exercise {
  name: string;
  sets: ExerciseSet[];
}

export interface ParsedWorkout {
  workoutType: WorkoutType;
  durationMinutes?: number;
  // Cardio
  cardioType?: string;
  distance?: number;
  distanceUnit?: 'miles' | 'km';
  pace?: string;
  // Strength
  exercises?: Exercise[];
  simpleDescription?: string;
  // Calculated
  totalVolume?: number;
  estimatedCaloriesBurned?: number;
}

// Common exercise name mappings
const EXERCISE_ALIASES: Record<string, string> = {
  'bench': 'Bench Press',
  'bench press': 'Bench Press',
  'bb bench': 'Bench Press',
  'barbell bench': 'Bench Press',
  'flat bench': 'Bench Press',
  'incline bench': 'Incline Bench Press',
  'incline': 'Incline Bench Press',
  'decline bench': 'Decline Bench Press',
  'squat': 'Squat',
  'squats': 'Squat',
  'back squat': 'Squat',
  'bb squat': 'Squat',
  'front squat': 'Front Squat',
  'deadlift': 'Deadlift',
  'deadlifts': 'Deadlift',
  'dl': 'Deadlift',
  'deads': 'Deadlift',
  'rdl': 'Romanian Deadlift',
  'rdls': 'Romanian Deadlift',
  'romanian deadlift': 'Romanian Deadlift',
  'ohp': 'Overhead Press',
  'overhead press': 'Overhead Press',
  'shoulder press': 'Overhead Press',
  'military press': 'Overhead Press',
  'rows': 'Barbell Row',
  'row': 'Barbell Row',
  'barbell row': 'Barbell Row',
  'barbell rows': 'Barbell Row',
  'bb rows': 'Barbell Row',
  'bent over rows': 'Barbell Row',
  'pullups': 'Pull-ups',
  'pull ups': 'Pull-ups',
  'pull-ups': 'Pull-ups',
  'chinups': 'Chin-ups',
  'chin ups': 'Chin-ups',
  'chin-ups': 'Chin-ups',
  'dips': 'Dips',
  'curls': 'Bicep Curls',
  'bicep curls': 'Bicep Curls',
  'hammer curls': 'Hammer Curls',
  'tricep pushdown': 'Tricep Pushdown',
  'tricep pushdowns': 'Tricep Pushdown',
  'lat pulldown': 'Lat Pulldown',
  'lat pulldowns': 'Lat Pulldown',
  'leg press': 'Leg Press',
  'leg curl': 'Leg Curl',
  'leg curls': 'Leg Curl',
  'leg extension': 'Leg Extension',
  'leg extensions': 'Leg Extension',
  'calf raises': 'Calf Raises',
  'calf raise': 'Calf Raises',
  'lunges': 'Lunges',
  'hip thrust': 'Hip Thrust',
  'hip thrusts': 'Hip Thrust',
};

/**
 * Normalize exercise name
 */
function normalizeExerciseName(name: string): string {
  const lower = name.toLowerCase().trim();
  return EXERCISE_ALIASES[lower] || name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Parse set/rep/weight patterns
 * Examples: "135x10", "3x10 at 135", "135 3x10", "10, 8, 6 at 135"
 */
function parseSetReps(input: string): ExerciseSet[] | null {
  const sets: ExerciseSet[] = [];
  const cleaned = input.toLowerCase().trim();

  // Pattern: 135x10 or 135 x 10
  const simpleMatch = cleaned.match(/(\d+)\s*x\s*(\d+)/g);
  if (simpleMatch && simpleMatch.length === 1) {
    const match = cleaned.match(/(\d+)\s*x\s*(\d+)/);
    if (match) {
      const weight = parseInt(match[1], 10);
      const reps = parseInt(match[2], 10);
      // If weight > reps, it's weight x reps; else it's sets x reps (need weight separately)
      if (weight > reps) {
        return [{ weight, reps }];
      }
    }
  }

  // Pattern: 3x10 at 135 or 3x10 @ 135 or 135 3x10
  const setsRepsWeightMatch = cleaned.match(/(\d+)\s*x\s*(\d+)\s*(?:at|@)\s*(\d+)/);
  if (setsRepsWeightMatch) {
    const numSets = parseInt(setsRepsWeightMatch[1], 10);
    const reps = parseInt(setsRepsWeightMatch[2], 10);
    const weight = parseInt(setsRepsWeightMatch[3], 10);
    for (let i = 0; i < numSets; i++) {
      sets.push({ reps, weight });
    }
    return sets;
  }

  // Pattern: 135 3x10
  const weightSetsRepsMatch = cleaned.match(/(\d+)\s+(\d+)\s*x\s*(\d+)/);
  if (weightSetsRepsMatch) {
    const weight = parseInt(weightSetsRepsMatch[1], 10);
    const numSets = parseInt(weightSetsRepsMatch[2], 10);
    const reps = parseInt(weightSetsRepsMatch[3], 10);
    for (let i = 0; i < numSets; i++) {
      sets.push({ reps, weight });
    }
    return sets;
  }

  // Pattern: Multiple sets like "135x10, 155x8, 175x6"
  const multipleMatch = cleaned.match(/(\d+)\s*x\s*(\d+)/g);
  if (multipleMatch && multipleMatch.length > 1) {
    for (const m of multipleMatch) {
      const parts = m.match(/(\d+)\s*x\s*(\d+)/);
      if (parts) {
        sets.push({ weight: parseInt(parts[1], 10), reps: parseInt(parts[2], 10) });
      }
    }
    return sets;
  }

  // Pattern: "10, 8, 6 at 135" or "10/8/6 at 135"
  const repsListMatch = cleaned.match(/(\d+(?:\s*[,\/]\s*\d+)+)\s*(?:at|@)\s*(\d+)/);
  if (repsListMatch) {
    const repsList = repsListMatch[1].split(/[,\/]/).map(r => parseInt(r.trim(), 10));
    const weight = parseInt(repsListMatch[2], 10);
    for (const reps of repsList) {
      sets.push({ reps, weight });
    }
    return sets;
  }

  return null;
}

/**
 * Calculate total volume from exercises
 */
function calculateTotalVolume(exercises: Exercise[]): number {
  return exercises.reduce((total, exercise) => {
    return total + exercise.sets.reduce((exTotal, set) => {
      return exTotal + (set.reps * set.weight);
    }, 0);
  }, 0);
}

/**
 * Parse workout from text using LLM
 */
async function parseWorkoutFromText(description: string): Promise<ParsedWorkout> {
  const systemPrompt = `You are a workout parser for a fitness tracking app. Parse the user's workout description.

Determine:
1. Workout type: "strength", "cardio", "mixed", or "other"
2. Duration in minutes (if mentioned)
3. For cardio: type (running, cycling, etc.), distance, pace
4. For strength: exercises with sets/reps/weight if provided

Common patterns:
- "Bench 135x10" = Bench Press, 1 set of 10 reps at 135 lbs
- "Squat 225 3x5" = Squat, 3 sets of 5 reps at 225 lbs
- "Ran 3 miles in 28 mins" = Running, 3 miles, calculate pace

Return JSON only:
{
  "workoutType": "strength" | "cardio" | "mixed" | "other",
  "durationMinutes": number | null,
  "cardioType": string | null,
  "distance": number | null,
  "distanceUnit": "miles" | "km" | null,
  "exercises": [
    { "name": "Exercise Name", "sets": [{ "reps": 10, "weight": 135 }] }
  ] | null,
  "simpleDescription": "Brief description if no specific exercises parsed"
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
        exercises: parsed.exercises,
        simpleDescription: parsed.simpleDescription,
      };

      // Calculate total volume if we have exercises
      if (workout.exercises && workout.exercises.length > 0) {
        workout.totalVolume = calculateTotalVolume(workout.exercises);
      }

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
  } else if (workout.exercises && workout.exercises.length > 0) {
    // Detailed strength workout
    message = `💪 Logged:\n`;
    for (const exercise of workout.exercises) {
      const setsStr = exercise.sets.map(s => `${s.weight}×${s.reps}`).join(', ');
      message += `• ${exercise.name}: ${setsStr}\n`;
    }
    if (workout.totalVolume) {
      message += `\nTotal volume: ${workout.totalVolume.toLocaleString()} lbs`;
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
 * Check for PR (personal record)
 */
async function checkForPR(
  user: User,
  exerciseName: string,
  sets: ExerciseSet[]
): Promise<{ isPR: boolean; previousBest?: string } | null> {
  // Get the best set from current workout
  const currentBest = sets.reduce((best, set) => {
    const score = set.weight * set.reps;
    const bestScore = best.weight * best.reps;
    return score > bestScore ? set : best;
  }, sets[0]);

  // Look for previous entries with this exercise
  // Note: JSON path queries vary by database, so we'll fetch and filter in memory
  const previousEntries = await prisma.workoutEntry.findMany({
    where: {
      userId: user.id,
      exercises: { not: Prisma.DbNull },
    },
    orderBy: { loggedAt: 'desc' },
    take: 50,
  });

  if (previousEntries.length === 0) {
    return null; // First time doing this exercise
  }

  // Find previous best
  let previousBestSet: ExerciseSet | null = null;
  let previousBestScore = 0;

  for (const entry of previousEntries) {
    const exercises = entry.exercises as Exercise[] | null;
    if (!exercises) continue;

    for (const exercise of exercises) {
      if (exercise.name.toLowerCase() === exerciseName.toLowerCase()) {
        for (const set of exercise.sets) {
          const score = set.weight * set.reps;
          if (score > previousBestScore) {
            previousBestScore = score;
            previousBestSet = set;
          }
        }
      }
    }
  }

  if (!previousBestSet) return null;

  const currentScore = currentBest.weight * currentBest.reps;
  if (currentScore > previousBestScore) {
    return {
      isPR: true,
      previousBest: `${previousBestSet.weight}×${previousBestSet.reps}`,
    };
  }

  return { isPR: false };
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
      exercises: parsed.exercises ? JSON.parse(JSON.stringify(parsed.exercises)) : undefined,
      simpleDescription: parsed.simpleDescription,
      totalVolume: parsed.totalVolume,
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
  let response = formatWorkoutResponse(parsed, weeklyCount, user.weeklyWorkoutTarget);

  // Check for PRs
  if (parsed.exercises && parsed.exercises.length > 0) {
    for (const exercise of parsed.exercises) {
      const prCheck = await checkForPR(user, exercise.name, exercise.sets);
      if (prCheck?.isPR) {
        const bestSet = exercise.sets.reduce((a, b) =>
          a.weight * a.reps > b.weight * b.reps ? a : b
        );
        response += `\n\n${exercise.name}: ${bestSet.weight}×${bestSet.reps} — that's a PR! 🎉`;
        if (prCheck.previousBest) {
          response += ` (up from ${prCheck.previousBest})`;
        }
      }
    }
  }

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

  let totalVolume = 0;

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
    } else if (workout.exercises) {
      const exercises = workout.exercises as unknown as Exercise[];
      desc = exercises.map(e => e.name).slice(0, 2).join(', ');
      if (exercises.length > 2) desc += '...';
    } else {
      desc = workout.workoutType;
    }

    if (workout.durationMinutes) {
      desc += ` (${workout.durationMinutes} min)`;
    }

    message += `${day}: ${desc}\n`;

    if (workout.totalVolume) {
      totalVolume += workout.totalVolume;
    }
  }

  message += `\n${workouts.length}/${user.weeklyWorkoutTarget} workouts`;
  if (workouts.length >= user.weeklyWorkoutTarget) {
    message += ' ✓';
  }

  if (totalVolume > 0) {
    message += `\nTotal volume: ${totalVolume.toLocaleString()} lbs`;
  }

  return message;
}
