// Retries a synchronous DB call on transient SQLITE_BUSY failures.
// Exponential backoff with full jitter, capped at maxMs.
const RETRYABLE_CODES = new Set(['SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT', 'SQLITE_LOCKED']);

export async function withRetry(fn, { attempts = 5, baseMs = 10, maxMs = 250 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return fn();
    } catch (err) {
      lastErr = err;
      const retryable = RETRYABLE_CODES.has(err.code);
      if (!retryable || i === attempts - 1) throw err;
      const cap = Math.min(maxMs, baseMs * 2 ** i);
      const delay = Math.random() * cap; // full jitter
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

export function isUniqueConstraintError(err) {
  return typeof err.code === 'string' && err.code.startsWith('SQLITE_CONSTRAINT');
}