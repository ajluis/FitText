/**
 * Tests for retry utility
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withRetry, isRetryableError, isRetryableStatus } from '../lib/retry';

describe('isRetryableStatus', () => {
  it('returns true for server errors (5xx)', () => {
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(502)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(504)).toBe(true);
  });

  it('returns true for rate limiting (429)', () => {
    expect(isRetryableStatus(429)).toBe(true);
  });

  it('returns false for client errors (4xx except 429)', () => {
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
    expect(isRetryableStatus(403)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
  });

  it('returns false for success codes', () => {
    expect(isRetryableStatus(200)).toBe(false);
    expect(isRetryableStatus(201)).toBe(false);
    expect(isRetryableStatus(204)).toBe(false);
  });
});

describe('isRetryableError', () => {
  it('returns true for network errors', () => {
    expect(isRetryableError(new Error('ECONNRESET'))).toBe(true);
    expect(isRetryableError(new Error('ECONNREFUSED'))).toBe(true);
    expect(isRetryableError(new Error('fetch failed'))).toBe(true);
    expect(isRetryableError(new Error('network error'))).toBe(true);
    expect(isRetryableError(new Error('timeout'))).toBe(true);
  });

  // Note: The implementation defaults to true for unknown errors to be safe
  it('returns true for unknown errors (defaults to retry)', () => {
    expect(isRetryableError(new Error('Something went wrong'))).toBe(true);
    expect(isRetryableError(new Error('Validation failed'))).toBe(true);
  });
});

describe('withRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns success immediately when function succeeds', async () => {
    const fn = vi.fn().mockResolvedValue('success');

    const resultPromise = withRetry(fn);
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.success).toBe(true);
    expect(result.data).toBe('success');
    expect(result.attempts).toBe(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on errors', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockResolvedValueOnce('success');

    const resultPromise = withRetry(fn, { maxAttempts: 3, initialDelayMs: 100 });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.success).toBe(true);
    expect(result.data).toBe('success');
    expect(result.attempts).toBe(3);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('stops retrying after max attempts', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('ECONNRESET'));

    const resultPromise = withRetry(fn, { maxAttempts: 3, initialDelayMs: 100 });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toBe('ECONNRESET');
    expect(result.attempts).toBe(3);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry when retryOn returns false', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('Validation failed'));

    // Custom retryOn that only retries network errors
    const resultPromise = withRetry(fn, {
      maxAttempts: 3,
      initialDelayMs: 100,
      retryOn: (err) => {
        const message = err instanceof Error ? err.message.toLowerCase() : '';
        return message.includes('network') || message.includes('econnreset');
      },
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.error?.message).toBe('Validation failed');
    expect(result.attempts).toBe(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('uses exponential backoff with jitter', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const delays: number[] = [];

    const originalSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((cb: () => void, delay?: number) => {
      if (delay && delay > 0) {
        delays.push(delay);
      }
      return originalSetTimeout(cb, 0);
    });

    const resultPromise = withRetry(fn, {
      maxAttempts: 4,
      initialDelayMs: 100,
      backoffMultiplier: 2,
    });
    await vi.runAllTimersAsync();
    await resultPromise;

    // With jitter, delays will be approximately:
    // First retry: 100-120ms, second: 200-240ms, third: 400-480ms
    expect(delays.length).toBe(3); // 3 retries = 3 delays
    expect(delays[0]).toBeGreaterThanOrEqual(100);
    expect(delays[0]).toBeLessThanOrEqual(120);
    expect(delays[1]).toBeGreaterThanOrEqual(200);
    expect(delays[1]).toBeLessThanOrEqual(240);
    expect(delays[2]).toBeGreaterThanOrEqual(400);
    expect(delays[2]).toBeLessThanOrEqual(480);

    vi.restoreAllMocks();
  });

  it('respects maximum delay', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const delays: number[] = [];

    const originalSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((cb: () => void, delay?: number) => {
      if (delay && delay > 0) {
        delays.push(delay);
      }
      return originalSetTimeout(cb, 0);
    });

    const resultPromise = withRetry(fn, {
      maxAttempts: 5,
      initialDelayMs: 1000,
      backoffMultiplier: 2,
      maxDelayMs: 2000,
    });
    await vi.runAllTimersAsync();
    await resultPromise;

    // All delays should be capped at maxDelayMs
    expect(Math.max(...delays)).toBeLessThanOrEqual(2000);

    vi.restoreAllMocks();
  });

  it('handles custom retryOn function', async () => {
    const customError = new Error('Custom retryable error');
    (customError as Error & { retryable: boolean }).retryable = true;

    const fn = vi
      .fn()
      .mockRejectedValueOnce(customError)
      .mockResolvedValueOnce('success');

    const resultPromise = withRetry(fn, {
      maxAttempts: 3,
      initialDelayMs: 100,
      retryOn: (err) => (err as Error & { retryable?: boolean }).retryable === true,
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2);
  });

  it('converts non-Error throws to Error objects', async () => {
    const fn = vi.fn().mockRejectedValue('string error');

    const resultPromise = withRetry(fn, {
      maxAttempts: 1,
      retryOn: () => false,
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toBe('string error');
  });
});
