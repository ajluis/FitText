/**
 * Tests for calculation utilities
 */

import { describe, it, expect } from 'vitest';
import {
  calculateBMR,
  calculateTDEE,
  calculateTargets,
  parseHeight,
  parseWeight,
  parseTime,
  formatTime,
  percentage,
} from '../lib/calculations';

describe('calculateBMR', () => {
  it('calculates BMR correctly for male', () => {
    const stats = {
      currentWeight: 180, // lbs
      heightInches: 70, // 5'10"
      age: 30,
      sex: 'male' as const,
      activityLevel: 'moderate' as const,
    };

    const bmr = calculateBMR(stats);
    // Mifflin-St Jeor: (10 * 81.6kg) + (6.25 * 177.8cm) - (5 * 30) + 5
    // = 816 + 1111.25 - 150 + 5 = 1782.25
    expect(bmr).toBeCloseTo(1782.25, 0);
  });

  it('calculates BMR correctly for female', () => {
    const stats = {
      currentWeight: 140,
      heightInches: 65,
      age: 28,
      sex: 'female' as const,
      activityLevel: 'moderate' as const,
    };

    const bmr = calculateBMR(stats);
    // (10 * 63.5kg) + (6.25 * 165.1cm) - (5 * 28) - 161
    // = 635 + 1031.875 - 140 - 161 = 1365.875
    expect(bmr).toBeCloseTo(1365.875, 0);
  });
});

describe('calculateTDEE', () => {
  it('applies sedentary multiplier correctly', () => {
    const stats = {
      currentWeight: 180,
      heightInches: 70,
      age: 30,
      sex: 'male' as const,
      activityLevel: 'sedentary' as const,
    };

    const tdee = calculateTDEE(stats);
    // TDEE = BMR * 1.2, allow for small rounding differences
    expect(tdee).toBeGreaterThan(2100);
    expect(tdee).toBeLessThan(2200);
  });

  it('applies moderate multiplier correctly', () => {
    const stats = {
      currentWeight: 180,
      heightInches: 70,
      age: 30,
      sex: 'male' as const,
      activityLevel: 'moderate' as const,
    };

    const tdee = calculateTDEE(stats);
    // TDEE = BMR * 1.55, allow for small rounding differences
    expect(tdee).toBeGreaterThan(2750);
    expect(tdee).toBeLessThan(2800);
  });

  it('applies very_active multiplier correctly', () => {
    const stats = {
      currentWeight: 180,
      heightInches: 70,
      age: 30,
      sex: 'male' as const,
      activityLevel: 'very_active' as const,
    };

    const tdee = calculateTDEE(stats);
    // TDEE = BMR * 1.9, allow for small rounding differences
    expect(tdee).toBeGreaterThan(3380);
    expect(tdee).toBeLessThan(3400);
  });
});

describe('calculateTargets', () => {
  const baseStats = {
    currentWeight: 180,
    heightInches: 70,
    age: 30,
    sex: 'male' as const,
    activityLevel: 'moderate' as const,
  };

  it('calculates fat_loss targets correctly', () => {
    const targets = calculateTargets(baseStats, 'fat_loss');

    expect(targets.calorieTarget).toBeLessThan(targets.tdee);
    expect(targets.calorieTarget).toBe(targets.tdee - 500);
    expect(targets.proteinTarget).toBe(180); // 1g per lb
    expect(targets.weeklyWorkoutTarget).toBe(4);
  });

  it('calculates muscle_gain targets correctly', () => {
    const targets = calculateTargets(baseStats, 'muscle_gain');

    expect(targets.calorieTarget).toBeGreaterThan(targets.tdee);
    expect(targets.calorieTarget).toBe(targets.tdee + 300);
    expect(targets.proteinTarget).toBe(Math.round(180 * 0.9));
    expect(targets.weeklyWorkoutTarget).toBe(5);
  });

  it('calculates recomp targets correctly', () => {
    const targets = calculateTargets(baseStats, 'recomp');

    expect(targets.calorieTarget).toBe(targets.tdee);
    expect(targets.proteinTarget).toBe(Math.round(180 * 1.1));
    expect(targets.weeklyWorkoutTarget).toBe(5);
  });

  it('calculates general_health targets correctly', () => {
    const targets = calculateTargets(baseStats, 'general_health');

    expect(targets.calorieTarget).toBe(targets.tdee);
    expect(targets.proteinTarget).toBe(Math.round(180 * 0.7));
    expect(targets.weeklyWorkoutTarget).toBe(3);
  });
});

describe('parseHeight', () => {
  it('parses feet and inches format', () => {
    expect(parseHeight("5'10")).toBe(70);
    expect(parseHeight('5\'10"')).toBe(70);
    expect(parseHeight("5' 10")).toBe(70);
    expect(parseHeight('6 0')).toBe(72);
    expect(parseHeight("6'2")).toBe(74);
  });

  it('parses inches only format', () => {
    expect(parseHeight('70')).toBe(70);
    expect(parseHeight('70in')).toBe(70);
    expect(parseHeight('70 inches')).toBe(70);
    expect(parseHeight('65 in')).toBe(65);
  });

  it('returns null for invalid heights', () => {
    expect(parseHeight('abc')).toBeNull();
    expect(parseHeight('200')).toBeNull(); // Too tall
    expect(parseHeight('40')).toBeNull(); // Too short
    expect(parseHeight('')).toBeNull();
  });
});

describe('parseWeight', () => {
  it('parses weight with units', () => {
    expect(parseWeight('185')).toBe(185);
    expect(parseWeight('185 lbs')).toBe(185);
    expect(parseWeight('185lbs')).toBe(185);
    expect(parseWeight('185 pounds')).toBe(185);
    expect(parseWeight('185 lb')).toBe(185);
  });

  it('parses decimal weights', () => {
    expect(parseWeight('185.5')).toBe(185.5);
    expect(parseWeight('185.5 lbs')).toBe(185.5);
  });

  it('returns null for invalid weights', () => {
    expect(parseWeight('abc')).toBeNull();
    expect(parseWeight('50')).toBeNull(); // Too light
    expect(parseWeight('600')).toBeNull(); // Too heavy
    expect(parseWeight('')).toBeNull();
  });
});

describe('parseTime', () => {
  it('parses AM/PM format', () => {
    expect(parseTime('9am')).toBe('09:00');
    expect(parseTime('9:30am')).toBe('09:30');
    expect(parseTime('9:30 am')).toBe('09:30');
    expect(parseTime('12pm')).toBe('12:00');
    expect(parseTime('12am')).toBe('00:00');
  });

  it('parses PM times correctly', () => {
    expect(parseTime('1pm')).toBe('13:00');
    expect(parseTime('5:30pm')).toBe('17:30');
    expect(parseTime('11:45 pm')).toBe('23:45');
  });

  it('parses 24-hour format', () => {
    expect(parseTime('21:00')).toBe('21:00');
    expect(parseTime('9:30')).toBe('09:30');
    expect(parseTime('0:00')).toBe('00:00');
    expect(parseTime('23:59')).toBe('23:59');
  });

  it('returns null for invalid times', () => {
    expect(parseTime('abc')).toBeNull();
    expect(parseTime('25:00')).toBeNull();
    expect(parseTime('12:60')).toBeNull();
    expect(parseTime('')).toBeNull();
  });
});

describe('formatTime', () => {
  it('formats morning times correctly', () => {
    expect(formatTime('09:00')).toBe('9:00 AM');
    expect(formatTime('09:30')).toBe('9:30 AM');
    expect(formatTime('00:00')).toBe('12:00 AM');
  });

  it('formats afternoon/evening times correctly', () => {
    expect(formatTime('13:00')).toBe('1:00 PM');
    expect(formatTime('17:30')).toBe('5:30 PM');
    expect(formatTime('12:00')).toBe('12:00 PM');
    expect(formatTime('23:59')).toBe('11:59 PM');
  });
});

describe('percentage', () => {
  it('calculates percentages correctly', () => {
    expect(percentage(50, 100)).toBe(50);
    expect(percentage(1500, 2000)).toBe(75);
    expect(percentage(120, 150)).toBe(80);
  });

  it('handles zero total', () => {
    expect(percentage(50, 0)).toBe(0);
  });

  it('rounds to nearest integer', () => {
    expect(percentage(33, 100)).toBe(33);
    expect(percentage(1, 3)).toBe(33);
  });
});
