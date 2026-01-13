/**
 * LLM-powered natural language settings changes
 *
 * Allows users to change settings through conversational messages
 * instead of navigating menus.
 */
import { User, PrimaryGoal, ActivityLevel, WeekDay, AccountabilityLevel, CoachingPersonality } from '@prisma/client';
import prisma from '../lib/db';
import anthropic, { CLAUDE_MODEL, callClaudeWithRetry } from '../lib/claude';
import { parseAndValidate } from '../lib/schemas';
import { calculateTargets } from '../lib/calculations';
import { z } from 'zod';

// Schema for parsed settings change
const SettingsChangeSchema = z.object({
  setting: z.enum([
    'timezone',
    'calorie_target',
    'protein_target',
    'primary_goal',
    'activity_level',
    'accountability_level',
    'coaching_personality',
    'weekly_workout_target',
    'target_weight',
    'breakfast_time',
    'lunch_time',
    'dinner_time',
    'summary_time',
    'weigh_in_day',
    'hydration_reminders',
    'pause_reminders',
    'resume_reminders',
    'breakfast_reminder_enabled',
    'lunch_reminder_enabled',
    'dinner_reminder_enabled',
    'single_reminder',
  ]),
  value: z.string(),
  confidence: z.enum(['high', 'medium', 'low']),
});

type SettingsChange = z.infer<typeof SettingsChangeSchema>;

// Timezone aliases
const TIMEZONE_ALIASES: Record<string, string> = {
  'eastern': 'America/New_York',
  'et': 'America/New_York',
  'est': 'America/New_York',
  'edt': 'America/New_York',
  'central': 'America/Chicago',
  'ct': 'America/Chicago',
  'cst': 'America/Chicago',
  'mountain': 'America/Denver',
  'mt': 'America/Denver',
  'mst': 'America/Denver',
  'pacific': 'America/Los_Angeles',
  'pt': 'America/Los_Angeles',
  'pst': 'America/Los_Angeles',
  'utc': 'UTC',
  'gmt': 'UTC',
  'uk': 'Europe/London',
  'london': 'Europe/London',
  'tokyo': 'Asia/Tokyo',
  'japan': 'Asia/Tokyo',
  'jst': 'Asia/Tokyo',
  'sydney': 'Australia/Sydney',
  'singapore': 'Asia/Singapore',
  'hong kong': 'Asia/Hong_Kong',
  'india': 'Asia/Kolkata',
  'dubai': 'Asia/Dubai',
};

const GOAL_MAP: Record<string, PrimaryGoal> = {
  'fat_loss': 'fat_loss',
  'fat loss': 'fat_loss',
  'lose weight': 'fat_loss',
  'lose fat': 'fat_loss',
  'cut': 'fat_loss',
  'cutting': 'fat_loss',
  'muscle_gain': 'muscle_gain',
  'muscle gain': 'muscle_gain',
  'build muscle': 'muscle_gain',
  'bulk': 'muscle_gain',
  'bulking': 'muscle_gain',
  'gain muscle': 'muscle_gain',
  'recomp': 'recomp',
  'recomposition': 'recomp',
  'body recomp': 'recomp',
  'general_health': 'general_health',
  'general health': 'general_health',
  'maintain': 'general_health',
  'maintenance': 'general_health',
};

const ACTIVITY_MAP: Record<string, ActivityLevel> = {
  'sedentary': 'sedentary',
  'desk job': 'sedentary',
  'light': 'light',
  'lightly active': 'light',
  'moderate': 'moderate',
  'moderately active': 'moderate',
  'active': 'active',
  'very active': 'very_active',
  'very_active': 'very_active',
  'extremely active': 'very_active',
};

const ACCOUNTABILITY_MAP: Record<string, AccountabilityLevel> = {
  'light': 'light',
  'low': 'light',
  'minimal': 'light',
  'medium': 'medium',
  'moderate': 'medium',
  'normal': 'medium',
  'high': 'high',
  'max': 'high',
  'maximum': 'high',
};

const PERSONALITY_MAP: Record<string, CoachingPersonality> = {
  'motivator': 'motivator',
  'hype': 'motivator',
  'high energy': 'motivator',
  'educator': 'educator',
  'teacher': 'educator',
  'science': 'educator',
  'coach': 'coach',
  'professional': 'coach',
  'balanced': 'coach',
  'friend': 'friend',
  'casual': 'friend',
  'chill': 'friend',
};

const DAY_MAP: Record<string, WeekDay> = {
  'sunday': 'SU',
  'sun': 'SU',
  'monday': 'MO',
  'mon': 'MO',
  'tuesday': 'TU',
  'tue': 'TU',
  'tues': 'TU',
  'wednesday': 'WE',
  'wed': 'WE',
  'thursday': 'TH',
  'thu': 'TH',
  'thurs': 'TH',
  'friday': 'FR',
  'fri': 'FR',
  'saturday': 'SA',
  'sat': 'SA',
};

/**
 * Check if a message is requesting a settings change
 */
export function isSettingsRequest(message: string): boolean {
  const lower = message.toLowerCase();

  const settingsPatterns = [
    /\b(change|set|update|switch|make)\b.*(timezone|time zone|tz)/i,
    /\b(change|set|update)\b.*(calorie|calories|cal)\b.*(target|goal|to)/i,
    /\b(change|set|update)\b.*(protein)\b.*(target|goal|to)/i,
    /\b(change|set|update|switch)\b.*(goal|objective)/i,
    /\b(change|set|update)\b.*(activity|activity level)/i,
    /\b(change|set|update)\b.*(accountability)/i,
    /\b(change|set|update|switch)\b.*(coaching|coach|personality|style)/i,
    /\b(change|set|update)\b.*(workout|exercise)\b.*(target|goal)/i,
    /\b(change|set|update)\b.*(target weight|goal weight)/i,
    /\b(change|set|update)\b.*(breakfast|lunch|dinner|summary)\b.*(time|reminder)/i,
    /\b(change|set|update)\b.*(weigh.?in|weigh in)\b.*(day)/i,
    /\b(turn|switch)\b.*(on|off)\b.*(hydration|water)/i,
    /\b(pause|stop|disable)\b.*(reminder|notification)/i,
    /\b(resume|start|enable)\b.*(reminder|notification)/i,
    /\bmy timezone is\b/i,
    /\bi('m| am) in\b.*(timezone|time zone)/i,
    /\bi('m| am) (now )?in (tokyo|london|sydney|singapore)/i,
    /\bswitch.*(to|my).*(tokyo|london|pacific|eastern)/i,
    // Reminder customization patterns
    /\b(only|just)\s+(one|1|a single)\s+reminder/i,
    /\b(only|just)\s+(have|want|need|get)\s+(one|1|a single)\s+reminder/i,
    /\bremind me (only|just)?\s*(at|around)/i,
    /\b(disable|turn off|stop|no)\s+(breakfast|lunch|dinner)\s+(reminder|notification)/i,
    /\b(enable|turn on|start)\s+(breakfast|lunch|dinner)\s+(reminder|notification)/i,
    /\bdon'?t\s+(remind|text|message)\s+(me\s+)?(about|for|at)\s+(breakfast|lunch|dinner)/i,
    /\b(no more|stop)\s+(breakfast|lunch|dinner)/i,
    /\b(only|just)\s+(breakfast|lunch|dinner)\s+reminder/i,
  ];

  return settingsPatterns.some(pattern => pattern.test(lower));
}

/**
 * Parse a settings change request using LLM
 */
async function parseSettingsRequest(message: string, user: User): Promise<SettingsChange | null> {
  const systemPrompt = `You parse natural language requests to change app settings.

CURRENT USER SETTINGS:
- Timezone: ${user.timezone}
- Calorie target: ${user.calorieTarget || 'not set'}
- Protein target: ${user.proteinTarget || 'not set'}g
- Goal: ${user.primaryGoal || 'not set'}
- Activity level: ${user.activityLevel || 'not set'}
- Accountability: ${user.accountabilityLevel}
- Coaching style: ${user.coachingPersonality}
- Weekly workout target: ${user.weeklyWorkoutTarget}
- Target weight: ${user.targetWeight || 'not set'}

AVAILABLE SETTINGS:
- timezone: IANA timezone or alias (Eastern, Pacific, Tokyo, etc.)
- calorie_target: number between 1000-6000
- protein_target: number between 50-400
- primary_goal: fat_loss, muscle_gain, recomp, general_health
- activity_level: sedentary, light, moderate, active, very_active
- accountability_level: light, medium, high
- coaching_personality: motivator, educator, coach, friend
- weekly_workout_target: number between 1-7
- target_weight: number or "clear"
- breakfast_time, lunch_time, dinner_time, summary_time: time like "9am" or "21:00"
- weigh_in_day: day of week
- hydration_reminders: on/off
- pause_reminders: pause (with optional duration like "4h" or "until tomorrow")
- resume_reminders: resume
- breakfast_reminder_enabled: on/off (enable or disable breakfast reminder)
- lunch_reminder_enabled: on/off (enable or disable lunch reminder)
- dinner_reminder_enabled: on/off (enable or disable dinner reminder)
- single_reminder: time like "3pm" (sets ONE reminder at that time, disables others)

Parse the user's message and extract what setting they want to change.

Return JSON only:
{
  "setting": "one of the settings above",
  "value": "the new value they want",
  "confidence": "high" | "medium" | "low"
}

If you can't determine what they want to change, return null.`;

  const result = await callClaudeWithRetry(
    () => anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 200,
      system: systemPrompt,
      messages: [{ role: 'user', content: message }],
    }),
    { label: 'Settings parsing' }
  );

  if (!result.success || !result.data) {
    return null;
  }

  const text = result.data.content[0].type === 'text' ? result.data.content[0].text : '';

  if (text.toLowerCase().includes('null')) {
    return null;
  }

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return null;
  }

  const parsed = parseAndValidate(jsonMatch[0], SettingsChangeSchema);
  if (!parsed.success) {
    return null;
  }

  return parsed.data;
}

/**
 * Apply a parsed settings change
 */
async function applySettingsChange(
  user: User,
  change: SettingsChange
): Promise<{ success: true; message: string } | { success: false; error: string }> {
  const valueLower = change.value.toLowerCase().trim();

  switch (change.setting) {
    case 'timezone': {
      const resolved = TIMEZONE_ALIASES[valueLower] || change.value;
      try {
        Intl.DateTimeFormat(undefined, { timeZone: resolved });
        await prisma.user.update({
          where: { id: user.id },
          data: { timezone: resolved },
        });
        return { success: true, message: `Timezone updated to ${resolved}.` };
      } catch {
        return { success: false, error: `I don't recognize "${change.value}" as a timezone. Try "Eastern", "Tokyo", or a full name like "Asia/Singapore".` };
      }
    }

    case 'calorie_target': {
      const calories = parseInt(change.value.replace(/[^\d]/g, ''), 10);
      if (calories >= 1000 && calories <= 6000) {
        await prisma.user.update({
          where: { id: user.id },
          data: { calorieTarget: calories },
        });
        return { success: true, message: `Calorie target updated to ${calories.toLocaleString()} cal.` };
      }
      return { success: false, error: 'Calorie target should be between 1000-6000.' };
    }

    case 'protein_target': {
      const protein = parseInt(change.value.replace(/[^\d]/g, ''), 10);
      if (protein >= 50 && protein <= 400) {
        await prisma.user.update({
          where: { id: user.id },
          data: { proteinTarget: protein },
        });
        return { success: true, message: `Protein target updated to ${protein}g.` };
      }
      return { success: false, error: 'Protein target should be between 50-400g.' };
    }

    case 'primary_goal': {
      const goal = GOAL_MAP[valueLower];
      if (goal) {
        // Recalculate targets if we have all required data
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
            },
          });
          return {
            success: true,
            message: `Goal updated to ${goal.replace('_', ' ')}. New targets: ${targets.calorieTarget.toLocaleString()} cal, ${targets.proteinTarget}g protein.`
          };
        } else {
          await prisma.user.update({
            where: { id: user.id },
            data: { primaryGoal: goal, goalSetAt: new Date() },
          });
          return { success: true, message: `Goal updated to ${goal.replace('_', ' ')}.` };
        }
      }
      return { success: false, error: 'Goal options: fat loss, muscle gain, recomp, or general health.' };
    }

    case 'activity_level': {
      const activity = ACTIVITY_MAP[valueLower];
      if (activity) {
        await prisma.user.update({
          where: { id: user.id },
          data: { activityLevel: activity },
        });
        return { success: true, message: `Activity level updated to ${activity.replace('_', ' ')}.` };
      }
      return { success: false, error: 'Activity levels: sedentary, light, moderate, active, or very active.' };
    }

    case 'accountability_level': {
      const level = ACCOUNTABILITY_MAP[valueLower];
      if (level) {
        await prisma.user.update({
          where: { id: user.id },
          data: { accountabilityLevel: level },
        });
        return { success: true, message: `Accountability level set to ${level}.` };
      }
      return { success: false, error: 'Accountability levels: light, medium, or high.' };
    }

    case 'coaching_personality': {
      const personality = PERSONALITY_MAP[valueLower];
      if (personality) {
        await prisma.user.update({
          where: { id: user.id },
          data: { coachingPersonality: personality },
        });
        const confirmMessages: Record<CoachingPersonality, string> = {
          motivator: "Let's GO! 🔥",
          educator: "I'll teach you the why behind everything.",
          coach: "Solid. Data-focused coaching activated.",
          friend: "cool cool, we got this 😊",
        };
        return { success: true, message: `Coaching style updated to ${personality}. ${confirmMessages[personality]}` };
      }
      return { success: false, error: 'Coaching styles: motivator, educator, coach, or friend.' };
    }

    case 'weekly_workout_target': {
      const target = parseInt(change.value, 10);
      if (target >= 1 && target <= 7) {
        await prisma.user.update({
          where: { id: user.id },
          data: { weeklyWorkoutTarget: target },
        });
        return { success: true, message: `Weekly workout target set to ${target} days.` };
      }
      return { success: false, error: 'Weekly workout target should be 1-7 days.' };
    }

    case 'target_weight': {
      if (valueLower === 'clear' || valueLower === 'none' || valueLower === 'remove') {
        await prisma.user.update({
          where: { id: user.id },
          data: { targetWeight: null },
        });
        return { success: true, message: 'Target weight cleared.' };
      }
      const weight = parseFloat(change.value.replace(/[^\d.]/g, ''));
      if (weight >= 80 && weight <= 500) {
        await prisma.user.update({
          where: { id: user.id },
          data: { targetWeight: weight },
        });
        return { success: true, message: `Target weight set to ${weight} lbs.` };
      }
      return { success: false, error: 'Please enter a valid weight (80-500 lbs) or "clear".' };
    }

    case 'breakfast_time':
    case 'lunch_time':
    case 'dinner_time':
    case 'summary_time': {
      const time = parseTime(change.value);
      if (time) {
        const fieldMap: Record<string, string> = {
          breakfast_time: 'reminderBreakfastTime',
          lunch_time: 'reminderLunchTime',
          dinner_time: 'reminderDinnerTime',
          summary_time: 'dailySummaryTime',
        };
        await prisma.user.update({
          where: { id: user.id },
          data: { [fieldMap[change.setting]]: time },
        });
        const labelMap: Record<string, string> = {
          breakfast_time: 'Breakfast reminder',
          lunch_time: 'Lunch reminder',
          dinner_time: 'Dinner reminder',
          summary_time: 'Daily summary',
        };
        return { success: true, message: `${labelMap[change.setting]} set to ${formatTime(time)}.` };
      }
      return { success: false, error: 'Please enter a valid time like "9am" or "21:00".' };
    }

    case 'weigh_in_day': {
      const day = DAY_MAP[valueLower];
      if (day) {
        await prisma.user.update({
          where: { id: user.id },
          data: { weighInDay: day },
        });
        return { success: true, message: `Weigh-in day set to ${change.value}.` };
      }
      return { success: false, error: 'Please enter a day of the week.' };
    }

    case 'hydration_reminders': {
      const enabled = ['on', 'yes', 'enable', 'true', '1'].includes(valueLower);
      await prisma.user.update({
        where: { id: user.id },
        data: { hydrationReminders: enabled },
      });
      return { success: true, message: `Hydration reminders ${enabled ? 'enabled' : 'disabled'}.` };
    }

    case 'pause_reminders': {
      let pauseHours = 24;
      let pauseMessage = '24 hours';

      // Parse duration if provided
      const hoursMatch = change.value.match(/(\d+)\s*h/i);
      if (hoursMatch) {
        pauseHours = parseInt(hoursMatch[1], 10);
        pauseMessage = `${pauseHours} hours`;
      } else if (valueLower.includes('tomorrow')) {
        pauseHours = 24;
        pauseMessage = 'until tomorrow';
      }

      const pauseUntil = new Date(Date.now() + pauseHours * 60 * 60 * 1000);
      await prisma.user.update({
        where: { id: user.id },
        data: {
          remindersPaused: true,
          remindersPausedUntil: pauseUntil,
        },
      });
      return { success: true, message: `Reminders paused for ${pauseMessage}. Text "resume reminders" to turn them back on.` };
    }

    case 'resume_reminders': {
      await prisma.user.update({
        where: { id: user.id },
        data: {
          remindersPaused: false,
          remindersPausedUntil: null,
        },
      });
      return { success: true, message: 'Reminders resumed! ▶️' };
    }

    case 'breakfast_reminder_enabled': {
      const enabled = ['on', 'yes', 'enable', 'true', '1'].includes(valueLower);
      await prisma.user.update({
        where: { id: user.id },
        data: { reminderBreakfastEnabled: enabled },
      });
      return { success: true, message: `Breakfast reminder ${enabled ? 'enabled' : 'disabled'}.` };
    }

    case 'lunch_reminder_enabled': {
      const enabled = ['on', 'yes', 'enable', 'true', '1'].includes(valueLower);
      await prisma.user.update({
        where: { id: user.id },
        data: { reminderLunchEnabled: enabled },
      });
      return { success: true, message: `Lunch reminder ${enabled ? 'enabled' : 'disabled'}.` };
    }

    case 'dinner_reminder_enabled': {
      const enabled = ['on', 'yes', 'enable', 'true', '1'].includes(valueLower);
      await prisma.user.update({
        where: { id: user.id },
        data: { reminderDinnerEnabled: enabled },
      });
      return { success: true, message: `Dinner reminder ${enabled ? 'enabled' : 'disabled'}.` };
    }

    case 'single_reminder': {
      const time = parseTime(change.value);
      if (time) {
        // Set all meal reminders to the same time but only enable one
        await prisma.user.update({
          where: { id: user.id },
          data: {
            reminderBreakfastEnabled: false,
            reminderLunchEnabled: true,
            reminderDinnerEnabled: false,
            reminderLunchTime: time, // Use lunch slot for the single reminder
          },
        });
        return { success: true, message: `Got it — you'll get one reminder at ${formatTime(time)}.` };
      }
      return { success: false, error: 'Please enter a valid time like "3pm" or "15:00".' };
    }

    default:
      return { success: false, error: "I couldn't figure out which setting to change." };
  }
}

/**
 * Parse time string to HH:mm format
 */
function parseTime(input: string): string | null {
  const lower = input.toLowerCase().trim();

  // Match patterns like "9am", "9:30pm", "21:00", "9 am"
  const match = lower.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!match) return null;

  let hours = parseInt(match[1], 10);
  const minutes = match[2] ? parseInt(match[2], 10) : 0;
  const meridiem = match[3];

  if (meridiem === 'pm' && hours !== 12) hours += 12;
  if (meridiem === 'am' && hours === 12) hours = 0;

  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;

  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
}

/**
 * Format time for display
 */
function formatTime(time: string): string {
  const [hoursStr, minutesStr] = time.split(':');
  const hours = parseInt(hoursStr, 10);
  const minutes = parseInt(minutesStr, 10);

  const isPM = hours >= 12;
  const displayHour = hours % 12 || 12;
  const displayMinute = minutes > 0 ? `:${minutesStr}` : '';

  return `${displayHour}${displayMinute}${isPM ? 'pm' : 'am'}`;
}

/**
 * Handle a natural language settings change request
 */
export async function handleSettingsChange(
  user: User,
  message: string
): Promise<string> {
  const parsed = await parseSettingsRequest(message, user);

  if (!parsed) {
    return "I'm not sure which setting you want to change. Try something like \"set my timezone to Tokyo\" or \"change my calorie target to 2000\".";
  }

  if (parsed.confidence === 'low') {
    return `I think you want to change ${parsed.setting.replace('_', ' ')} to "${parsed.value}". Is that right? Reply "yes" to confirm or tell me what you actually want to change.`;
  }

  const result = await applySettingsChange(user, parsed);

  if (result.success) {
    return result.message;
  } else {
    return result.error;
  }
}
