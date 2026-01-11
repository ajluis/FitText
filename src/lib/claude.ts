import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';

// Singleton pattern for Anthropic client
const globalForAnthropic = globalThis as unknown as {
  anthropic: Anthropic | undefined;
};

export const anthropic = globalForAnthropic.anthropic ?? new Anthropic({
  apiKey: config.anthropic.apiKey,
});

if (process.env.NODE_ENV !== 'production') {
  globalForAnthropic.anthropic = anthropic;
}

// Model constants
export const CLAUDE_MODEL = 'claude-sonnet-4-20250514';
export const CLAUDE_VISION_MODEL = 'claude-sonnet-4-20250514';

// Max tokens for different use cases
export const MAX_TOKENS = {
  classification: 100,
  foodParsing: 500,
  workoutParsing: 500,
  coaching: 400,
  summary: 600,
  question: 800,
} as const;

export default anthropic;
