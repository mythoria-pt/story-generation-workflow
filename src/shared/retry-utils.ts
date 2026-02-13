/**
 * Retry Utilities
 * Provides configurable retry logic with exponential backoff for handling transient errors
 */

import { logger } from '@/config/logger.js';

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterMs?: number;
  retryableErrors?: (error: unknown) => boolean;
  onRetry?: (attempt: number, error: unknown) => void | Promise<void>;
}

export interface RetryContext {
  attempt: number;
  maxAttempts: number;
  lastError?: unknown;
}

/**
 * Default retry configuration
 */
const DEFAULT_RETRY_OPTIONS: Required<Omit<RetryOptions, 'onRetry'>> = {
  maxAttempts: 3,
  baseDelayMs: 60000, // 60 seconds
  maxDelayMs: 300000, // 5 minutes
  jitterMs: 5000, // +/- 5 seconds
  retryableErrors: isTransientError,
};

/**
 * Determine if an error is transient and should be retried
 */
export function isTransientError(error: unknown): boolean {
  // Check for HTTP status codes that indicate transient errors
  if (typeof error === 'object' && error !== null) {
    const err = error as any;

    // Check status code
    const status = err.status || err.statusCode || err.code;
    if (typeof status === 'number') {
      // Retryable HTTP status codes
      const retryableStatuses = [
        408, // Request Timeout
        429, // Too Many Requests (Rate Limit)
        500, // Internal Server Error
        502, // Bad Gateway
        503, // Service Unavailable
        504, // Gateway Timeout
      ];

      if (retryableStatuses.includes(status)) {
        return true;
      }
    }

    // Check error code strings
    if (typeof err.code === 'string') {
      const retryableErrorCodes = [
        'ETIMEDOUT',
        'ECONNRESET',
        'ECONNREFUSED',
        'ENOTFOUND',
        'ENETUNREACH',
        'EAI_AGAIN',
        'rate_limit_exceeded',
        'server_error',
        'timeout',
      ];

      if (retryableErrorCodes.includes(err.code)) {
        return true;
      }
    }

    // Check error message for transient indicators
    const message = err.message || '';
    if (typeof message === 'string') {
      const transientPatterns = [
        /timeout/i,
        /timed out/i,
        /connection reset/i,
        /ECONNRESET/i,
        /rate limit/i,
        /too many requests/i,
        /service unavailable/i,
        /temporarily unavailable/i,
      ];

      if (transientPatterns.some((pattern) => pattern.test(message))) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Determine if an error is a safety/moderation block (non-retryable)
 */
export function isSafetyBlockError(error: unknown): boolean {
  if (typeof error === 'object' && error !== null) {
    const err = error as any;

    // Check for explicit safety block status codes
    const status = err.status || err.statusCode || err.code;
    if (status === 422) {
      return true;
    }

    // Check for OpenAI moderation_blocked error
    if (status === 400 && err.code === 'moderation_blocked') {
      return true;
    }

    // Check error code strings
    if (typeof err.code === 'string') {
      const safetyErrorCodes = [
        'moderation_blocked',
        'content_policy_violation',
        'IMAGE_SAFETY_BLOCKED',
        'PROHIBITED_CONTENT',
        'SAFETY',
        'BLOCKLIST',
        'IMAGE_SAFETY',
        'BLOCK_REASON_UNSPECIFIED',
      ];

      if (safetyErrorCodes.includes(err.code)) {
        return true;
      }
    }

    // Check error message
    const message = err.message || '';
    if (typeof message === 'string') {
      const safetyPatterns = [
        /safety system/i,
        /moderation/i,
        /content policy/i,
        /prohibited content/i,
        /safety.*blocked/i,
        /prompt blocked/i,
      ];

      if (safetyPatterns.some((pattern) => pattern.test(message))) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Calculate delay with exponential backoff and jitter
 */
function calculateDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitterMs: number,
): number {
  // Exponential backoff: baseDelay * 2^(attempt - 1)
  const exponentialDelay = baseDelayMs * Math.pow(2, attempt - 1);

  // Cap at max delay
  const cappedDelay = Math.min(exponentialDelay, maxDelayMs);

  // Add random jitter: +/- jitterMs
  const jitter = Math.random() * jitterMs * 2 - jitterMs;
  const finalDelay = Math.max(0, cappedDelay + jitter);

  return Math.floor(finalDelay);
}

/**
 * Sleep for a specified number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute an async function with retry logic
 *
 * @param fn - The async function to execute
 * @param options - Retry configuration options
 * @returns The result of the function or throws the last error
 */
export async function withRetry<T>(
  fn: (context: RetryContext) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const config = {
    ...DEFAULT_RETRY_OPTIONS,
    ...options,
    retryableErrors: options.retryableErrors || DEFAULT_RETRY_OPTIONS.retryableErrors,
  };

  let lastError: unknown;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    const context: RetryContext = {
      attempt,
      maxAttempts: config.maxAttempts,
      lastError,
    };

    try {
      const result = await fn(context);
      return result;
    } catch (error) {
      lastError = error;

      // Check if this is a safety block (non-retryable)
      if (isSafetyBlockError(error)) {
        logger.warn('Retry: Safety block error detected, not retrying', {
          attempt,
          maxAttempts: config.maxAttempts,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      // Check if error is retryable
      const shouldRetry = config.retryableErrors(error);

      // If not retryable or last attempt, throw
      if (!shouldRetry || attempt >= config.maxAttempts) {
        logger.error('Retry: Final attempt failed or error not retryable', {
          attempt,
          maxAttempts: config.maxAttempts,
          retryable: shouldRetry,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      // Calculate delay for next attempt
      const delayMs = calculateDelay(
        attempt,
        config.baseDelayMs,
        config.maxDelayMs,
        config.jitterMs,
      );

      logger.warn('Retry: Attempt failed, retrying after delay', {
        attempt,
        maxAttempts: config.maxAttempts,
        delayMs,
        delaySec: Math.round(delayMs / 1000),
        error: error instanceof Error ? error.message : String(error),
      });

      // Call onRetry callback if provided
      if (options.onRetry) {
        await options.onRetry(attempt, error);
      }

      // Wait before next attempt
      await sleep(delayMs);
    }
  }

  // This should never be reached, but TypeScript needs it
  throw lastError;
}

/**
 * Create a retry wrapper with pre-configured options
 *
 * @param defaultOptions - Default retry options for all calls
 * @returns A function that wraps async functions with retry logic
 */
export function createRetryWrapper(defaultOptions: RetryOptions = {}) {
  return async function retryWrapper<T>(
    fn: (context: RetryContext) => Promise<T>,
    overrideOptions: RetryOptions = {},
  ): Promise<T> {
    const mergedOptions = { ...defaultOptions, ...overrideOptions };
    return withRetry(fn, mergedOptions);
  };
}
