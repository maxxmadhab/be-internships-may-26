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
