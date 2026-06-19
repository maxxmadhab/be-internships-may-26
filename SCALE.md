# Scale Plan — 10k RPS

This describes how the design changes to handle ~10k requests/sec in
production, versus what's implemented for this challenge.

## API Layer

- Fastify instances are stateless w.r.t. request handling and can be run
  behind a load balancer (ALB/NLB, or an Envoy/Nginx layer) and scaled
  horizontally with a process manager or container orchestrator (k8s HPA on
  CPU/RPS).
- No sticky sessions are required since per-request state (rate limit
  counters, idempotency cache) is intended to live in shared storage, not in
  process memory (see below).

## Database

- SQLite (used here for simplicity) does not support concurrent writers
  across processes and would be the first bottleneck at scale. In
  production this becomes PostgreSQL:
  - Connection pooling (pgbouncer or built-in pool) sized to the number of
    API instances.
  - The existing index on `(user_id, created_at)` carries over directly for
    the `GET /v1/signals` query pattern.
  - The `idempotency_key UNIQUE` constraint carries over directly — Postgres
    enforces it the same way (`ON CONFLICT` / unique-violation handling).
- Writes can be sharded by `user_id` hash if a single primary becomes the
  bottleneck; reads can go to replicas.

## Idempotency

- Source of truth is the DB's unique constraint on `idempotency_key`, not an
  application-level check-then-insert. Every request attempts the insert
  directly:
  - First writer wins and returns the new row.
  - Every other concurrent writer with the same key hits the unique
    constraint, and the handler responds by reading the row the winner just
    created.
  - This is race-safe under arbitrary concurrency because the DB serializes
    the constraint check, not the application.
- At higher scale, idempotency keys can additionally be cached in Redis
  (`SET key value NX EX <ttl>`) to short-circuit duplicate requests before
  they reach the DB at all, with the DB constraint kept as the
  correctness backstop.

## Rate Limiting

- Current implementation (`rateLimit.js`) is an in-memory `Map`, correct only
  for a single process. With multiple instances, each one enforces the limit
  independently, so the effective global limit is `RATE * instanceCount`.
- Production fix: move counters to Redis using `INCR` + `EXPIRE` (or a
  sliding-window log / token-bucket Lua script for accuracy), so all
  instances share one counter per user. This also lets the limit survive
  instance restarts and redeploys.

## Reliability

- Transient DB errors (`SQLITE_BUSY` here, connection/lock contention in
  Postgres) are retried with exponential backoff and full jitter
  (`src/retry.js`), capped at a small number of attempts so a sustained
  outage fails fast instead of queuing requests indefinitely.
- A circuit breaker in front of the DB client would stop hammering a DB
  that's clearly down, fail fast, and probe periodically to recover —
  worth adding once there's a real downstream dependency to protect.

## Caching

- Hot reads (`GET /v1/signals` for active users) can be cached in Redis with
  a short TTL and invalidated/refreshed on write, since the access pattern
  is read-heavy relative to writes.

## Async Work

- Any downstream processing triggered by a signal (notifications,
  analytics, etc.) should be decoupled from the request path via a queue
  (SQS, Kafka) so `POST /v1/signals` stays fast and the write path isn't
  coupled to slower consumers.

## Summary

| Concern        | Challenge implementation | Production at 10k RPS         |
|-----------------|---------------------------|--------------------------------|
| API             | Single Fastify process    | Stateless, horizontally scaled |
| DB              | SQLite                    | PostgreSQL + pooling + replicas|
| Idempotency     | DB unique constraint      | Same, + Redis fast-path cache  |
| Rate limiting   | In-memory Map             | Redis INCR/EXPIRE, shared      |
| Failure handling| Retry + backoff + jitter  | Same, + circuit breaker        |
| Downstream work | Inline                    | Queue (SQS/Kafka)              |