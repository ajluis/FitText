import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { withRetry } from './retry';

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

// Error types for better handling
export type ClaudeErrorType = 'rate_limit' | 'auth_error' | 'timeout' | 'api_error' | 'unknown';

export interface ClaudeError {
  type: ClaudeErrorType;
  message: string;
  retryable: boolean;
}

/**
 * Categorize Claude API errors for appropriate handling
 */
export function categorizeClaudeError(error: unknown): ClaudeError {
  if (error instanceof Anthropic.RateLimitError) {
    return {
      type: 'rate_limit',
      message: 'Rate limit reached. Please try again in a moment.',
      retryable: true,
    };
  }

  if (error instanceof Anthropic.AuthenticationError) {
    return {
      type: 'auth_error',
      message: 'Authentication failed.',
      retryable: false,
    };
  }

  if (error instanceof Anthropic.APIConnectionError) {
    return {
      type: 'timeout',
      message: 'Connection timeout. Please try again.',
      retryable: true,
    };
  }

  if (error instanceof Anthropic.APIError) {
    const status = error.status;
    return {
      type: 'api_error',
      message: `API error: ${error.message}`,
      retryable: status ? status >= 500 : false,
    };
  }

  return {
    type: 'unknown',
    message: error instanceof Error ? error.message : 'Unknown error occurred',
    retryable: true,
  };
}

/**
 * Check if a Claude error is retryable
 */
function isClaudeErrorRetryable(error: unknown): boolean {
  const categorized = categorizeClaudeError(error);
  return categorized.retryable;
}

export interface ClaudeCallResult<T> {
  success: boolean;
  data?: T;
  error?: ClaudeError;
  attempts: number;
}

/**
 * Make a Claude API call with retry logic
 */
export async function callClaudeWithRetry<T>(
  fn: () => Promise<T>,
  options: { maxAttempts?: number; label?: string } = {}
): Promise<ClaudeCallResult<T>> {
  const { maxAttempts = 3, label = 'Claude API call' } = options;

  const result = await withRetry(fn, {
    maxAttempts,
    initialDelayMs: 1000,
    retryOn: isClaudeErrorRetryable,
  });

  if (!result.success) {
    const error = categorizeClaudeError(result.error);
    console.error(`${label} failed after ${result.attempts} attempts:`, error.message);
    return {
      success: false,
      error,
      attempts: result.attempts,
    };
  }

  return {
    success: true,
    data: result.data,
    attempts: result.attempts,
  };
}

/**
 * Get user-friendly error message for Claude failures
 */
export function getUserFriendlyErrorMessage(error: ClaudeError): string {
  switch (error.type) {
    case 'rate_limit':
      return "I'm getting a lot of requests right now. Can you try again in a few seconds?";
    case 'timeout':
      return "My connection timed out. Can you try again?";
    case 'auth_error':
      return "I'm having a configuration issue. Please try again later.";
    case 'api_error':
      return "I'm having trouble processing that. Can you try rephrasing?";
    default:
      return "Something went wrong. Can you try again?";
  }
}

export default anthropic;
