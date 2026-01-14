import { GoogleGenAI, GenerateContentResponse } from '@google/genai';
import { config } from '../config';
import { withRetry } from './retry';

// Singleton pattern for GoogleGenAI client
const globalForGenAI = globalThis as unknown as {
  genai: GoogleGenAI | undefined;
};

export const genai = globalForGenAI.genai ?? new GoogleGenAI({
  apiKey: config.google.apiKey,
});

if (process.env.NODE_ENV !== 'production') {
  globalForGenAI.genai = genai;
}

// Model constants
export const GEMINI_MODEL = 'gemini-2.0-flash';
export const GEMINI_VISION_MODEL = 'gemini-2.0-flash'; // Same model handles vision

// Max output tokens for different use cases
export const MAX_OUTPUT_TOKENS = {
  classification: 100,
  foodParsing: 500,
  workoutParsing: 500,
  coaching: 400,
  summary: 600,
  question: 800,
} as const;

// Error types for better handling
export type GeminiErrorType = 'rate_limit' | 'auth_error' | 'timeout' | 'api_error' | 'unknown';

export interface GeminiError {
  type: GeminiErrorType;
  message: string;
  retryable: boolean;
}

/**
 * Categorize Gemini API errors for appropriate handling
 */
export function categorizeGeminiError(error: unknown): GeminiError {
  // Check for status codes in error object
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status: number }).status;
    const message = (error as { message?: string }).message || 'Unknown error';

    if (status === 429) {
      return {
        type: 'rate_limit',
        message: 'Rate limit reached. Please try again in a moment.',
        retryable: true,
      };
    }

    if (status === 401 || status === 403) {
      return {
        type: 'auth_error',
        message: 'Authentication failed.',
        retryable: false,
      };
    }

    if (status === 400) {
      return {
        type: 'api_error',
        message: `Bad request: ${message}`,
        retryable: false,
      };
    }

    if (status >= 500) {
      return {
        type: 'api_error',
        message: `Server error: ${message}`,
        retryable: true,
      };
    }
  }

  // Check for network/timeout errors
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes('timeout') || msg.includes('etimedout') || msg.includes('econnrefused')) {
      return {
        type: 'timeout',
        message: 'Connection timeout. Please try again.',
        retryable: true,
      };
    }

    if (msg.includes('network') || msg.includes('fetch')) {
      return {
        type: 'timeout',
        message: 'Network error. Please try again.',
        retryable: true,
      };
    }
  }

  return {
    type: 'unknown',
    message: error instanceof Error ? error.message : 'Unknown error occurred',
    retryable: true,
  };
}

/**
 * Check if a Gemini error is retryable
 */
function isGeminiErrorRetryable(error: unknown): boolean {
  const categorized = categorizeGeminiError(error);
  return categorized.retryable;
}

export interface GeminiCallResult<T> {
  success: boolean;
  data?: T;
  error?: GeminiError;
  attempts: number;
}

/**
 * Make a Gemini API call with retry logic
 */
export async function callGeminiWithRetry<T>(
  fn: () => Promise<T>,
  options: { maxAttempts?: number; label?: string } = {}
): Promise<GeminiCallResult<T>> {
  const { maxAttempts = 3, label = 'Gemini API call' } = options;

  const result = await withRetry(fn, {
    maxAttempts,
    initialDelayMs: 1000,
    retryOn: isGeminiErrorRetryable,
  });

  if (!result.success) {
    const error = categorizeGeminiError(result.error);
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
 * Get user-friendly error message for Gemini failures
 */
export function getUserFriendlyErrorMessage(error: GeminiError): string {
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

/**
 * Extract text from Gemini response
 */
export function extractTextFromResponse(response: GenerateContentResponse): string {
  return response.text ?? '';
}

/**
 * Helper to extract JSON from response text
 */
export function extractJSON<T>(text: string): T | null {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return null;
  }
  try {
    return JSON.parse(jsonMatch[0]) as T;
  } catch {
    return null;
  }
}

export default genai;
