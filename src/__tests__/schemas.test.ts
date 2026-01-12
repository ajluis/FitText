/**
 * Tests for Zod schemas
 */

import { describe, it, expect } from 'vitest';
import {
  FoodItemSchema,
  ParsedFoodResponseSchema,
  ExerciseSetSchema,
  ExerciseSchema,
  ParsedWorkoutResponseSchema,
  IntentClassificationSchema,
  ParsedWeightSchema,
  PhoneNumberSchema,
  TimezoneSchema,
  TimeStringSchema,
  parseAndValidate,
  validateFoodResponse,
  validateWorkoutResponse,
} from '../lib/schemas';

describe('FoodItemSchema', () => {
  it('validates valid food items', () => {
    const validItem = {
      name: 'Chicken Breast',
      quantity: '6 oz',
      calories: 280,
      protein: 52,
    };

    const result = FoodItemSchema.safeParse(validItem);
    expect(result.success).toBe(true);
  });

  it('uses default quantity when not provided', () => {
    const item = {
      name: 'Apple',
      calories: 95,
      protein: 0.5,
    };

    const result = FoodItemSchema.safeParse(item);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.quantity).toBe('1 serving');
    }
  });

  it('rejects items with missing name', () => {
    const item = {
      calories: 100,
      protein: 5,
    };

    const result = FoodItemSchema.safeParse(item);
    expect(result.success).toBe(false);
  });

  it('rejects items with negative calories', () => {
    const item = {
      name: 'Food',
      calories: -100,
      protein: 5,
    };

    const result = FoodItemSchema.safeParse(item);
    expect(result.success).toBe(false);
  });

  it('rejects items with excessive calories', () => {
    const item = {
      name: 'Food',
      calories: 15000,
      protein: 5,
    };

    const result = FoodItemSchema.safeParse(item);
    expect(result.success).toBe(false);
  });
});

describe('ParsedFoodResponseSchema', () => {
  it('validates complete food response', () => {
    const response = {
      items: [
        { name: 'Chicken', quantity: '6 oz', calories: 280, protein: 52 },
        { name: 'Rice', quantity: '1 cup', calories: 200, protein: 4 },
      ],
      totalCalories: 480,
      totalProtein: 56,
      confidence: 'high',
      notes: 'Meal logged successfully',
    };

    const result = ParsedFoodResponseSchema.safeParse(response);
    expect(result.success).toBe(true);
  });

  it('uses default confidence when not provided', () => {
    const response = {
      items: [{ name: 'Apple', quantity: '1', calories: 95, protein: 0.5 }],
      totalCalories: 95,
      totalProtein: 0.5,
    };

    const result = ParsedFoodResponseSchema.safeParse(response);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.confidence).toBe('medium');
    }
  });

  it('rejects invalid confidence levels', () => {
    const response = {
      items: [],
      totalCalories: 0,
      totalProtein: 0,
      confidence: 'very_high',
    };

    const result = ParsedFoodResponseSchema.safeParse(response);
    expect(result.success).toBe(false);
  });
});

describe('ExerciseSetSchema', () => {
  it('validates valid sets', () => {
    expect(ExerciseSetSchema.safeParse({ reps: 10, weight: 135 }).success).toBe(true);
    expect(ExerciseSetSchema.safeParse({ reps: 5, weight: 0 }).success).toBe(true);
    expect(ExerciseSetSchema.safeParse({ reps: 1 }).success).toBe(true);
  });

  it('rejects invalid sets', () => {
    expect(ExerciseSetSchema.safeParse({ reps: 0, weight: 135 }).success).toBe(false);
    expect(ExerciseSetSchema.safeParse({ reps: -5, weight: 135 }).success).toBe(false);
    expect(ExerciseSetSchema.safeParse({ reps: 10, weight: -50 }).success).toBe(false);
  });
});

describe('ParsedWorkoutResponseSchema', () => {
  it('validates strength workout', () => {
    const workout = {
      workoutType: 'strength',
      exercises: [
        {
          name: 'Bench Press',
          sets: [
            { reps: 10, weight: 135 },
            { reps: 8, weight: 155 },
          ],
        },
      ],
      durationMinutes: 45,
      confidence: 'high',
    };

    const result = ParsedWorkoutResponseSchema.safeParse(workout);
    expect(result.success).toBe(true);
  });

  it('validates cardio workout', () => {
    const workout = {
      workoutType: 'cardio',
      exercises: [
        {
          name: 'Running',
          duration: 30,
          distance: 3,
          distanceUnit: 'miles',
        },
      ],
      durationMinutes: 30,
    };

    const result = ParsedWorkoutResponseSchema.safeParse(workout);
    expect(result.success).toBe(true);
  });

  it('rejects invalid workout types', () => {
    const workout = {
      workoutType: 'yoga', // Not in enum
      exercises: [],
    };

    const result = ParsedWorkoutResponseSchema.safeParse(workout);
    expect(result.success).toBe(false);
  });
});

describe('IntentClassificationSchema', () => {
  it('validates all intent types', () => {
    const intents = [
      'food_log',
      'food_photo',
      'workout_log',
      'weight_log',
      'command',
      'question',
      'confirmation',
      'correction',
      'freeform',
      'greeting',
    ];

    for (const intent of intents) {
      const result = IntentClassificationSchema.safeParse({
        intent,
        confidence: 0.9,
      });
      expect(result.success).toBe(true);
    }
  });

  it('uses default confidence', () => {
    const result = IntentClassificationSchema.safeParse({ intent: 'food_log' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.confidence).toBe(0.8);
    }
  });

  it('rejects invalid confidence range', () => {
    expect(
      IntentClassificationSchema.safeParse({ intent: 'food_log', confidence: 1.5 }).success
    ).toBe(false);
    expect(
      IntentClassificationSchema.safeParse({ intent: 'food_log', confidence: -0.1 }).success
    ).toBe(false);
  });
});

describe('PhoneNumberSchema', () => {
  it('normalizes valid US phone numbers', () => {
    const result = PhoneNumberSchema.safeParse('2125551234');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe('+12125551234');
    }
  });

  it('handles numbers with country code', () => {
    const result = PhoneNumberSchema.safeParse('12125551234');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe('+12125551234');
    }
  });

  it('handles numbers already in E.164 format', () => {
    const result = PhoneNumberSchema.safeParse('+12125551234');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe('+12125551234');
    }
  });

  it('rejects invalid phone numbers', () => {
    expect(PhoneNumberSchema.safeParse('123').success).toBe(false);
    expect(PhoneNumberSchema.safeParse('0005551234').success).toBe(false); // Invalid area code
    expect(PhoneNumberSchema.safeParse('abcdefghij').success).toBe(false);
  });
});

describe('TimezoneSchema', () => {
  it('accepts valid timezones', () => {
    expect(TimezoneSchema.safeParse('America/New_York').success).toBe(true);
    expect(TimezoneSchema.safeParse('America/Los_Angeles').success).toBe(true);
    expect(TimezoneSchema.safeParse('America/Chicago').success).toBe(true);
    expect(TimezoneSchema.safeParse('UTC').success).toBe(true);
  });

  it('rejects clearly invalid timezones', () => {
    expect(TimezoneSchema.safeParse('Invalid/Timezone').success).toBe(false);
    expect(TimezoneSchema.safeParse('NotATimezone').success).toBe(false);
    expect(TimezoneSchema.safeParse('').success).toBe(false);
  });
});

describe('TimeStringSchema', () => {
  it('accepts valid time strings', () => {
    expect(TimeStringSchema.safeParse('09:00').success).toBe(true);
    expect(TimeStringSchema.safeParse('23:59').success).toBe(true);
    expect(TimeStringSchema.safeParse('00:00').success).toBe(true);
    expect(TimeStringSchema.safeParse('9:30').success).toBe(true);
  });

  it('rejects invalid time strings', () => {
    expect(TimeStringSchema.safeParse('25:00').success).toBe(false);
    expect(TimeStringSchema.safeParse('12:60').success).toBe(false);
    expect(TimeStringSchema.safeParse('9am').success).toBe(false);
    expect(TimeStringSchema.safeParse('').success).toBe(false);
  });
});

describe('parseAndValidate', () => {
  it('extracts and validates JSON from text', () => {
    const text = 'Here is the result: {"name": "Test", "calories": 100, "protein": 10, "quantity": "1 cup"}';
    const result = parseAndValidate(text, FoodItemSchema);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('Test');
    }
  });

  it('handles JSON with surrounding text', () => {
    const text = `
      I analyzed the food and here's what I found:
      {"name": "Apple", "calories": 95, "protein": 0.5, "quantity": "1 medium"}
      Hope that helps!
    `;
    const result = parseAndValidate(text, FoodItemSchema);
    expect(result.success).toBe(true);
  });

  it('returns error for missing JSON', () => {
    const text = 'No JSON here';
    const result = parseAndValidate(text, FoodItemSchema);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('No JSON object found');
    }
  });

  it('returns error for invalid JSON structure', () => {
    const text = '{"invalid": true}';
    const result = parseAndValidate(text, FoodItemSchema);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Validation failed');
    }
  });

  it('returns error for malformed JSON', () => {
    const text = '{"name": "Test", invalid}';
    const result = parseAndValidate(text, FoodItemSchema);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('JSON parse error');
    }
  });
});

describe('validateFoodResponse', () => {
  it('returns parsed data for valid response', () => {
    const text = JSON.stringify({
      items: [{ name: 'Chicken', quantity: '6 oz', calories: 280, protein: 52 }],
      totalCalories: 280,
      totalProtein: 52,
    });

    const result = validateFoodResponse(text);
    expect(result).not.toBeNull();
    expect(result?.items).toHaveLength(1);
    expect(result?.totalCalories).toBe(280);
  });

  it('returns null for invalid response', () => {
    const text = '{"invalid": true}';
    const result = validateFoodResponse(text);
    expect(result).toBeNull();
  });
});

describe('validateWorkoutResponse', () => {
  it('returns parsed data for valid response', () => {
    const text = JSON.stringify({
      workoutType: 'strength',
      exercises: [
        { name: 'Squat', sets: [{ reps: 5, weight: 225 }] },
      ],
    });

    const result = validateWorkoutResponse(text);
    expect(result).not.toBeNull();
    expect(result?.workoutType).toBe('strength');
    expect(result?.exercises).toHaveLength(1);
  });

  it('returns null for invalid response', () => {
    const text = '{"workoutType": "invalid"}';
    const result = validateWorkoutResponse(text);
    expect(result).toBeNull();
  });
});
