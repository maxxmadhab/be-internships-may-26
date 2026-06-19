# Signals Challenge (Node.js + Fastify)

Build a minimal production-leaning service that can **handle load**, **rate limit**, and **avoid duplicates** via idempotency.

## Endpoints (to keep)
- `POST /v1/signals`
  - body: `{ "userId": "string", "type": "string", "payload": "string" }`
  - headers: `X-API-Key`, `Idempotency-Key` (optional)
  - behaviors:
    - **Rate limit** per `userId`: `RATE_LIMIT_PER_MIN` per minute (default 5).
    - **Idempotency**: same `Idempotency-Key` should not create duplicates.
- `GET /v1/signals?userId=...&limit=...`
- `GET /healthz`

## Your Tasks
1. **Implement a robust rate limiter** in `src/rateLimit.js`.
2. **Make idempotency safe across scale** in `src/signals.js`.
3. **Handle DB failure** gracefully with retry/backoff.
4. **Think for 10k RPS.** Add a `SCALE.md`.
5. **Finish the tests** in `tests/*.test.js`.

## Deliverables
- Working service, passing tests, updated README, SCALE.md.
- Optional deploy link.
---

## Extra Production Constraints (must pass)

- **Atomic Idempotency:** Survive concurrent requests and restarts. Avoid check-then-insert races; use a DB-level unique constraint or atomic upsert pattern. Return the same resource for identical `Idempotency-Key`.
- **Concurrency-Safe Rate Limit:** Must behave correctly under burst and parallel calls. Naive in-memory counters that race will fail hidden checks. Explain how this becomes multi-instance safe.
- **Transient DB Failures:** Implement retry/backoff (with jitter) or circuit breaker when DB errors occur (we simulate via `DB_FAIL_RATE`). No duplicates on retry.
- **Scale Plan (10k RPS):** Fill `SCALE.md` with a clear, concise approach (indexes, pooling, caching, queues, horizontal scale, idempotency store).

> We will run additional **hidden concurrency/multi-instance tests** during evaluation.






## my readme
# Signals Service

A small Fastify + SQLite service for ingesting "signals", with rate
limiting, idempotency, and retry-on-transient-failure.

## Endpoints

- `POST /v1/signals` — create a signal
  - Headers: `X-API-Key` (required), `Idempotency-Key` (optional)
  - Body: `{ "userId": "string", "type": "string", "payload": "string" }`
- `GET /v1/signals?userId=...&limit=...` — list signals for a user
- `GET /healthz` — liveness check, no auth required

## Running

```
npm install
npm run dev
```

## Testing

```
npm test
```

Runs all tests in `tests/` with Node's built-in test runner, including:

- `idempotency.test.js` — same key returns the same resource
- `rate-limit.test.js` — 6th request within a minute is rejected
- `concurrency.test.js` — 50 concurrent requests with the same
  `Idempotency-Key` collapse to exactly one stored row

## Design Notes

### Idempotency

Implemented using the database's `UNIQUE` constraint on
`idempotency_key`, not a check-then-insert in application code. The
handler always attempts the insert first:

- If it succeeds, that request created the row.
- If it fails with a unique-constraint violation, another concurrent
  request already won; the handler reads back that row and returns it.

This avoids the race where two concurrent requests both read "no
existing row" and both insert — the previous check-then-insert approach
was vulnerable to exactly that under concurrency.

### Retry / Backoff

All DB operations (`insertSignal`, `getByIdemKey`, `listSignals`) are
wrapped in `src/retry.js`'s `withRetry`, which retries on `SQLITE_BUSY`
(and related lock errors) with exponential backoff and full jitter, up
to 5 attempts, before the request fails with `503`.

### Rate Limiting

Current implementation (`src/rateLimit.js`) is an in-memory `Map`,
correct for a single process only. Running multiple instances means
each enforces the limit independently, so the effective limit becomes
`RATE * instanceCount`. Production deployments should move this to a
shared store (Redis `INCR` + `EXPIRE`, or a token-bucket Lua script) so
all instances share one counter per user. See `SCALE.md` for the full
write-up.

### Failure Handling

Transient DB failures (simulated via `DB_FAIL_RATE`) are retried with
exponential backoff and jitter rather than failing the request
immediately; only after retries are exhausted does the request return
`503 db_unavailable`.
