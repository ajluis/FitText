import { User, PrimaryGoal, CoachingPersonality } from '@prisma/client';
import prisma from '../lib/db';
import anthropic, {
  CLAUDE_MODEL,
  MAX_TOKENS,
  callClaudeWithRetry,
  getUserFriendlyErrorMessage,
} from '../lib/claude';
import { sendSMS } from './sendblue';
import { getTodayDate, percentage } from '../lib/calculations';

// Goal display names
const GOAL_DISPLAY: Record<PrimaryGoal, string> = {
  fat_loss: 'fat loss',
  muscle_gain: 'building muscle',
  recomp: 'body recomposition',
  general_health: 'general health',
};

// Personality-specific prompts
const PERSONALITY_PROMPTS: Record<CoachingPersonality, { description: string; style: string }> = {
  motivator: {
    description: "You're an energetic, high-hype coach who celebrates everything. Think personal trainer energy.",
    style: "Use exclamation points! Celebrate every win big or small. High energy, lots of encouragement. 'You crushed it!' 'That's amazing!' 'Let's GO!' Energy is your superpower.",
  },
  educator: {
    description: "You're a knowledgeable coach who teaches the 'why' behind nutrition and fitness. Science-based but accessible.",
    style: "Explain the reasoning when giving advice. Reference basic nutrition science. 'Protein helps rebuild muscle fibers...' 'Your body stores excess calories as...' Educational but not preachy.",
  },
  coach: {
    description: "You're a professional, balanced coach. Data-focused but warm. Think supportive athletic coach.",
    style: "Direct and efficient. Focus on the numbers and progress. Acknowledge feelings but keep focus on actions. 'You're 80% to your protein goal. Solid.' Professional warmth.",
  },
  friend: {
    description: "You're a supportive friend who happens to know about fitness. Casual, relatable, no judgment.",
    style: "Super casual tone. 'lol no worries', 'honestly same', 'dude nice'. Like texting a friend. Emojis welcome. Validate feelings. Zero judgment ever.",
  },
};

/**
 * Format a date for display
 */
function formatDateForDisplay(date: Date, timezone: string): string {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // Adjust for timezone
  const localDate = new Date(date.toLocaleString('en-US', { timeZone: timezone }));

  return `${days[localDate.getDay()]}, ${months[localDate.getMonth()]} ${localDate.getDate()}`;
}

/**
 * Get detailed food history for the last N days
 */
async function getFoodHistory(user: User, days: number = 14): Promise<string> {
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
    include: {
      foodEntries: {
        orderBy: { loggedAt: 'asc' },
      },
    },
    orderBy: { date: 'desc' },
  });

  if (dailyLogs.length === 0) {
    return 'No food logged in the last 2 weeks.';
  }

  const lines: string[] = [];

  for (const log of dailyLogs) {
    const dateStr = formatDateForDisplay(log.date, user.timezone);
    const isToday = log.date.toDateString() === today.toDateString();

    if (log.foodEntries.length === 0) {
      lines.push(`${dateStr}${isToday ? ' (today)' : ''}: No food logged`);
      continue;
    }

    lines.push(`${dateStr}${isToday ? ' (today)' : ''}:`);

    // Group by meal type
    const mealTypes = ['breakfast', 'lunch', 'dinner', 'snack'] as const;
    for (const mealType of mealTypes) {
      const entries = log.foodEntries.filter(e => e.mealType === mealType);
      if (entries.length === 0) continue;

      const items: string[] = [];
      for (const entry of entries) {
        const foodItems = entry.foodItems as { name: string; quantity: string; calories: number; protein: number }[];
        for (const item of foodItems) {
          items.push(`${item.name} (${item.quantity})`);
        }
      }

      const mealLabel = mealType.charAt(0).toUpperCase() + mealType.slice(1);
      lines.push(`  ${mealLabel}: ${items.join(', ')}`);
    }

    lines.push(`  Total: ${log.caloriesTotal} cal, ${log.proteinTotal}g protein`);
  }

  return lines.join('\n');
}

/**
 * Build system prompt with user context
 */
async function buildSystemPrompt(user: User): Promise<string> {
  const today = getTodayDate(user.timezone);

  // Get current date/time in user's timezone
  const now = new Date();
  const userLocalTime = now.toLocaleString('en-US', {
    timeZone: user.timezone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  // Get today's log
  const dailyLog = await prisma.dailyLog.findUnique({
    where: {
      userId_date: {
        userId: user.id,
        date: today,
      },
    },
  });

  // Get food history (last 14 days with details)
  const foodHistory = await getFoodHistory(user, 14);

  // Get recent patterns (last 7 days)
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  const recentLogs = await prisma.dailyLog.findMany({
    where: {
      userId: user.id,
      date: {
        gte: sevenDaysAgo,
      },
    },
  });

  const workoutsThisWeek = await prisma.workoutEntry.count({
    where: {
      userId: user.id,
      loggedAt: {
        gte: sevenDaysAgo,
      },
    },
  });

  // Calculate averages
  const avgProtein = recentLogs.length > 0
    ? Math.round(recentLogs.reduce((sum, log) => sum + log.proteinTotal, 0) / recentLogs.length)
    : null;

  // Get weight trend
  const weightEntries = await prisma.weightEntry.findMany({
    where: { userId: user.id },
    orderBy: { date: 'desc' },
    take: 14,
  });

  let weightTrend = 'Unknown';
  if (weightEntries.length >= 2) {
    const recent = weightEntries.slice(0, 7).reduce((sum, e) => sum + e.weight, 0) / Math.min(7, weightEntries.length);
    const older = weightEntries.slice(7).reduce((sum, e) => sum + e.weight, 0) / Math.max(1, weightEntries.length - 7);
    const change = recent - older;
    if (Math.abs(change) < 0.3) {
      weightTrend = 'Stable';
    } else if (change < 0) {
      weightTrend = `Down ${Math.abs(change).toFixed(1)} lbs`;
    } else {
      weightTrend = `Up ${change.toFixed(1)} lbs`;
    }
  }

  // Build common patterns
  const patterns: string[] = [];
  if (avgProtein && user.proteinTarget && avgProtein < user.proteinTarget * 0.8) {
    patterns.push('Often under on protein');
  }

  const calorieTarget = user.calorieTarget || 2000;
  const avgCalories = recentLogs.length > 0
    ? recentLogs.reduce((sum, log) => sum + log.caloriesTotal, 0) / recentLogs.length
    : null;
  if (avgCalories && avgCalories > calorieTarget * 1.1) {
    patterns.push('Frequently over on calories');
  }

  // Get personality-specific instructions
  const personality = user.coachingPersonality || 'coach';
  const personalityPrompt = PERSONALITY_PROMPTS[personality];

  return `ROLE:
You are FitText, an SMS-based fitness and nutrition coach. ${personalityPrompt.description} Keep messages concise (SMS-friendly, under 300 chars when possible). Never shame or guilt — focus on progress, not perfection.

CURRENT DATE/TIME:
${userLocalTime} (${user.timezone})

COACHING STYLE:
${personalityPrompt.style}

USER CONTEXT:
- Goal: ${user.primaryGoal ? GOAL_DISPLAY[user.primaryGoal] : 'Not set'}
- Calorie target: ${user.calorieTarget || 'Not set'} cal
- Protein target: ${user.proteinTarget || 'Not set'}g
- Current weight: ${user.currentWeight || 'Not set'} lbs
${user.targetWeight ? `- Target weight: ${user.targetWeight} lbs` : ''}
${user.dietaryRestrictions.length > 0 ? `- Dietary restrictions: ${user.dietaryRestrictions.join(', ')}` : ''}
- Days logged: ${user.totalDaysLogged}
- Current streak: ${user.loggingStreakDays} days

TODAY'S LOG:
- Calories: ${dailyLog?.caloriesTotal || 0} / ${calorieTarget}
- Protein: ${dailyLog?.proteinTotal || 0}g / ${user.proteinTarget || 150}g
- Meals logged: ${dailyLog ? [dailyLog.breakfastLogged ? 'Breakfast ✓' : 'Breakfast ✗', dailyLog.lunchLogged ? 'Lunch ✓' : 'Lunch ✗', dailyLog.dinnerLogged ? 'Dinner ✓' : 'Dinner ✗'].join(', ') : 'None'}
- Workout: ${dailyLog?.workoutLogged ? 'Yes' : 'Not yet'}

FOOD HISTORY (Last 14 Days):
${foodHistory}

RECENT PATTERNS:
- Avg protein last 7 days: ${avgProtein || 'N/A'}g (target: ${user.proteinTarget || 150}g)
- Workouts this week: ${workoutsThisWeek} / ${user.weeklyWorkoutTarget}
- Weight trend: ${weightTrend}
${patterns.length > 0 ? `- Observed patterns: ${patterns.join(', ')}` : ''}

INSTRUCTIONS:
- Keep responses under 300 characters when possible
- Match the user's energy — if they're brief, be brief
- Celebrate wins, contextualize setbacks
- When correcting or suggesting, be constructive not critical
- If user seems frustrated or struggling, acknowledge and offer support
- Don't over-explain unless asked
- Use emoji sparingly (1-2 per message max)
- NEVER recommend specific supplements, medications, or medical advice
- For medical questions, recommend consulting a healthcare provider
- When user asks about food history (e.g., "what did I eat last Thursday"), reference the FOOD HISTORY section above`;
}

/**
 * Handle a freeform question from the user
 */
export async function handleQuestion(
  user: User,
  question: string
): Promise<void> {
  const systemPrompt = await buildSystemPrompt(user);

  const result = await callClaudeWithRetry(
    () =>
      anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: MAX_TOKENS.question,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: question,
          },
        ],
      }),
    { label: 'Coaching question' }
  );

  if (!result.success) {
    await sendSMS(user.phone, getUserFriendlyErrorMessage(result.error!));
    return;
  }

  const text = result.data!.content[0].type === 'text' ? result.data!.content[0].text : '';
  if (text) {
    await sendSMS(user.phone, text);
  } else {
    await sendSMS(user.phone, "I'm not sure how to answer that. Can you rephrase?");
  }
}

/**
 * Handle a greeting
 */
export async function handleGreeting(user: User): Promise<void> {
  const today = getTodayDate(user.timezone);
  const dailyLog = await prisma.dailyLog.findUnique({
    where: {
      userId_date: {
        userId: user.id,
        date: today,
      },
    },
  });

  const hour = new Date().getHours();
  let timeGreeting = 'Hey';
  if (hour < 12) timeGreeting = 'Good morning';
  else if (hour < 17) timeGreeting = 'Good afternoon';
  else timeGreeting = 'Good evening';

  let message = `${timeGreeting}! 👋`;

  if (!dailyLog || dailyLog.caloriesTotal === 0) {
    message += ` Ready to log some food?`;
  } else {
    const calorieTarget = user.calorieTarget || 2000;
    const remaining = calorieTarget - dailyLog.caloriesTotal;
    if (remaining > 500) {
      message += ` You've logged ${dailyLog.caloriesTotal} cal so far. What's next?`;
    } else if (remaining > 0) {
      message += ` You're at ${dailyLog.caloriesTotal} cal — almost there for the day!`;
    } else {
      message += ` You've hit your calorie target for today.`;
    }
  }

  await sendSMS(user.phone, message);
}

/**
 * Detect setback phrases in a message
 */
function detectSetback(message: string): 'emotional_setback' | 'mild_setback' | null {
  const lower = message.toLowerCase();

  // Emotional setback phrases (need empathetic response)
  const emotionalPhrases = [
    'fell off',
    'gave up',
    'failed',
    'binge',
    'binged',
    'binging',
    'ate everything',
    'ruined',
    'blew it',
    'hate myself',
    'feel terrible',
    'feel awful',
    'so frustrated',
    'can\'t do this',
    'giving up',
    'what\'s the point',
    'stressed eating',
    'emotional eating',
  ];

  for (const phrase of emotionalPhrases) {
    if (lower.includes(phrase)) {
      return 'emotional_setback';
    }
  }

  // Mild setback phrases (acknowledgment + encouragement)
  const mildPhrases = [
    'messed up',
    'screwed up',
    'went overboard',
    'overdid it',
    'had a bad day',
    'cheated',
    'cheat day',
    'didn\'t log',
    'forgot to log',
    'skipped',
    'fell behind',
    'slipped',
  ];

  for (const phrase of mildPhrases) {
    if (lower.includes(phrase)) {
      return 'mild_setback';
    }
  }

  return null;
}

/**
 * Get empathetic response for setback
 */
function getSetbackResponse(type: 'emotional_setback' | 'mild_setback'): string {
  if (type === 'emotional_setback') {
    const responses = [
      "That happens. Rest days (even unplanned ones) are part of the process. What triggered it?",
      "Hey, it's okay. One day doesn't undo all your progress. Want to talk about what's going on?",
      "I hear you. Setbacks are human. The fact that you're reaching out shows you're still in this. What happened?",
      "No judgment here. Everyone has these moments. What's on your mind?",
    ];
    return responses[Math.floor(Math.random() * responses.length)];
  } else {
    const responses = [
      "That's okay — one day doesn't define your journey. What would help you get back on track?",
      "Everyone has those days. What matters is you're here now. Ready to keep going?",
      "No stress. Let's just focus on the next meal. What sounds good?",
    ];
    return responses[Math.floor(Math.random() * responses.length)];
  }
}

/**
 * Handle freeform messages (venting, thanks, etc.)
 */
export async function handleFreeform(
  user: User,
  message: string
): Promise<void> {
  const lower = message.toLowerCase();

  // Check for setback phrases first
  const setbackType = detectSetback(message);
  if (setbackType) {
    await sendSMS(user.phone, getSetbackResponse(setbackType));
    return;
  }

  // Quick responses for common phrases
  if (lower.includes('thank') || lower === 'thanks' || lower === 'ty') {
    await sendSMS(user.phone, "You're welcome! I'm here whenever you need me. 💪");
    return;
  }

  if (lower.includes('sorry') || lower.includes('my bad')) {
    await sendSMS(user.phone, "No need to apologize! We're all human. What matters is getting back on track. Ready when you are.");
    return;
  }

  // For anything else, use the coaching AI
  const systemPrompt = await buildSystemPrompt(user);

  const result = await callClaudeWithRetry(
    () =>
      anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: MAX_TOKENS.coaching,
        system: systemPrompt + `\n\nThe user is sharing something casually. Respond warmly and briefly. If they seem to be venting or struggling, acknowledge their feelings.`,
        messages: [
          {
            role: 'user',
            content: message,
          },
        ],
      }),
    { label: 'Freeform coaching' }
  );

  if (!result.success) {
    // For freeform, use a softer fallback message
    await sendSMS(user.phone, "I hear you! Let me know if there's anything I can help with.");
    return;
  }

  const text = result.data!.content[0].type === 'text' ? result.data!.content[0].text : '';
  if (text) {
    await sendSMS(user.phone, text);
  } else {
    await sendSMS(user.phone, "I hear you! Let me know if there's anything I can help with.");
  }
}

/**
 * Generate contextual feedback for food logging
 */
export async function generateFoodFeedback(
  user: User,
  loggedCalories: number,
  loggedProtein: number,
  dailyTotalCalories: number,
  dailyTotalProtein: number
): Promise<string | null> {
  const calorieTarget = user.calorieTarget || 2000;
  const proteinTarget = user.proteinTarget || 150;

  const caloriesRemaining = calorieTarget - dailyTotalCalories;
  const proteinRemaining = proteinTarget - dailyTotalProtein;

  // Generate contextual tip based on situation
  if (caloriesRemaining < 200 && proteinRemaining > 30) {
    return `Tip: Low on calories but need ${proteinRemaining}g protein. Try Greek yogurt, cottage cheese, or a protein shake.`;
  }

  if (dailyTotalProtein >= proteinTarget && dailyTotalCalories <= calorieTarget) {
    return `Nice! You've hit your protein target. 💪`;
  }

  // Only add tips occasionally, not every log
  return null;
}

/**
 * Generate goal-specific feedback
 */
export function getGoalSpecificFeedback(
  user: User,
  scenario: 'over_calories' | 'under_calories' | 'under_protein' | 'missed_workout' | 'weight_up' | 'weight_down'
): string {
  const goal = user.primaryGoal || 'general_health';

  const feedback: Record<PrimaryGoal, Record<string, string>> = {
    fat_loss: {
      over_calories: "Calories ran high today. It happens! Focus on hitting protein tomorrow and staying active.",
      under_calories: "Great calorie control! Just make sure you're not going too low — sustainability matters.",
      under_protein: "Protein was light today. This can lead to hunger and cravings. Prioritize it tomorrow.",
      missed_workout: "Rest days are fine! Try to move a bit — even a walk helps.",
      weight_up: "Weight fluctuates daily. Trust the process and focus on consistency.",
      weight_down: "Progress! Keep doing what you're doing. 📉",
    },
    muscle_gain: {
      over_calories: "Extra calories can fuel muscle growth, especially if you hit protein. Nice!",
      under_calories: "You might need more fuel for your gains. Don't leave calories on the table.",
      under_protein: "Protein is crucial for muscle building. Try to hit your target consistently.",
      missed_workout: "Rest is important, but consistency is key for gains. Get back at it!",
      weight_up: "Weight going up with training is good! That's progress. 📈",
      weight_down: "Losing weight while trying to build? Make sure you're eating enough.",
    },
    recomp: {
      over_calories: "A bit over isn't bad if protein was high. Body recomp is about the long game.",
      under_calories: "Watch the deficit — recomp works best around maintenance calories.",
      under_protein: "Protein is extra important for recomp. It protects muscle while losing fat.",
      missed_workout: "Training drives recomp. Make it a priority when you can.",
      weight_up: "Weight can fluctuate during recomp. Focus on how you look and feel.",
      weight_down: "Nice! Just make sure you're keeping strength up in the gym.",
    },
    general_health: {
      over_calories: "A bit over today — no big deal. Balance it out over the week.",
      under_calories: "Light day! Listen to your body. Eat when you're hungry.",
      under_protein: "Protein helps with energy and satiety. Try to include some at each meal.",
      missed_workout: "Movement is great for health, but rest days matter too.",
      weight_up: "Normal fluctuation. Focus on how you feel!",
      weight_down: "Body changing! Keep up the healthy habits.",
    },
  };

  return feedback[goal][scenario] || "Keep going — you're doing great!";
}
