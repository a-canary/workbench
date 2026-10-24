/**
 * Exponential Backoff with Jitter
 *
 * Retries a failing operation with exponentially increasing delays.
 * Jitter (random +/- 10%) prevents thundering herd when multiple
 * evaluators retry simultaneously.
 *
 * Used for eval calls that can fail transiently (rate limits, network flakes).
 */

export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  maxRetries: number;
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
}

/** Sleep helper — resolves after ms milliseconds */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Run fn with exponential backoff and jitter.
 * Retries up to maxRetries times on failure.
 * Calls onRetry before each retry (useful for logging/monitoring).
 */
export async function withBackoff<T>(
  fn: () => Promise<T>,
  { baseMs, maxMs, maxRetries, onRetry }: BackoffOptions
): Promise<T> {
  let delay = baseMs;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === maxRetries) break;
      // Jitter: actual delay = delay +/- 10%
      const actualDelay = Math.min(delay + Math.random() * delay * 0.1, maxMs);
      onRetry?.(attempt + 1, actualDelay, err);
      await sleep(actualDelay);
      delay = Math.min(delay * 2, maxMs);
    }
  }

  throw lastError;
}