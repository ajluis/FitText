/**
 * Retry utility with exponential backoff
 */

export interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  retryOn?: (error: unknown) => boolean;
}

export interface RetryResult<T> {
  success: boolean;
  data?: T;
  error?: Error;
  attempts: number;
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, 'retryOn'>> = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
};

/**
 * Determine if an error is retryable (network errors, 5xx, rate limits)
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    // Network errors
    if (
      message.includes('fetch') ||
      message.includes('network') ||
      message.includes('timeout') ||
      message.includes('econnrefused') ||
      message.includes('econnreset')
    ) {
      return true;
    }
  }
  return true; // Default to retry on unknown errors
}

/**
 * Determine if an HTTP status code is retryable
 */
export function isRetryableStatus(status: number): boolean {
  // Retry on 429 (rate limit), 5xx (server errors)
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Calculate delay for a given attempt using exponential backoff
 */
function calculateDelay(
  attempt: number,
  initialDelayMs: number,
  maxDelayMs: number,
  backoffMultiplier: number
): number {
  const delay = initialDelayMs * Math.pow(backoffMultiplier, attempt - 1);
  // Add jitter (0-20% random variation) to prevent thundering herd
  const jitter = delay * 0.2 * Math.random();
  return Math.min(delay + jitter, maxDelayMs);
}

/**
 * Execute a function with retry logic and exponential backoff
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<RetryResult<T>> {
  const {
    maxAttempts,
    initialDelayMs,
    maxDelayMs,
    backoffMultiplier,
  } = { ...DEFAULT_OPTIONS, ...options };

  const shouldRetry = options.retryOn ?? isRetryableError;

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const data = await fn();
      return { success: true, data, attempts: attempt };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Don't retry if we've exhausted attempts or error is not retryable
      if (attempt === maxAttempts || !shouldRetry(error)) {
        return { success: false, error: lastError, attempts: attempt };
      }

      // Calculate and wait for backoff delay
      const delay = calculateDelay(attempt, initialDelayMs, maxDelayMs, backoffMultiplier);
      await sleep(delay);
    }
  }

  return { success: false, error: lastError, attempts: maxAttempts };
}

/**
 * Create a retryable version of a function
 */
export function makeRetryable<TArgs extends unknown[], TReturn>(
  fn: (...args: TArgs) => Promise<TReturn>,
  options: RetryOptions = {}
): (...args: TArgs) => Promise<RetryResult<TReturn>> {
  return (...args: TArgs) => withRetry(() => fn(...args), options);
}
