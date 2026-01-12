/**
 * Tests for input validation utilities
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  validatePhoneNumber,
  isValidPhoneNumber,
  validateTimezone,
  validateTimeString,
  validateInboundMessage,
  validateWeightInput,
  validateCalorieTarget,
  validateProteinTarget,
  sanitizeInput,
  sanitizeForDb,
} from '../lib/validators';

describe('validatePhoneNumber', () => {
  it('normalizes valid 10-digit US numbers', () => {
    expect(validatePhoneNumber('2125551234')).toBe('+12125551234');
    expect(validatePhoneNumber('8005551234')).toBe('+18005551234');
  });

  it('normalizes valid 11-digit US numbers', () => {
    expect(validatePhoneNumber('12125551234')).toBe('+12125551234');
  });

  it('handles numbers with plus prefix', () => {
    expect(validatePhoneNumber('+12125551234')).toBe('+12125551234');
  });

  it('returns null for invalid numbers', () => {
    expect(validatePhoneNumber('123')).toBeNull();
    expect(validatePhoneNumber('0005551234')).toBeNull();
    expect(validatePhoneNumber('')).toBeNull();
    expect(validatePhoneNumber('abcdefghij')).toBeNull();
  });
});

describe('isValidPhoneNumber', () => {
  it('returns true for valid numbers', () => {
    expect(isValidPhoneNumber('2125551234')).toBe(true);
    expect(isValidPhoneNumber('+12125551234')).toBe(true);
    expect(isValidPhoneNumber('12125551234')).toBe(true);
  });

  it('returns false for invalid numbers', () => {
    expect(isValidPhoneNumber('123')).toBe(false);
    expect(isValidPhoneNumber('')).toBe(false);
    expect(isValidPhoneNumber('0001234567')).toBe(false);
  });
});

describe('validateTimezone', () => {
  it('returns true for valid IANA timezones', () => {
    expect(validateTimezone('America/New_York')).toBe(true);
    expect(validateTimezone('America/Los_Angeles')).toBe(true);
    expect(validateTimezone('America/Chicago')).toBe(true);
    expect(validateTimezone('America/Denver')).toBe(true);
    expect(validateTimezone('UTC')).toBe(true);
  });

  it('returns false for invalid timezones', () => {
    expect(validateTimezone('Invalid/Timezone')).toBe(false);
    expect(validateTimezone('NotATimezone')).toBe(false);
    expect(validateTimezone('')).toBe(false);
  });
});

describe('validateTimeString', () => {
  it('returns true for valid HH:mm times', () => {
    expect(validateTimeString('09:00')).toBe(true);
    expect(validateTimeString('23:59')).toBe(true);
    expect(validateTimeString('00:00')).toBe(true);
    expect(validateTimeString('9:30')).toBe(true);
  });

  it('returns false for invalid times', () => {
    expect(validateTimeString('25:00')).toBe(false);
    expect(validateTimeString('12:60')).toBe(false);
    expect(validateTimeString('9am')).toBe(false);
    expect(validateTimeString('invalid')).toBe(false);
    expect(validateTimeString('')).toBe(false);
  });
});

describe('validateInboundMessage', () => {
  it('validates and returns complete message', () => {
    const data = {
      phone: '2125551234',
      content: 'Hello world',
      mediaUrl: null,
    };

    const result = validateInboundMessage(data);
    expect(result).not.toBeNull();
    expect(result?.phone).toBe('+12125551234');
    expect(result?.content).toBe('Hello world');
  });

  it('validates message with media URL', () => {
    const data = {
      phone: '2125551234',
      content: 'Check this photo',
      mediaUrl: 'https://example.com/image.jpg',
    };

    const result = validateInboundMessage(data);
    expect(result).not.toBeNull();
    expect(result?.mediaUrl).toBe('https://example.com/image.jpg');
  });

  it('returns null for invalid phone', () => {
    const data = {
      phone: '123',
      content: 'Hello',
    };

    const result = validateInboundMessage(data);
    expect(result).toBeNull();
  });

  it('returns null for empty content', () => {
    const data = {
      phone: '2125551234',
      content: '',
    };

    const result = validateInboundMessage(data);
    expect(result).toBeNull();
  });

  it('returns null for content exceeding max length', () => {
    const data = {
      phone: '2125551234',
      content: 'x'.repeat(10001),
    };

    const result = validateInboundMessage(data);
    expect(result).toBeNull();
  });

  it('returns null for invalid media URL', () => {
    const data = {
      phone: '2125551234',
      content: 'Hello',
      mediaUrl: 'not-a-url',
    };

    const result = validateInboundMessage(data);
    expect(result).toBeNull();
  });
});

describe('validateWeightInput', () => {
  it('parses weight with various formats', () => {
    expect(validateWeightInput('185')).toBe(185);
    expect(validateWeightInput('185 lbs')).toBe(185);
    expect(validateWeightInput('185lbs')).toBe(185);
    expect(validateWeightInput('185 pounds')).toBe(185);
    expect(validateWeightInput('185 lb')).toBe(185);
  });

  it('rounds to one decimal place', () => {
    expect(validateWeightInput('185.55')).toBe(185.6);
    expect(validateWeightInput('185.54')).toBe(185.5);
  });

  it('handles kg input', () => {
    expect(validateWeightInput('85 kg')).toBe(85);
    expect(validateWeightInput('85kg')).toBe(85);
  });

  it('returns null for out-of-range weights', () => {
    expect(validateWeightInput('40')).toBeNull(); // Too light
    expect(validateWeightInput('900')).toBeNull(); // Too heavy
  });

  it('returns null for invalid input', () => {
    expect(validateWeightInput('abc')).toBeNull();
    expect(validateWeightInput('')).toBeNull();
    expect(validateWeightInput('heavy')).toBeNull();
  });
});

describe('validateCalorieTarget', () => {
  it('parses valid calorie targets', () => {
    expect(validateCalorieTarget('2000')).toBe(2000);
    expect(validateCalorieTarget('2500')).toBe(2500);
    expect(validateCalorieTarget('1800 calories')).toBe(1800);
  });

  it('returns null for out-of-range values', () => {
    expect(validateCalorieTarget('500')).toBeNull(); // Too low
    expect(validateCalorieTarget('10000')).toBeNull(); // Too high
  });

  it('returns null for invalid input', () => {
    expect(validateCalorieTarget('abc')).toBeNull();
    expect(validateCalorieTarget('')).toBeNull();
  });
});

describe('validateProteinTarget', () => {
  it('parses valid protein targets', () => {
    expect(validateProteinTarget('150')).toBe(150);
    expect(validateProteinTarget('180g')).toBe(180);
    expect(validateProteinTarget('200 grams')).toBe(200);
  });

  it('returns null for out-of-range values', () => {
    expect(validateProteinTarget('10')).toBeNull(); // Too low
    expect(validateProteinTarget('600')).toBeNull(); // Too high
  });

  it('returns null for invalid input', () => {
    expect(validateProteinTarget('abc')).toBeNull();
    expect(validateProteinTarget('')).toBeNull();
  });
});

describe('sanitizeInput', () => {
  it('trims whitespace', () => {
    expect(sanitizeInput('  hello world  ')).toBe('hello world');
  });

  it('limits length to 5000 characters', () => {
    const longInput = 'x'.repeat(6000);
    const result = sanitizeInput(longInput);
    expect(result.length).toBe(5000);
  });

  it('removes control characters', () => {
    expect(sanitizeInput('hello\x00world')).toBe('helloworld');
    expect(sanitizeInput('test\x1F')).toBe('test');
  });

  it('preserves normal characters', () => {
    expect(sanitizeInput('Hello, World! 123')).toBe('Hello, World! 123');
    expect(sanitizeInput('emoji: 😀')).toBe('emoji: 😀');
  });

  it('preserves newlines and tabs', () => {
    expect(sanitizeInput('line1\nline2')).toBe('line1\nline2');
    expect(sanitizeInput('col1\tcol2')).toBe('col1\tcol2');
  });
});

describe('sanitizeForDb', () => {
  it('escapes backslashes', () => {
    expect(sanitizeForDb('path\\to\\file')).toBe('path\\\\to\\\\file');
  });

  it('applies standard sanitization first', () => {
    expect(sanitizeForDb('  hello\\world  ')).toBe('hello\\\\world');
  });

  it('handles strings without backslashes', () => {
    expect(sanitizeForDb('normal string')).toBe('normal string');
  });
});
