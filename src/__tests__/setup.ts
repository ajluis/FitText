/**
 * Vitest test setup file
 * Global mocks and test utilities
 */

import { vi } from 'vitest';

// Mock environment variables for tests
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/fittext_test';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
process.env.SENDBLUE_API_KEY = 'test-sendblue-key';
process.env.SENDBLUE_API_SECRET = 'test-sendblue-secret';
process.env.SENDBLUE_PHONE_NUMBER = '+15551234567';
process.env.WEBHOOK_BASE_URL = 'https://test.example.com';
process.env.PORT = '3000';
process.env.NODE_ENV = 'test';

// Mock Prisma client for tests that need it
vi.mock('../lib/db', () => ({
  default: {
    user: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    dailyLog: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    foodEntry: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
    workoutEntry: {
      create: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
    weightEntry: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

// Mock Anthropic client
vi.mock('@anthropic-ai/sdk', () => ({
  default: class Anthropic {
    messages = {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: '{}' }],
      }),
    };
  },
}));

// Mock fetch globally
global.fetch = vi.fn();

// Helper to reset all mocks between tests
export function resetMocks(): void {
  vi.clearAllMocks();
}
