import { insertSignal, getByIdemKey, listSignals } from './db.js';
import { checkAndConsume } from './rateLimit.js';
import { withRetry, isUniqueConstraintError } from './retry.js';

function nowMs(){ return Date.now(); }

export async function postSignal(req, reply) {
  const idem = req.headers['idempotency-key'] || null;
  const { userId, type, payload } = req.body || {};
  if (!userId || !type || typeof payload === 'undefined') {
    return reply.code(400).send({ error: 'invalid_body' });
  }

  const { ok, remaining, resetMs } = checkAndConsume(userId, nowMs());
  if (!ok) return reply.code(429).send({ error: 'rate_limited', remaining, resetMs });

  // No check-then-insert. The DB's UNIQUE constraint on idempotency_key is the
  // single source of truth, so concurrent requests with the same key race
  // safely: exactly one INSERT wins, every other one hits the constraint and
  // falls back to a read of the row that won.
  const t = nowMs();
  try {
    const info = await withRetry(() => insertSignal(userId, type, payload, idem, t));
    return { id: info.lastInsertRowid, userId, type, payload: String(payload), idempotencyKey: idem, createdAt: t };
  } catch (e) {
    if (idem && isUniqueConstraintError(e)) {
      try {
        const existing = await withRetry(() => getByIdemKey(idem));
        if (existing) return existing;
      } catch (e2) {
        req.log.error({ err: e2, ctx: 'getByIdemKey_after_conflict' });
        return reply.code(503).send({ error: 'db_unavailable' });
      }
    }
    req.log.error({ err: e, ctx: 'insertSignal' });
    return reply.code(503).send({ error: 'db_unavailable' });
  }
}

export async function getSignals(req, reply) {
  const { userId, limit = 20 } = req.query || {};
  if (!userId) return reply.code(400).send({ error: 'missing_userId' });
  const lim = Math.min(Number(limit) || 20, 100);
  try {
    const rows = await withRetry(() => listSignals(userId, lim));
    return { items: rows };
  } catch (e) {
    req.log.error({ err: e, ctx: 'listSignals' });
    return reply.code(503).send({ error: 'db_unavailable' });
  }
}