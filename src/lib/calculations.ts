import { ActivityLevel, PrimaryGoal, Sex } from '@prisma/client';
import { ACTIVITY_MULTIPLIERS } from '../config';

interface UserStats {
  currentWeight: number;  // lbs
  heightInches: number;
  age: number;
  sex: Sex;
  activityLevel: ActivityLevel;
}

interface Targets {
  tdee: number;
  calorieTarget: number;
  proteinTarget: number;
  weeklyWorkoutTarget: number;
}

/**
 * Calculate BMR using Mifflin-St Jeor Equation
 */
export function calculateBMR(stats: UserStats): number {
  // Convert lbs to kg and inches to cm
  const weightKg = stats.currentWeight * 0.453592;
  const heightCm = stats.heightInches * 2.54;

  if (stats.sex === 'male') {
    return (10 * weightKg) + (6.25 * heightCm) - (5 * stats.age) + 5;
  } else {
    return (10 * weightKg) + (6.25 * heightCm) - (5 * stats.age) - 161;
  }
}

/**
 * Calculate TDEE (Total Daily Energy Expenditure)
 */
export function calculateTDEE(stats: UserStats): number {
  const bmr = calculateBMR(stats);
  const multiplier = ACTIVITY_MULTIPLIERS[stats.activityLevel];
  return Math.round(bmr * multiplier);
}

/**
 * Calculate targets based on user stats and goal
 */
export function calculateTargets(stats: UserStats, goal: PrimaryGoal): Targets {
  const tdee = calculateTDEE(stats);
  let calorieTarget: number;
  let proteinTarget: number;
  let weeklyWorkoutTarget: number;

  switch (goal) {
    case 'fat_loss':
      calorieTarget = tdee - 500; // ~1 lb/week loss
      proteinTarget = Math.round(stats.currentWeight * 1.0); // 1g per lb
      weeklyWorkoutTarget = 4;
      break;

    case 'muscle_gain':
      calorieTarget = tdee + 300; // Lean bulk
      proteinTarget = Math.round(stats.currentWeight * 0.9);
      weeklyWorkoutTarget = 5;
      break;

    case 'recomp':
      calorieTarget = tdee; // Maintenance
      proteinTarget = Math.round(stats.currentWeight * 1.1); // Higher protein
      weeklyWorkoutTarget = 5;
      break;

    case 'general_health':
      calorieTarget = tdee;
      proteinTarget = Math.round(stats.currentWeight * 0.7);
      weeklyWorkoutTarget = 3;
      break;

    default:
      calorieTarget = tdee;
      proteinTarget = Math.round(stats.currentWeight * 0.8);
      weeklyWorkoutTarget = 3;
  }

  return {
    tdee,
    calorieTarget,
    proteinTarget,
    weeklyWorkoutTarget,
  };
}

/**
 * Parse height string into inches
 * Handles formats like: "5'10", "5'10\"", "5 10", "70", "70 inches", "70in"
 */
export function parseHeight(input: string): number | null {
  const cleaned = input.trim().toLowerCase();

  // Format: 5'10 or 5'10" or 5' 10"
  const feetInchesMatch = cleaned.match(/(\d+)['\s]+(\d+)/);
  if (feetInchesMatch) {
    const feet = parseInt(feetInchesMatch[1], 10);
    const inches = parseInt(feetInchesMatch[2], 10);
    return feet * 12 + inches;
  }

  // Format: just inches (70 or 70in or 70 inches)
  const inchesMatch = cleaned.match(/^(\d+)\s*(in|inches?)?$/);
  if (inchesMatch) {
    const inches = parseInt(inchesMatch[1], 10);
    // Sanity check - if it's a reasonable height in inches (48-84 range)
    if (inches >= 48 && inches <= 84) {
      return inches;
    }
  }

  return null;
}

/**
 * Parse weight string into pounds
 * Handles formats like: "185", "185 lbs", "185lbs", "185 pounds"
 */
export function parseWeight(input: string): number | null {
  const cleaned = input.trim().toLowerCase();

  const match = cleaned.match(/^(\d+\.?\d*)\s*(lbs?|pounds?)?$/);
  if (match) {
    const weight = parseFloat(match[1]);
    // Sanity check - reasonable weight range
    if (weight >= 80 && weight <= 500) {
      return weight;
    }
  }

  return null;
}

/**
 * Parse time string into HH:mm format
 * Handles: "9am", "9:30am", "9:30 am", "21:00", "9:30"
 */
export function parseTime(input: string): string | null {
  const cleaned = input.trim().toLowerCase();

  // Format: 9am, 9:30am, 9:30 am
  const ampmMatch = cleaned.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (ampmMatch) {
    let hours = parseInt(ampmMatch[1], 10);
    const minutes = ampmMatch[2] ? parseInt(ampmMatch[2], 10) : 0;
    const isPM = ampmMatch[3] === 'pm';

    if (isPM && hours !== 12) hours += 12;
    if (!isPM && hours === 12) hours = 0;

    if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) {
      return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
    }
  }

  // Format: 21:00 or 9:30
  const militaryMatch = cleaned.match(/^(\d{1,2}):(\d{2})$/);
  if (militaryMatch) {
    const hours = parseInt(militaryMatch[1], 10);
    const minutes = parseInt(militaryMatch[2], 10);

    if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) {
      return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
    }
  }

  return null;
}

/**
 * Format time string for display
 * Converts HH:mm to "9:00 AM" format
 */
export function formatTime(time: string): string {
  const [hours, minutes] = time.split(':').map(Number);
  const isPM = hours >= 12;
  const displayHours = hours % 12 || 12;
  const period = isPM ? 'PM' : 'AM';
  return `${displayHours}:${minutes.toString().padStart(2, '0')} ${period}`;
}

/**
 * Get current time in user's timezone as decimal hours
 * e.g., 10:30 AM = 10.5
 */
export function getCurrentTimeDecimal(timezone: string): number {
  const now = new Date();
  const timeString = now.toLocaleTimeString('en-US', {
    timeZone: timezone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });
  const [hours, minutes] = timeString.split(':').map(Number);
  return hours + minutes / 60;
}

/**
 * Get today's date in user's timezone
 */
export function getTodayDate(timezone: string): Date {
  const now = new Date();
  const dateString = now.toLocaleDateString('en-CA', { timeZone: timezone }); // YYYY-MM-DD format
  // Parse as UTC date to avoid local timezone interpretation issues
  const [year, month, day] = dateString.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

/**
 * Get the day of week in user's timezone
 */
export function getDayOfWeek(timezone: string): string {
  const now = new Date();
  const dayName = now.toLocaleDateString('en-US', {
    timeZone: timezone,
    weekday: 'short',
  });

  // Convert to our enum format
  const dayMap: Record<string, string> = {
    'Sun': 'SU',
    'Mon': 'MO',
    'Tue': 'TU',
    'Wed': 'WE',
    'Thu': 'TH',
    'Fri': 'FR',
    'Sat': 'SA',
  };

  return dayMap[dayName] || 'MO';
}

/**
 * Calculate percentage
 */
export function percentage(value: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((value / total) * 100);
}

/**
 * Format number with commas
 */
export function formatNumber(num: number): string {
  return num.toLocaleString();
}
