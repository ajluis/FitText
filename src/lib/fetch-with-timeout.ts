/**
 * Fetch wrapper with timeout support
 */

export interface FetchWithTimeoutOptions extends RequestInit {
  timeoutMs?: number;
}

export class TimeoutError extends Error {
  constructor(message: string, public timeoutMs: number) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * Default timeout in milliseconds (30 seconds)
 */
export const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Fetch with timeout support
 *
 * @param url - The URL to fetch
 * @param options - Fetch options including optional timeoutMs
 * @returns Promise<Response>
 * @throws TimeoutError if request times out
 */
export async function fetchWithTimeout(
  url: string | URL,
  options: FetchWithTimeoutOptions = {}
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...fetchOptions } = options;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
    });
    return response;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new TimeoutError(
        `Request to ${url} timed out after ${timeoutMs}ms`,
        timeoutMs
      );
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Fetch JSON with timeout support
 *
 * @param url - The URL to fetch
 * @param options - Fetch options including optional timeoutMs
 * @returns Promise<T> - Parsed JSON response
 */
export async function fetchJsonWithTimeout<T>(
  url: string | URL,
  options: FetchWithTimeoutOptions = {}
): Promise<T> {
  const response = await fetchWithTimeout(url, options);

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(`HTTP ${response.status}: ${errorText}`);
  }

  return response.json() as Promise<T>;
}
