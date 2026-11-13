# Digital gift cards: design

**Status: review closed after round 3 of 3.**

- **Security reviewer:** SIGN-OFF in round 2, confirmed in round 3.
- **Feasibility reviewer:** CHANGES-REQUIRED in round 3, with one MAJOR (a test and wording gap).
  The reviewer stated it would sign off once its fixes (a), (b) and (c) were written in as
  specified. They have been, in 6.1 step 8, 6.2 and 9. The round cap was reached, so the reviewer
  has not explicitly re-confirmed the final text. See the Review log.

Branch: `feature/gift-cards`.

This document is the implementation contract for a developer starting cold. A claim marked
*(verified)* was checked against the repository at commit `b762ccf` (or its `node_modules`). A
claim marked *(assumption)* was not, and the phase that depends on it must confirm it.

---

## 1. Problem statement

Tenants (merchants) sell or give away **digital gift cards**.

1. An admin defines one or more **programs**. Each program sets the currency, the jurisdiction,
   the card-number format, the PIN policy, the maximum value and the expiry policy.
2. Staff **issue** a card from a program, for a stated amount and recipient. The system generates
   a secure card number, plus a PIN if the program requires one, and stores both encrypted.
3. The system **delivers** an email to the recipient. The email carries a link, never the card
   number. Opening the link reveals the card number, PIN and balance.
4. Staff **look up** and **redeem** cards by card number (plus PIN). Redemption is safe under
   concurrency and idempotent under client retries.

Every balance change is recorded in an append-only **ledger**. Admins can refund redemptions, and
can suspend, resume, void and unlock cards. Security-relevant actions are written to an
append-only audit log.

## 2. Constraints and assumptions

Constraints from the user (not reopened):

- digital cards only;
- Canada first, GCC later (including the 3-decimal currencies KWD, BHD and OMR);
- the PIN is optional per program;
- programs live in a separate `gift_card_programs` table;
- amounts are integer minor units only;
- no fees;
- deferred items are listed in section 13.

Codebase facts *(verified)*:

- **Layering** is `routes -> services -> TypeORM` (README.md:56).
  - Services take the `FastifyInstance` and use `app.db` (src/services/userService.ts:18,
    src/services/authService.ts:38).
  - There is no domain layer; pure helpers are flat modules (`src/credentials.ts`,
    `src/tokens.ts`).
- **Error mapping.** Expected failures are thrown `AppError` subclasses, mapped by
  `src/plugins/error-handler.ts`: 400/401/403/404/409, `23505 -> 409 "Already exists"` (:34-36),
  and `40001/40P01 -> 503 + Retry-After: 1`. Only the 503 path (:40) and the 500 path (:53) log,
  and both log the whole error object.
- **Time and ids.** Time comes from the DB via SQL `now()` (src/tokens.ts:7-9). Ids are
  `DEFAULT uuidv7()` (src/migrations/1760000000000-InitialSchema.ts:18).
- **Config** is validated by `src/config.ts`, which collects every problem and throws one
  `ConfigError`.
  - `readDbConfig` reads `dbLogging` (:113). `readServerConfig` reads `nodeEnv` (:119).
  - `test/unit/config.test.ts`:
    - `validEnv` is defined at :5-10;
    - :60-66 expects `loadConfig` with `NODE_ENV=production` and `CORS_ORIGIN` to succeed;
    - :145 expects `loadServerConfig({ JWT_SECRET, PORT })` to succeed.
  - `test/integration/helpers.ts:42-49` pins `NODE_ENV: "test"` and `DB_LOGGING: "false"`, and
    :52 loads the config on import.
  - Nothing logs the config (src/index.ts).
- **Import side effects.** `test/unit/no-import-side-effects.test.ts` only imports modules; it
  never calls `buildApp`.
- **Drift check.** `migration:check` (package.json:20) matches:
  - FKs by name, referenced table and onDelete/onUpdate (default `NO ACTION`);
  - checks and composite uniques by name;
  - indexes by name, uniqueness and columns;
  - single-column uniques by an `isUnique` flag;
  - PKs by column count only.

  `jsonb` compares equal, and triggers and functions are not loaded
  (node_modules/typeorm/schema-builder/RdbmsSchemaBuilder.js:195-363 and :571-586;
  driver/postgres/PostgresDriver.js:949-952 and :1143-1174).
- **Composite FKs.** TypeORM 1.1.0 has a class-level composite `@ForeignKey` decorator
  (node_modules/typeorm/decorator/ForeignKey.d.ts:32).
- **Rate-limit hooks.** `@fastify/rate-limit` appends its hook to the route's hook array
  (node_modules/@fastify/rate-limit/index.js:201-211).
  - A `keyGenerator` on a route whose `onRequest` starts with `authenticate` can therefore use
    `request.user`.
  - Routes with their own `rateLimit` config skip the global limiter.
- **`em.query` result shape.** For DML with `RETURNING`, `em.query` returns `[rows, rowCount]`
  (node_modules/typeorm/driver/postgres/PostgresQueryRunner.js:214-217).
- **pg type mapping.** `pg` returns integer and smallint as numbers, and bigint (including
  `SUM(integer)`) as strings.
- **`hkdfSync`** returns an `ArrayBuffer`.
- **`DB_LOGGING=true`** logs every statement with its parameters (src/data-source.ts:25). TypeORM
  1.1.0 has no parameter masking.
- **App-role privileges.** The app role gets SELECT, INSERT, UPDATE and DELETE only, through
  default privileges, in both the main database and `_test` (db/init/01-app-role.sh:24-33).
- **Legacy gift-card tables.** The legacy `gift_cards` (plaintext `pin`) and `transactions`
  tables, and two enums, exist unused (InitialSchema.ts:9-74).
- **`audit_logs`** exists unused (InitialSchema.ts:76-91), with inline FKs and the indexes
  `audit_logs_tenant_id_idx` and `audit_logs_user_id_idx`.
- **CORS.** The default methods are `GET,POST,PUT,DELETE` (src/config.ts:131).

Assumptions:

- **A1** *(assumption)*: no environment that matters has legacy rows. The drop migration refuses
  to run if any exist.
- **A2** *(assumption; the feasibility reviewer traced it)*: composite `@ForeignKey` round-trips
  through `migration:check`. Phase 2's exit criterion proves it.
- **A3 (enforced):** every gift-card transaction is opened explicitly with
  `app.db.transaction("READ COMMITTED", ...)`. The lock reasoning, the replay after the advisory
  lock, and the cap check all rely on per-statement snapshots.
- **A4:** rate limits are in memory and per instance (pre-existing).
- **A5** *(assumption)*: waiters on a PostgreSQL row lock are granted it in arrival order. The
  serialization tests stage their waiters one at a time.

## 3. Architecture

```
routes/ (transport: Ajv schemas, roles, rate limits, status codes)
   |
services/ (transaction scripts: SQL, locks, call pure deciders, throw AppError, write audit rows)
   |                         \
entities/ (TypeORM models)    gift-cards/ (pure: numbers, money, program rules, state machine,
                                           crypto, tokens, request hash, masking; node:crypto only)
services/deliveryDispatcher.ts --declares--> GiftCardDeliverySender (port)
delivery/log-only-sender.ts    --implements--> GiftCardDeliverySender
app.ts (composition root): builds CardCrypto, verifies key check values, builds sender + dispatcher,
                            passes them to route plugins
```

Component responsibilities, and what each must not know (B-1):

| Component | Responsibility | Must NOT know about |
|---|---|---|
| `src/gift-cards/*` (pure) | Numbering, Luhn, PIN and reference generation; currencies and countries; program rules; state machine and PIN decider; AES-GCM, HMAC and key check values; delivery token; request hash; email masking | TypeORM, Fastify, entities, env, SQL, HTTP |
| `GiftCardProgramService` | Programs: create, read, update; immutability after issue, and its lock | Card numbers, crypto, delivery |
| `GiftCardService` | Issue (card, `issue` ledger row, delivery row, audit); card reads; suspend, resume, void, unlock | HTTP, email transport |
| `RedemptionService` | Card authentication with lockout; lookup, redeem, refund; idempotency | Delivery, program mutation |
| `DeliveryService` | Resend, reveal | How email is sent |
| `DeliveryDispatcher` | Claim one due delivery at a time; mint its token; send under a hard timeout; record the outcome | Card numbers or PINs (never decrypts), HTTP |
| `LogOnlyDeliverySender` | Record that a message would be sent | The link, the token, the email local part, names, the message |
| `src/services/audit.ts` | `writeAudit(em, ctx, entry)` inside the caller's transaction | Secrets (typed per-action details have no field for them) |
| `src/services/sql.ts` | `returningRows<T>(em, sql, params)` | Business rules |
| Routes | Schemas, roles, rate limits, response mapping | SQL, crypto |

The four services each follow one unrelated axis of change (S-1): program policy, card lifecycle,
money movement and delivery.

## 4. Standards conformance

How the design satisfies each binding rule:

- **L-1 / L-6.** `src/gift-cards/**` imports only `node:crypto` and siblings. Services import pure
  modules and entities. An ESLint `no-restricted-imports` override on `src/gift-cards/**`
  (Phase 1) forbids `typeorm`, `fastify`, `../entities/*`, `../services/*`, `../routes/*` and
  `../config`.
- **L-2.** Pure modules use plain TS types. Entities are persistence models, and no domain type
  carries decorators.
- **L-5.** Only the entry points construct adapters:
  - `buildApp` builds `CardCrypto`, the sender (log-only, or the development console sender per
    7.7, unless an override is passed) and the dispatcher;
  - `src/scripts/dispatch-deliveries.ts` builds its own.

  Route plugins receive these as plugin options.
- **L-7 / X-3.** There is no repository layer, and each service owns its own `toXResponse(row)`.
  `sql.ts` and `audit.ts` are each one function with a real job.
- **S-5 / X-1.** There is exactly one interface, `GiftCardDeliverySender`, declared by its
  consumer, the dispatcher.
  - It sits at an IO boundary, with a named test seam (`RecordingDeliverySender`).
  - The second production implementation, a real provider, is deferred by the user.
  - `CardCrypto` is a concrete class.
- **B-2.**
  - The `CardCrypto` constructor validates its keys.
  - `validateProgramDefinition` returns either a validated value or problems.
  - DB CHECKs are the backstop.
- **B-3.**
  - Ajv validates shape at the edge.
  - Business rules live once, in the pure validators.
  - DB constraints back up races and bugs.
- **B-4.** Each operation runs in one READ COMMITTED transaction (section 6), with its audit rows
  inside it.
  - The lock order is: program, then the staff-issue advisory lock, then card, then delivery.
  - Delivery UPDATEs never change their FK columns, and the claim transaction never locks a card.
- **B-5.** Time comes from `now()` only. `randomInt` and `randomBytes` are injected, ids come from
  `uuidv7()`, and timeouts are constructor options.
- **E-2.** There are four catch sites:
  1. The `23505` handling. It runs after the transaction has rolled back, matches the exact
     constraint name, and then re-reads or regenerates.
  2. The dispatcher's sender call.
  3. The error handler's reduction of DB errors.
  4. `verifyCardKeys`, which rethrows with a named variable.
- **E-3.** Section 8 classifies every failure mode.
- **E-4.**
  - No card number, PIN or token is ever logged or returned outside reveal.
  - Recipient email and row contents stay out of the application's logs.
  - `DB_LOGGING=true` would print SQL parameters. Those carry PII and ciphertext but never a
    number, PIN or raw token, and `DB_LOGGING=true` is refused in production.
- **E-5.**
  - Issue, redeem and refund take `idempotencyKey`. The check runs after the card is
    authenticated and after the staff-issue lock, and before every mutable rule.
  - The `23505` concurrent-retry path is specified (6.1 step 8, 6.2) and tested deterministically
    (9).
  - Void, suspend, resume and unlock are idempotent on the natural key.
  - Resend mints a new token on each call and is rate limited.
- **E-6.**
  - The sender is raced against `AbortSignal.timeout(sendTimeoutMs)`.
  - `lock_timeout` bounds card-lock waits.
  - The migrations set `lock_timeout`.
- **T-2 / T-3.** The seams are constructor or plugin options. Every edge case maps to a named test
  in section 9.
- **M-1 / M-3 / M-4 / M-6 / M-7 / O-4.** There are three single-intent migrations, each with
  PRE-CHECK, VERIFY and ROLLBACK footers and `lock_timeout`. The destructive drop is pre-checked.

Recorded deviations:

```
DEVIATION L-3 / T-1 — Services are transaction scripts that issue SQL themselves; they are tested
  by integration tests against real PostgreSQL, not with a DB-free fake.
  Reason: this is the codebase's convention (README.md:56, authService.ts), and the properties that
  matter most (no double spend, lockout under concurrency, tenant isolation, staff caps) are
  properties of row locks and constraints that a fake cannot exhibit. All decision logic that does
  not need the database is extracted into pure modules with DB-free unit tests.
  Cost accepted: service tests need Docker PostgreSQL and run serially (--test-concurrency=1).
  Revisit when: a second persistence backend appears, or service logic grows branches the pure
  deciders do not cover.

DEVIATION L-4 — Services read and write TypeORM entities / raw rows directly; no separate domain
  model for cards or programs.
  Reason: consistent with User/Tenant/RefreshToken; a parallel domain model would be an identical
  shape (X-3). Pure deciders take small plain inputs ({ status, balance, isExpired }).
  Cost accepted: entity column renames ripple into services.
  Revisit when: card rules need behaviour richer than the deciders.

DEVIATION E-1 — Expected failures are thrown AppError subclasses, as in the rest of the codebase.
  Exception: operations that must COMMIT a state change and then fail (wrong PIN increments the
  counter or locks the card and writes an audit row; first touch of an expired card stores
  'expired') return a discriminated outcome from the transaction callback; the service throws only
  after the commit.
  Reason: consistency with error-handler.ts; the outcome form is used exactly where throwing inside
  the transaction would roll back the state change (precedent: AuthService.refresh,
  authService.ts:67-96).
  Cost accepted: two styles coexist, each with a stated reason.
  Revisit when: the codebase adopts result types generally.
```

## 5. File structure

Create:

| Path | Purpose |
|---|---|
| `src/migrations/1760000200000-DropLegacyGiftCardTables.ts` | Refuse if legacy rows exist; drop `transactions`, `gift_cards` and both enums |
| `src/migrations/1760000300000-AddGiftCards.ts` | New tables, constraints, indexes, ledger trigger, key-check table (7.1) |
| `src/migrations/1760000400000-AuditLogsAppendOnly.ts` | Append-only trigger on `audit_logs` |
| `src/entities/gift-card-program.ts`, `gift-card.ts`, `gift-card-transaction.ts`, `gift-card-delivery.ts`, `gift-card-key-check.ts`, `audit-log.ts` | Entities (7.1) |
| `src/gift-cards/card-number.ts` | Prefix rules, deny-list, generation, Luhn, normalization, PIN, reference |
| `src/gift-cards/money.ts` | Currencies with exponents, countries, region format |
| `src/gift-cards/program-rules.ts` | `validateProgramDefinition`, `validateProgramUpdate` |
| `src/gift-cards/card-state.ts` | Statuses, effective status, deciders |
| `src/gift-cards/card-crypto.ts` | `CardCrypto`, `CardCryptoError` |
| `src/gift-cards/delivery-token.ts` | Token, hash, TTL, link |
| `src/gift-cards/request-hash.ts` | Idempotency fingerprints |
| `src/gift-cards/mask.ts` | `maskEmail` |
| `src/services/sql.ts` | `returningRows` |
| `src/services/audit.ts` | `writeAudit` and typed entries |
| `src/services/cardKeyCheck.ts` | `verifyCardKeys` |
| `src/services/giftCardProgramService.ts`, `giftCardService.ts`, `redemptionService.ts`, `deliveryService.ts`, `deliveryDispatcher.ts` | Services |
| `src/delivery/log-only-sender.ts` | `LogOnlyDeliverySender` |
| `src/delivery/console-link-sender.ts` | `ConsoleLinkDeliverySender` (development only, 7.7) |
| `src/routes/giftCardProgramRoutes.ts`, `giftCardRoutes.ts`, `giftCardLinkRoutes.ts` | Routes (7.6) |
| `src/scripts/dispatch-deliveries.ts` | Cron entry point |
| `test/unit/card-number.test.ts`, `money.test.ts`, `program-rules.test.ts`, `card-state.test.ts`, `card-crypto.test.ts`, `delivery-token.test.ts`, `request-hash.test.ts`, `mask.test.ts` | Unit tests |
| `test/support/recording-delivery-sender.ts` | Captures messages; can throw or hang |
| `test/support/lock-staging.ts` | `waitUntilBlocked(adminQuery, n)`: polls `pg_stat_activity` for `wait_event_type = 'Lock'`; `openAdminTransaction()`: a dedicated `admin.createQueryRunner()` with explicit `startTransaction` / `query` / `commit` / `rollback` / `release`, for staged tests that must hold a transaction open (`adminQuery` runs each statement on the pool and cannot) |
| `test/integration/gift-card-schema.test.ts`, `gift-card-keys.test.ts`, `gift-card-programs.test.ts`, `gift-cards.test.ts`, `deliveries.test.ts`, `redemption.test.ts`, `redemption-concurrency.test.ts`, `gift-card-tenancy.test.ts`, `gift-card-leakage.test.ts` | Integration tests |

Modify:

| Path | Change |
|---|---|
| `src/config.ts` | A new `readGiftCardConfig` reader (not part of `readServerConfig`); `GiftCardConfig`; `loadDispatchConfig`. Production checks: published or low-entropy keys refused; `DB_LOGGING=true` refused (checked in `loadConfig` and `loadDispatchConfig`, where both values exist). Default `CORS_METHODS` gains `PATCH` |
| `src/data-source.ts` | Register the 6 entities |
| `src/app.ts` | `giftCards?: { deliverySender?, lockTimeoutMs?, sendTimeoutMs? }` option; build `CardCrypto`; `await verifyCardKeys`; build the dispatcher; register the routes; logger `redact` |
| `src/plugins/error-handler.ts` | `55P03` is retryable; DB errors logged as `{ code, constraint, table }` |
| `src/routes/schemas.ts` | Response schemas |
| `eslint.config.mjs` | Boundary override |
| `package.json` | `deliveries:dispatch`, `deliveries:dispatch:prod` |
| `.github/workflows/ci.yml` | CI-only card keys (values in 7.8) |
| `.env.example` | New variables |
| `test/integration/helpers.ts` | Fixed test keys (7.8); `buildTestApp(config, giftCardsOptions?)`; fixtures; `send()` `forbidden` option; ledger-invariant helper |
| `test/unit/config.test.ts` | Card keys in `validEnv`; a `prodEnv` with an https link URL and non-published keys for the production cases (:60-66); new cases |
| `test/unit/no-import-side-effects.test.ts` | New modules |
| `README.md` | Sections in 10.3 |

## 6. Data flow

Every transaction below is `app.db.transaction("READ COMMITTED", async (em) => ...)`.

- **"Commit then throw":** the callback returns an outcome, and the service throws only after the
  commit (the E-1 deviation).
- **"After rollback":** code that runs once `app.db.transaction(...)` has rejected, outside the
  callback, as a separate statement on the pool.

### 6.1 Redeem (representative request)

`POST /gift-cards/redeem` with body
`{ cardNumber, pin?, amount, idempotencyKey, externalReference? }`. The caller is admin or staff.

1. **`onRequest` hooks:** `authenticate`, `requireRole(ADMIN, STAFF)`, then a rate limiter keyed
   `user:<id>`.
2. **Ajv** validates shape with no coercion. `amount` is an integer 1..2147483647. `pin` matches
   `^[0-9]{6}$`.
3. **The service** is `redemptionService.redeem(request.user, body)`, with the tenant from
   `request.user.tenantId`.
4. **Normalize** with `normalizeCardNumber`.
   - On `null` the outcome is `auth_failed` (step 7).
   - Otherwise compute
     `hmac = cardCrypto.lookupHash(number)` and
     `requestHash = requestHashRedeem({ hmac, amount, externalReference })`.
5. **Transaction:**

   ```sql
   SET LOCAL lock_timeout = '<lockTimeoutMs>ms';   -- integer from options, not a parameter
   SELECT id, currency, balance, status, pin_enc, encryption_key_id, failed_pin_attempts,
          (pin_locked_until IS NOT NULL AND pin_locked_until > now()) AS pin_locked,
          (expires_at IS NOT NULL AND expires_at <= now())            AS is_expired
     FROM gift_cards
    WHERE tenant_id = $1 AND card_number_hmac = $2
      FOR UPDATE;
   ```

   a. **No row** -> `auth_failed`.

   b. **Authenticate:**
      `decidePinAttempt({ hasPin, providedPin, storedPin, failedAttempts, locked })`.
      - **Locked** -> `auth_failed`.
      - **PIN card, no PIN given** -> `auth_failed`. This does not count as an attempt.
      - **PIN card, wrong PIN** -> run
        ```sql
        UPDATE gift_cards SET failed_pin_attempts = $n,
          pin_locked_until = CASE WHEN $lock::boolean THEN now() + interval '30 minutes' ELSE NULL END,
          updated_at = now() WHERE id = $id
        ```
        On the 5th failure, also write the audit row `gift_card.pin_locked`. Then `auth_failed`,
        commit then throw.
      - **Correct PIN, or a PIN-less card** -> reset the attempt counter if it is above 0.

   c. **Idempotency:**
      `SELECT ... FROM gift_card_transactions WHERE tenant_id = $1 AND idempotency_key = $3`.
      - Equal hash -> `replay`.
      - Different hash -> `idempotency_conflict`.

   d. **Decide:** `decideRedeem({ status, balance, isExpired }, amount)`.
      - **Expired** -> `UPDATE ... SET status = 'expired' ... WHERE id = $id AND status <> 'expired'`.
        Then `expired`, commit then throw.
      - **Not active** -> `not_active`.
      - **Insufficient balance** -> `insufficient_balance`.
      - **OK** -> update the balance and insert the `redeem` ledger row, both through
        `returningRows`. Outcome: `redeemed`.
6. **Response mapping:**

   | Outcome | Response |
   |---|---|
   | `redeemed` | 201 |
   | `replay` | 200 + `Idempotent-Replayed: true` |
   | `auth_failed` | `NotFoundError(CARD_AUTH_FAILED)` |
   | `idempotency_conflict` | 409 "Idempotency key already used with a different request" |
   | `expired` | 409 "Card has expired" |
   | `not_active` | 409 "Card is not active" |
   | `insufficient_balance` | 409 "Insufficient balance" |

7. **`auth_failed` logging:** the route logs
   `request.log.warn({ userId, tenantId, route, outcome: "card_auth_failed" })`.
8. **Failure paths:**
   - **Lock timeout:** `55P03` -> 503 + `Retry-After: 1`.
   - **Concurrent use of the same key on a different card (after rollback).** The service catches
     the rejection of `app.db.transaction(...)` when `constraint === "gift_card_transactions_tenant_id_idempotency_key_key"`.
     The constraint is read from `err.constraint ?? err.driverError?.constraint`. It then runs one
     fresh `SELECT` of the key on `app.db`, outside any transaction:
     - equal hash -> replay;
     - different hash -> 409. For redeem this is always the case across cards, because the hash
       includes the HMAC.
     - no row -> throw `new Error("idempotency re-read found no row", { cause: err })`. A plain
       `Error` reaches the handler's 500 branch; rethrowing the `23505` itself would be mapped to 409.

     Every other error, including `23505` on any other constraint, propagates unchanged.
   - **`CardCryptoError`** -> 500, with only the card id logged.

**Oracle check.** Every card-state-dependent response (`replay`, `idempotency_conflict`,
`expired`, `not_active`, `insufficient_balance`) is reachable only after the card has been
authenticated.

**Accepted cost.** A retry on a card that is PIN-locked gets `CARD_AUTH_FAILED`.

**`POST /gift-cards/lookup`** runs steps 4, 5a-b and 7 only, then returns the card. An effectively
expired card is reported as `expired`, with no write.

### 6.2 Issue

`POST /gift-cards` with body
`{ programId, amount, idempotencyKey, recipient: { name, email }, senderName, message?, sendAt? }`.

**Before the transaction:**

- normalize the email with `normalizeEmail` and `assertValidEmail`;
- compute `requestHash = requestHashIssue({ actorUserId, ... })` (7.12).

**Transaction:**

1. **Lock the program:**
   `SELECT ... FROM gift_card_programs WHERE id = $1 AND tenant_id = $2 FOR SHARE`. No row -> 404.
2. **Staff only: take the advisory lock unconditionally:**
   `SELECT pg_advisory_xact_lock(hashtextextended('gift-card-issue:' || $programId::text || ':' || $userId::text, 0))`.
   - A concurrent same-key staff retry waits here. Its idempotency read (step 3) then sees the
     first request's commit, and it replays.
   - No other operation takes this lock.
3. **Idempotency:** look up `(tenant_id, idempotency_key)`.
   - Equal hash -> 200 replay, returning the existing card and delivery.
   - Different hash -> 409.
4. **Rules:** `decideIssue(program, caller, amount)`.

   | Condition | Response |
   |---|---|
   | Program retired | 409 |
   | Promotional program, staff caller | 403 |
   | Amount above `max_value` | 400 |
   | Staff caller, no staff limit set | 403 |

   For staff, the cap is checked in SQL:
   ```sql
   SELECT COALESCE(SUM(t.amount), 0) + $amount::int <= $limit::int AS ok
     FROM gift_card_transactions t JOIN gift_cards c ON c.id = t.gift_card_id
    WHERE t.tenant_id = $t AND t.actor_user_id = $u AND t.type = 'issue'
      AND c.program_id = $p AND t.created_at > now() - interval '24 hours'
   ```
   `false` -> 403 "Daily staff issue limit reached".
5. **New card id:** `SELECT uuidv7() AS id`.
6. **Generate and encrypt:**
   - generate the number, the PIN (if required) and the reference;
   - pre-check each for uniqueness with `SELECT 1`, regenerating up to 5 times;
   - encrypt with the AAD.
7. **Insert the card** with `status = 'active'`, `balance = initial_amount = $amount`, and
   `expires_at = CASE WHEN $m::int IS NULL THEN NULL ELSE now() + make_interval(months => $m::int) END`.
8. **Insert the `issue` ledger row.**
9. **Insert the delivery:**
   - require `$sendAt::timestamptz IS NULL OR $sendAt::timestamptz <= now() + interval '365 days'`,
     else 400;
   - insert with `send_at = next_attempt_at = COALESCE($sendAt::timestamptz, now())` and
     `status = 'scheduled'`.
10. **Audit and commit:** write `gift_card.issued`, then commit.

**After rollback.** The service catches rejections of `app.db.transaction(...)` with a `23505`
and branches on the constraint name:

- **`gift_card_transactions_tenant_id_idempotency_key_key`:** this is the concurrent admin
  double-submit, or a key collision across actors. The service runs one fresh read of the key,
  outside any transaction:
  - equal hash -> 200 replay, with `Idempotent-Replayed: true`;
  - different hash -> 409;
  - no row -> throw a plain `Error` with the original as `cause` (500, as in 6.1 step 8).
- **`gift_cards_card_number_hmac_key` or `gift_cards_tenant_id_reference_number_key`:** re-run the
  whole transaction, up to 3 times, then throw a plain `Error` with the last `23505` as `cause`
  (500; the bare `23505` would be mapped to 409).
- **Anything else** propagates unchanged.

**After commit:** `await dispatcher.dispatch({ deliveryId })`, which is bounded and never throws.
Then respond 201 with `{ card, delivery }`.

### 6.3 Delivery dispatch

**Constructor:**

```ts
new DeliveryDispatcher({
  db: DataSource,
  sender: GiftCardDeliverySender,
  linkBaseUrl: string,
  log: { info(o: object, m: string): void; warn(o: object, m: string): void },
  randomBytes?: (n: number) => Buffer,
  sendTimeoutMs?: number, // default 10_000; at most 60_000
})
```

- **`dispatch({ deliveryId?, limit = 50 })`** processes **one delivery per claim transaction**.
- **Lease:** 10 minutes, which must be at least `sendTimeoutMs` plus a margin.
- **Invariants:**
  - delivery UPDATEs never change `(gift_card_id, tenant_id)`;
  - the claim transaction never locks a card.

  Without these, an FK check would take FOR KEY SHARE on the card, and could deadlock with void.

1. **Claim.**

   ```sql
   SELECT d.id, c.status AS card_status,
          (c.expires_at IS NOT NULL AND c.expires_at <= now()) AS card_expired
     FROM gift_card_deliveries d
     JOIN gift_cards c ON c.id = d.gift_card_id AND c.tenant_id = d.tenant_id
    WHERE ($1::uuid IS NULL OR d.id = $1::uuid)
      AND ((d.status = 'scheduled' AND d.next_attempt_at <= now())
        OR (d.status = 'sending'   AND d.claimed_at < now() - interval '10 minutes'))
    ORDER BY d.next_attempt_at, d.id
    LIMIT 1
      FOR UPDATE OF d SKIP LOCKED;
   ```

   - **No row** -> stop.
   - **Card voided or effectively expired** -> set
     `status = 'cancelled', claimed_at = NULL, token_hash = NULL, token_expires_at = NULL, updated_at = now()`,
     commit, and continue.
   - **Otherwise:**
     1. Generate a token.
     2. Set `status = 'sending', claimed_at = now(), attempts = attempts + 1, token_hash = $h, token_expires_at = now() + interval '90 days', updated_at = now()`.
     3. Read the message data.
     4. Commit.
2. **Send.** `await raceTimeout(sender.send(message, signal), signal)`, with
   `signal = AbortSignal.timeout(sendTimeoutMs)`. The link is
   `linkBaseUrl + "#token=" + token`.
3. **Record the outcome.** The UPDATE is guarded by
   `WHERE id = $id AND status = 'sending' AND token_hash = $h`.
   - **Success:** set `status = 'sent'`, `sent_at` and clear `claimed_at`.
   - **Failure:**
     - `status = CASE WHEN attempts >= 5 THEN 'failed' ELSE 'scheduled' END`;
     - backoff `next_attempt_at = now() + make_interval(mins => power(2, attempts)::int)`;
     - `last_error = left($errName, 64)`;
     - clear `claimed_at`, and clear the token when the delivery becomes `failed`;
     - log `log.warn({ deliveryId, tenantId, attempt, errName }, ...)`.
4. **Crash between steps 1 and 3:** the row is reclaimed after 10 minutes with a new token.
   Delivery is at-least-once.

**Script.** `src/scripts/dispatch-deliveries.ts` runs every minute from cron:

- it loops `dispatch({ limit: 50 })` until a pass claims nothing;
- it loads `loadDispatchConfig(process.env)` and uses the app role;
- it uses `LogOnlyDeliverySender` (or `ConsoleLinkDeliverySender` when
  `GIFT_CARD_DEV_PRINT_LINKS=true`, see 7.7) and logs JSON lines to stdout.

### 6.4 Reveal

`POST /gift-card-links/reveal` with body `{ token }`. The route is public, limited to 30 per
minute per IP, and responds with `Cache-Control: no-store`.

```sql
SELECT d.id, d.recipient_name, d.sender_name, d.message, c.id AS card_id, c.tenant_id,
       c.card_number_enc, c.pin_enc, c.encryption_key_id, c.balance, c.currency, c.status,
       c.expires_at, (c.expires_at IS NOT NULL AND c.expires_at <= now()) AS is_expired,
       p.name AS program_name, t.name AS merchant_name
  FROM gift_card_deliveries d
  JOIN gift_cards c         ON c.id = d.gift_card_id AND c.tenant_id = d.tenant_id
  JOIN gift_card_programs p ON p.id = c.program_id AND p.tenant_id = c.tenant_id
  JOIN tenants t            ON t.id = c.tenant_id
 WHERE d.token_hash = $1 AND d.token_expires_at > now() AND c.status <> 'voided';
```

- **No row** -> 404 "Link is invalid or has expired".
- **Row found:**
  1. Update `opened_at = COALESCE(opened_at, now())`, increment `reveal_count`, and set
     `last_revealed_at` and `updated_at`.
  2. Decrypt the number and PIN, and respond.

The tenant comes from the delivery row.

## 7. Interfaces and contracts

### 7.1 Schema

- **Statuses and types** are `varchar` with a named `CHECK` (the pattern in
  AddRefreshTokens.ts:16-19).
- **Money** is `integer` minor units, up to 2,147,483,647.

**Migration `1760000300000-AddGiftCards`.** `up()` starts with `SET LOCAL lock_timeout = '5s'`.

```sql
CREATE TABLE "gift_card_programs" (
  "id"                       uuid         PRIMARY KEY DEFAULT uuidv7(),
  "tenant_id"                uuid         NOT NULL,
  "name"                     varchar(100) NOT NULL,
  "card_type"                varchar(16)  NOT NULL,
  "currency"                 char(3)      NOT NULL,
  "country"                  char(2)      NOT NULL,
  "region"                   varchar(6),
  "card_number_prefix"       varchar(6)   NOT NULL,
  "card_number_length"       smallint     NOT NULL,
  "pin_required"             boolean      NOT NULL,
  "max_value"                integer      NOT NULL,
  "expiry_months"            smallint,
  "staff_daily_issue_limit"  integer,
  "status"                   varchar(16)  NOT NULL DEFAULT 'active',
  "created_at"               timestamptz  NOT NULL DEFAULT now(),
  "updated_at"               timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT "gift_card_programs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id"),
  CONSTRAINT "gift_card_programs_tenant_id_name_key" UNIQUE ("tenant_id", "name"),
  CONSTRAINT "gift_card_programs_id_tenant_id_currency_key" UNIQUE ("id", "tenant_id", "currency"),
  CONSTRAINT "gift_card_programs_card_type_check" CHECK ("card_type" IN ('paid', 'promotional')),
  CONSTRAINT "gift_card_programs_status_check" CHECK ("status" IN ('active', 'retired')),
  CONSTRAINT "gift_card_programs_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "gift_card_programs_country_check" CHECK ("country" ~ '^[A-Z]{2}$'),
  CONSTRAINT "gift_card_programs_region_check" CHECK ("region" IS NULL OR
    ("region" ~ '^[A-Z]{2}-[A-Z0-9]{1,3}$' AND left("region", 2) = "country")),
  CONSTRAINT "gift_card_programs_prefix_check" CHECK ("card_number_prefix" ~ '^[7-9][0-9]{3,5}$'),
  CONSTRAINT "gift_card_programs_length_check" CHECK ("card_number_length" BETWEEN 16 AND 19),
  CONSTRAINT "gift_card_programs_pinless_length_check" CHECK ("pin_required" OR "card_number_length" = 19),
  CONSTRAINT "gift_card_programs_max_value_check" CHECK ("max_value" > 0),
  CONSTRAINT "gift_card_programs_expiry_check" CHECK ("expiry_months" IS NULL OR
    ("card_type" = 'promotional' AND "expiry_months" BETWEEN 1 AND 120)),
  CONSTRAINT "gift_card_programs_staff_limit_check" CHECK ("staff_daily_issue_limit" IS NULL OR
    ("card_type" = 'paid' AND "staff_daily_issue_limit" > 0))
);

CREATE TABLE "gift_cards" (
  "id"                  uuid         PRIMARY KEY DEFAULT uuidv7(),
  "tenant_id"           uuid         NOT NULL,
  "program_id"          uuid         NOT NULL,
  "currency"            char(3)      NOT NULL,
  "reference_number"    char(12)     NOT NULL,
  "card_number_enc"     bytea        NOT NULL,
  "card_number_hmac"    bytea        NOT NULL UNIQUE,
  "card_number_last4"   char(4)      NOT NULL,
  "pin_enc"             bytea,
  "encryption_key_id"   smallint     NOT NULL,
  "lookup_key_id"       smallint     NOT NULL,
  "initial_amount"      integer      NOT NULL,
  "balance"             integer      NOT NULL,
  "status"              varchar(16)  NOT NULL,
  "expires_at"          timestamptz,
  "failed_pin_attempts" smallint     NOT NULL DEFAULT 0,
  "pin_locked_until"    timestamptz,
  "issued_by"           uuid         NOT NULL,
  "created_at"          timestamptz  NOT NULL DEFAULT now(),
  "updated_at"          timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT "gift_cards_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants" ("id"),
  -- Tenant-consistency guarantee: a card's (tenant, currency) equals its program's.
  -- ON UPDATE NO ACTION also makes the program currency immutable once a card exists.
  CONSTRAINT "gift_cards_program_fkey" FOREIGN KEY ("program_id", "tenant_id", "currency")
    REFERENCES "gift_card_programs" ("id", "tenant_id", "currency"),
  CONSTRAINT "gift_cards_issued_by_fkey" FOREIGN KEY ("issued_by") REFERENCES "users" ("id"),
  CONSTRAINT "gift_cards_tenant_id_reference_number_key" UNIQUE ("tenant_id", "reference_number"),
  CONSTRAINT "gift_cards_id_tenant_id_key" UNIQUE ("id", "tenant_id"),
  CONSTRAINT "gift_cards_id_tenant_id_currency_key" UNIQUE ("id", "tenant_id", "currency"),
  CONSTRAINT "gift_cards_status_check" CHECK ("status" IN ('active', 'suspended', 'depleted', 'voided', 'expired')),
  CONSTRAINT "gift_cards_balance_check" CHECK ("balance" >= 0 AND "balance" <= "initial_amount"),
  CONSTRAINT "gift_cards_initial_amount_check" CHECK ("initial_amount" > 0),
  CONSTRAINT "gift_cards_status_balance_check" CHECK (
       ("status" IN ('active', 'suspended') AND "balance" > 0)
    OR ("status" IN ('depleted', 'voided') AND "balance" = 0)
    OR  "status" = 'expired'),
  CONSTRAINT "gift_cards_hmac_length_check" CHECK (octet_length("card_number_hmac") = 32),
  CONSTRAINT "gift_cards_last4_check" CHECK ("card_number_last4" ~ '^[0-9]{4}$'),
  CONSTRAINT "gift_cards_reference_check" CHECK ("reference_number" ~ '^[0-9A-HJKMNP-TV-Z]{12}$'),
  CONSTRAINT "gift_cards_pin_attempts_check" CHECK ("failed_pin_attempts" BETWEEN 0 AND 10),
  CONSTRAINT "gift_cards_pinless_lockout_check" CHECK ("pin_enc" IS NOT NULL OR
    ("failed_pin_attempts" = 0 AND "pin_locked_until" IS NULL))
);
CREATE INDEX "gift_cards_program_id_idx" ON "gift_cards" ("program_id");

CREATE TABLE "gift_card_transactions" (
  "id"                      uuid        PRIMARY KEY DEFAULT uuidv7(),
  "tenant_id"               uuid        NOT NULL,
  "gift_card_id"            uuid        NOT NULL,
  "currency"                char(3)     NOT NULL,
  "type"                    varchar(16) NOT NULL,
  "amount"                  integer     NOT NULL,
  "balance_after"           integer     NOT NULL,
  "related_transaction_id"  uuid,
  "idempotency_key"         varchar(64),
  "request_hash"            bytea,
  "external_reference"      varchar(64),
  "actor_user_id"           uuid        NOT NULL,
  "created_at"              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "gift_card_transactions_card_fkey" FOREIGN KEY ("gift_card_id", "tenant_id", "currency")
    REFERENCES "gift_cards" ("id", "tenant_id", "currency"),
  CONSTRAINT "gift_card_transactions_actor_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users" ("id"),
  CONSTRAINT "gift_card_transactions_tenant_id_idempotency_key_key" UNIQUE ("tenant_id", "idempotency_key"),
  CONSTRAINT "gift_card_transactions_id_gift_card_id_key" UNIQUE ("id", "gift_card_id"),
  CONSTRAINT "gift_card_transactions_related_fkey" FOREIGN KEY ("related_transaction_id", "gift_card_id")
    REFERENCES "gift_card_transactions" ("id", "gift_card_id"),
  CONSTRAINT "gift_card_transactions_type_check" CHECK ("type" IN ('issue', 'redeem', 'refund', 'void')),
  CONSTRAINT "gift_card_transactions_amount_check" CHECK ("amount" > 0),
  CONSTRAINT "gift_card_transactions_balance_after_check" CHECK ("balance_after" >= 0),
  CONSTRAINT "gift_card_transactions_related_check" CHECK (("type" = 'refund') = ("related_transaction_id" IS NOT NULL)),
  CONSTRAINT "gift_card_transactions_idempotency_check" CHECK (
    ("idempotency_key" IS NULL) = ("request_hash" IS NULL)
    AND (("type" = 'void') = ("idempotency_key" IS NULL)))
);
CREATE INDEX "gift_card_transactions_gift_card_id_created_at_idx" ON "gift_card_transactions" ("gift_card_id", "created_at");
CREATE INDEX "gift_card_transactions_related_transaction_id_idx" ON "gift_card_transactions" ("related_transaction_id");
CREATE INDEX "gift_card_transactions_actor_user_id_created_at_idx" ON "gift_card_transactions" ("actor_user_id", "created_at");

CREATE FUNCTION "gift_card_transactions_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'gift_card_transactions is append-only' USING ERRCODE = 'restrict_violation';
END $$;
CREATE TRIGGER "gift_card_transactions_no_update_delete"
  BEFORE UPDATE OR DELETE ON "gift_card_transactions"
  FOR EACH ROW EXECUTE FUNCTION "gift_card_transactions_append_only"();

CREATE TABLE "gift_card_deliveries" (
  "id"               uuid         PRIMARY KEY DEFAULT uuidv7(),
  "tenant_id"        uuid         NOT NULL,
  "gift_card_id"     uuid         NOT NULL UNIQUE,
  "recipient_name"   varchar(100) NOT NULL,
  "recipient_email"  varchar(254) NOT NULL,
  "sender_name"      varchar(100) NOT NULL,
  "message"          varchar(500),
  "send_at"          timestamptz  NOT NULL,
  "status"           varchar(16)  NOT NULL DEFAULT 'scheduled',
  "attempts"         smallint     NOT NULL DEFAULT 0,
  "next_attempt_at"  timestamptz  NOT NULL,
  "claimed_at"       timestamptz,
  "last_error"       varchar(64),
  "sent_at"          timestamptz,
  "opened_at"        timestamptz,
  "reveal_count"     integer      NOT NULL DEFAULT 0,
  "last_revealed_at" timestamptz,
  "token_hash"       bytea        UNIQUE,
  "token_expires_at" timestamptz,
  "created_by"       uuid         NOT NULL,
  "created_at"       timestamptz  NOT NULL DEFAULT now(),
  "updated_at"       timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT "gift_card_deliveries_card_fkey" FOREIGN KEY ("gift_card_id", "tenant_id")
    REFERENCES "gift_cards" ("id", "tenant_id"),
  CONSTRAINT "gift_card_deliveries_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users" ("id"),
  CONSTRAINT "gift_card_deliveries_status_check" CHECK ("status" IN ('scheduled', 'sending', 'sent', 'failed', 'cancelled')),
  CONSTRAINT "gift_card_deliveries_attempts_check" CHECK ("attempts" BETWEEN 0 AND 100),
  CONSTRAINT "gift_card_deliveries_reveal_count_check" CHECK ("reveal_count" >= 0),
  CONSTRAINT "gift_card_deliveries_token_pair_check" CHECK (("token_hash" IS NULL) = ("token_expires_at" IS NULL)),
  CONSTRAINT "gift_card_deliveries_token_hash_length_check" CHECK ("token_hash" IS NULL OR octet_length("token_hash") = 32),
  CONSTRAINT "gift_card_deliveries_claimed_check" CHECK (("status" = 'sending') = ("claimed_at" IS NOT NULL)),
  CONSTRAINT "gift_card_deliveries_cancelled_token_check" CHECK ("status" NOT IN ('cancelled', 'failed') OR "token_hash" IS NULL)
);
CREATE INDEX "gift_card_deliveries_due_idx" ON "gift_card_deliveries" ("status", "next_attempt_at");

-- Non-secret key check values (KCV) per configured key id; never the keys themselves
CREATE TABLE "gift_card_key_checks" (
  "purpose"      varchar(16) NOT NULL,
  "key_id"       smallint    NOT NULL,
  "check_value"  bytea       NOT NULL,
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "gift_card_key_checks_pkey" PRIMARY KEY ("purpose", "key_id"),
  CONSTRAINT "gift_card_key_checks_purpose_check" CHECK ("purpose" IN ('encryption', 'lookup')),
  CONSTRAINT "gift_card_key_checks_length_check" CHECK (octet_length("check_value") = 16)
);
```

- **`down()`** drops the four gift-card tables, the trigger function and
  `gift_card_key_checks`.
- **PRE-CHECK:** `SELECT to_regclass('public.gift_cards')` -> NULL.
- **VERIFY:**
  - `\d` on each table shows the constraint names above;
  - `pg_trigger` lists `gift_card_transactions_no_update_delete`;
  - `information_schema.table_privileges` shows SELECT, INSERT, UPDATE and DELETE on all five
    tables for the app role.
- **ROLLBACK:** `down()`. Once real cards exist, the fix is forward-only.

**Migration `1760000200000-DropLegacyGiftCardTables`.**

- `up()` runs, in order:
  1. `SET LOCAL lock_timeout = '5s'`.
  2. A `DO` block that raises
     `'legacy gift_cards/transactions contain rows; export or delete them first'` if either table
     has a row (expected: 0).
  3. Drops `"transactions"`, `"gift_cards"`, `"transaction_type"` and `"gift_card_status"`.
- `down()` recreates them exactly as in InitialSchema.ts:9-74.
- O-7: no running code references them.

**Migration `1760000400000-AuditLogsAppendOnly`.**

- `up()`:
  1. `SET LOCAL lock_timeout = '5s'`;
  2. creates function `audit_logs_append_only()`;
  3. creates trigger `audit_logs_no_update_delete`: BEFORE UPDATE OR DELETE, FOR EACH ROW.
- `down()` drops both.
- VERIFY: query `pg_trigger`.

**Tenant-consistency mechanism.** Each child row references its parent through a composite FK that
includes `tenant_id`, plus `currency` where the currencies must match. Each FK targets a composite
unique key on the parent. The database therefore rejects:

- a card pointing at another tenant's program, or carrying another currency;
- a ledger row pointing at another tenant's card, or carrying another currency;
- a delivery pointing at another tenant's card;
- a refund pointing at another card's transaction.

User references point at `users(id)` only. They are consistent by construction, because the user
and the tenant come from the same token.

**Entities.** `GiftCardProgram`, `GiftCard`, `GiftCardTransaction`, `GiftCardDelivery`,
`GiftCardKeyCheck` and `AuditLog`. None extends `ExtendedBaseEntity`, and none has relation
properties.

- **Decorators:**
  - class-level `@ForeignKey(() => Target, [cols], [refCols], { name })`;
  - `@Unique(name, [props])`;
  - `@Check(name, expr)`;
  - `@Index(name, [props])`;
  - `unique: true` for single-column uniques.
- **`select: false` columns:**
  - `GiftCard`: `card_number_enc`, `card_number_hmac`, `pin_enc`;
  - `GiftCardDelivery`: `token_hash`;
  - `GiftCardTransaction`: `request_hash`.
- **`AuditLog`:**
  - FKs `audit_logs_tenant_id_fkey` and `audit_logs_user_id_fkey`;
  - indexes `audit_logs_tenant_id_idx` and `audit_logs_user_id_idx`;
  - nullable `tenant_id` and `user_id`;
  - `action` varchar(100);
  - `details` with `type: "jsonb", nullable: true`.

### 7.2 Card-number generation (`src/gift-cards/card-number.ts`)

```ts
export const NETWORK_DENYLIST_PREFIXES = ["81", "82", "9792"] as const; // RuPay 81/82, Troy 9792
export function programNumberingProblems(prefix: string, length: number, pinRequired: boolean): string[];
export function generateCardNumber(prefix: string, length: number, randomInt: (max: number) => number): string;
export function luhnCheckDigit(payload: string): number;
export function isLuhnValid(digits: string): boolean;
export function normalizeCardNumber(input: string): string | null;
export const PIN_LENGTH = 6;
export function generatePin(randomInt: (max: number) => number): string;
export function generateReferenceNumber(randomInt: (max: number) => number): string;
export function normalizeReferenceNumber(input: string): string | null;
```

- **Prefix.** 4 to 6 digits.
  - The first digit must be 7, 8 or 9. These ISO/IEC 7812 industry identifiers sit outside the
    banking range 2 to 6, which covers Visa 4, Mastercard 2 and 5, Amex 34 and 37, Discover
    6011, 644-649 and 65, UnionPay 62, JCB 35, Diners 30, 36 and 38, and Maestro 50 and 56-69.
  - The prefix must not appear on the deny-list. The list is best effort, not a BIN registry.
- **Length.** 16 to 19 digits; a PIN-less card must be 19. That leaves 9 to 14 random digits.
- **Generation.**
  - Each digit is `randomInt(10)`. The default is `crypto.randomInt`, which is uniform by
    rejection sampling, so there is no modulo bias.
  - A Luhn check digit is appended.
  - Uniqueness comes from a global unique HMAC index, plus a pre-check with up to 5 retries.
- **Normalization.** Strip spaces and hyphens. The result must match `^[0-9]{16,19}$` and pass
  Luhn; otherwise the function returns `null`.
- **Reference.**
  - 12 Crockford base32 characters (60 bits), displayed as `XXXX-XXXX-XXXX`.
  - Normalization uppercases, strips hyphens and maps `O->0` and `I/L->1`.
  - Unique per tenant. It authorizes nothing.
- **PIN.** 6 random digits.

### 7.3 Crypto design (`src/gift-cards/card-crypto.ts`)

```ts
export interface CardKey { id: number; key: Buffer }       // id 1..32767, key 32 bytes
export type SecretPurpose = "number" | "pin";
export class CardCryptoError extends Error {}               // fixed messages, no data
export class CardCrypto {
  constructor(keys: { encryption: CardKey; lookup: CardKey },
              randomBytes: (n: number) => Buffer = crypto.randomBytes);
  readonly encryptionKeyId: number;
  readonly lookupKeyId: number;
  lookupHash(normalizedNumber: string): Buffer;
  encrypt(purpose: SecretPurpose, ids: { tenantId: string; cardId: string }, plaintext: string): Buffer;
  decrypt(purpose: SecretPurpose, ids: { tenantId: string; cardId: string }, keyId: number, blob: Buffer): string;
  keyCheckValues(): { purpose: "encryption" | "lookup"; keyId: number; checkValue: Buffer }[];
}
```

- **Encryption.** AES-256-GCM. It is an AEAD (confidentiality and integrity in one primitive),
  built into `node:crypto` and hardware-accelerated.
  - CBC+HMAC would mean composing two primitives.
  - ChaCha20-Poly1305 would be equally sound; GCM is the common audit expectation.
- **IV.** 12 random bytes per encryption. That is safe up to about 2^32 encryptions per key
  (NIST SP 800-38D).
- **Tag.** 16 bytes, length-checked before `setAuthTag`.
- **AAD.** `utf8("gift-card:v1:" + purpose + ":" + tenantId + ":" + cardId + ":" + keyId)`. A copy
  to another row, a swap between number and PIN, or an edit to the key id all make decryption
  fail.
- **Blob layout.** `0x01` || IV(12) || tag(16) || ciphertext.
- **Decrypt failures.** A bad version, an unknown key id, a short blob or a tag mismatch throws
  `CardCryptoError`. The request returns 500, and the log records `{ cardId, errName }` only.
- **Lookup.** HMAC-SHA256 under the separate lookup key, over
  `utf8("gift-card-number:v1:" + digits)`.
  - It is keyed because the candidate space is only 10^9 to 10^14.
  - It is deterministic, so it can back the unique index.
  - The key is separate, so a leak of one key does not break the other.
- **Key check values.**
  ```
  subkey     = Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), "gift-card-key-check:v1:" + purpose, 32))
  checkValue = first16(HMAC-SHA256(subkey, "kcv:" + keyId))
  ```
  `hkdfSync` returns an `ArrayBuffer`, hence the `Buffer.from`.
- **Key storage.** Keys are never in the DB; only ids and check values are.
  - `CardCrypto` maps each `keyId` to its key.
  - Rotation (deferred) will add entries: decrypt with old ids, encrypt with the current id, and
    look up with the current id first.
- **Constructor (B-2).** Rejects keys that are not 32 bytes, ids outside 1..32767, and equal keys.
- **PIN check.** `crypto.timingSafeEqual` on equal-length buffers. A length mismatch counts as
  wrong.
- **Threat model** (README).
  - **Covers** read-only exposure of the database: backups, replicas, read-only SQL injection,
    logs of SQL parameters.
  - **Does not cover** an attacker with write access through the app role. They can already edit
    balances, and could plant a token hash and use reveal.
  - App-role credentials are therefore protected like the card keys.

### 7.4 Program rules and immutability

`validateProgramDefinition(input)` returns `{ ok: true, value }` or `{ ok: false, problems }`. It
checks:

- **`currency`:** in `SUPPORTED_CURRENCIES`: `CAD 2, USD 2, AED 2, SAR 2, QAR 2, KWD 3, BHD 3,
  OMR 3`.
- **`country`:** format `^[A-Z]{2}$` **and** in the known list `SUPPORTED_COUNTRIES`
  (`CA, AE, SA, KW, BH, OM, QA`). A known list, not just a regex, because adding a market should
  be a deliberate change that follows legal review.
- **`region`:** optional ISO 3166-2, regex `^[A-Z]{2}-[A-Z0-9]{1,3}$`. Its first two letters must
  equal `country`. Regex only: no subdivision list is needed until there is a per-region rule.
- **Numbering:** checked by `programNumberingProblems`.
- **`maxValue`:** 1 to 2,000,000,000.
- **`expiryMonths`:** promotional cards only, 1 to 120. Paid cards never expire, and there are no
  fees.
- **`staffDailyIssueLimit`:** `null` (staff may not issue) or 1 to 2,000,000,000; paid programs
  only.

Field mutability after the first card is issued:

| Field | After the first card |
|---|---|
| `cardType`, `currency`, `country`, `region`, `cardNumberPrefix`, `cardNumberLength` | Immutable |
| `name`, `maxValue`, `staffDailyIssueLimit`, `status` | Mutable |
| `pinRequired` | Mutable; applies to new cards only, and must keep the 19-digit rule |
| `expiryMonths` | Mutable; applies to new cards only |

**Lock protocol:**

- `updateProgram` takes `FOR UPDATE` on the program, then checks
  `SELECT EXISTS (SELECT 1 FROM gift_cards WHERE program_id = $1)`. If cards exist and an
  immutable field changes, it returns 409.
- Issue takes `FOR SHARE`, so the two serialize either way.

**Audit:**

- `gift_card_program.created { programId }`;
- `gift_card_program.updated { programId, changes: [{ field, from, to }] }`.

### 7.5 State machine (`src/gift-cards/card-state.ts`)

**Stored statuses:** `active`, `suspended`, `depleted`, `voided`, `expired`.

**Effective status:** `'expired'` when `isExpired` (computed in SQL) and the stored status is
active, suspended or depleted. Otherwise it is the stored status.

| From (effective) | Event | To | Side effects | Who |
|---|---|---|---|---|
| (none) | issue | active | `issue` | ADMIN; STAFF on `paid` programs with a staff limit, within it |
| active | redeem, new balance > 0 | active | `redeem` | ADMIN, STAFF |
| active | redeem, new balance = 0 | depleted | `redeem` | ADMIN, STAFF |
| active, depleted | refund of a redeem of this card | active | `refund` | ADMIN |
| active | suspend | suspended | audit | ADMIN |
| suspended | resume | active | audit | ADMIN |
| active, suspended, depleted, expired | void | voided | `void` of the remaining balance if > 0; delivery `cancelled` and token cleared; audit | ADMIN |
| active, suspended, depleted | first mutating touch after `expires_at` | expired | No ledger row; the balance is kept | system |
| voided | anything | 409 | | |
| expired | anything except void | 409 "Card has expired" | | |

- **Idempotent targets:** suspend on a suspended card, resume on an active card and void on a
  voided card each return 200.
- **Unlock** (ADMIN) clears the lockout in any status and writes an audit row.

**Void.**

1. Lock the card with FOR UPDATE.
2. If the balance is above 0, insert a `void` ledger row.
3. Set the balance to 0, the status to voided, and `updated_at`.
4. Cancel the delivery:
   ```sql
   UPDATE gift_card_deliveries SET status = 'cancelled', claimed_at = NULL, token_hash = NULL,
     token_expires_at = NULL, updated_at = now()
    WHERE gift_card_id = $id AND tenant_id = $t AND status <> 'cancelled'
   ```
5. Write the audit row.

**Pure deciders:** `effectiveStatus`, `decideIssue`, `decideRedeem`, `decideRefund`,
`decideSuspend`, `decideResume`, `decideVoid`, `decidePinAttempt`.

**PIN lockout.**

- After 5 failures, the card locks for 30 minutes, the counter resets, and an audit row records
  the actor.
- While locked, the card returns the generic failure.
- A correct PIN resets the counter. A missing PIN does not count.
- The card row lock is held throughout.
- Staff see `pinLocked`.

**Refund** (`POST /gift-card-transactions/:id/refunds`).

1. Read the transaction by id and tenant. Not found -> 404.
2. Lock the card with FOR UPDATE.
3. Check idempotency.
4. The transaction must be a `redeem`, otherwise 409.
5. Check in SQL that `COALESCE(SUM(refunds), 0) + $amount::int <= $redeemAmount::int`.
6. The card's effective status must be active or depleted.
7. Credit the card and insert the `refund` row.

### 7.6 Endpoints

**Conventions:**

- all bodies set `additionalProperties: false`;
- params use `format: "uuid"`;
- card numbers, PINs and tokens are sent only in bodies;
- errors are `{ error }`;
- `CARD_AUTH_FAILED = "Invalid card number or PIN"`.

| Method | Path | Role | Body | Success | Errors | Rate limit |
|---|---|---|---|---|---|---|
| POST | `/gift-card-programs` | admin | `{ name, cardType, currency, country, region?, cardNumberPrefix, cardNumberLength, pinRequired, maxValue, expiryMonths?, staffDailyIssueLimit? }` | 201 program | 400, 409 | global |
| GET | `/gift-card-programs` | admin, staff | | 200 programs | | global |
| GET | `/gift-card-programs/:id` | admin, staff | | 200 program | 404 | global |
| PATCH | `/gift-card-programs/:id` | admin | non-empty subset (`expiryMonths`, `region`, `staffDailyIssueLimit` nullable) | 200 program | 400, 404, 409 | global |
| POST | `/gift-cards` | admin, staff | `{ programId, amount, idempotencyKey, recipient: { name, email }, senderName, message?, sendAt? }` | 201 `{ card, delivery }`; replay 200 | 400, 403, 404, 409 | 60/min per user |
| GET | `/gift-cards/:id` | admin, staff | | 200 `{ card, delivery }` | 404 | global |
| GET | `/gift-cards/by-reference/:reference` | admin, staff | | 200 `{ card, delivery }` | 404 | global |
| GET | `/gift-cards/:id/transactions` | admin, staff | | 200 ledger rows | 404 | global |
| POST | `/gift-cards/lookup` | admin, staff | `{ cardNumber, pin? }` | 200 `{ card }` | 404 | 30/min per user |
| POST | `/gift-cards/redeem` | admin, staff | `{ cardNumber, pin?, amount, idempotencyKey, externalReference? }` | 201 `{ transaction, card }`; replay 200 | 404, 409, 503 | 30/min per user |
| POST | `/gift-card-transactions/:id/refunds` | admin | `{ amount, idempotencyKey }` | 201; replay 200 | 400, 404, 409 | global |
| POST | `/gift-cards/:id/suspend` | admin | | 200 | 404, 409 | global |
| POST | `/gift-cards/:id/resume` | admin | | 200 | 404, 409 | global |
| POST | `/gift-cards/:id/void` | admin | | 200 | 404 | global |
| POST | `/gift-cards/:id/unlock` | admin | | 200 | 404 | global |
| POST | `/gift-cards/:id/resend` | admin, staff | `{ recipient?: { name?, email? } }` (a recipient change is admin only) | 200 `{ delivery }` | 403, 404, 409 | 10/min per user |
| POST | `/gift-card-links/reveal` | public | `{ token }` | 200 reveal | 404 | 30/min per IP |

**Field rules:**

| Field | Rule |
|---|---|
| `idempotencyKey` | `^[A-Za-z0-9_-]{16,64}$` |
| amounts | integer >= 1 |
| `cardNumber` | `^[0-9][0-9 -]{14,26}[0-9]$` |
| `pin` | `^[0-9]{6}$` |
| `token` | `^[A-Za-z0-9_-]{43}$` |
| names | 1-100 characters, no control characters |
| `message` | 0-500 characters; newlines allowed, other control characters not |
| `recipient.email` | `normalizeEmail` + `assertValidEmail` |
| `sendAt` | `date-time` |
| `externalReference` | 1-64 printable characters |

**Response shapes.**

- **Program:** `id, name, cardType, currency, currencyExponent, country, region,
  cardNumberPrefix, cardNumberLength, pinRequired, maxValue, expiryMonths,
  staffDailyIssueLimit, status, hasIssuedCards, createdAt, updatedAt`.
- **Card:** `id, programId, referenceNumber, last4, currency, currencyExponent, initialAmount,
  balance, status (effective), hasPin, expiresAt, pinLocked, createdAt, updatedAt`. Never the
  number, the PIN, ciphertexts, the HMAC or key ids.
- **Delivery:** `id, recipientName, recipientEmail, senderName, message, sendAt, status, attempts,
  sentAt, openedAt, revealCount, lastRevealedAt`.
- **Transaction:** `id, giftCardId, type, amount, currency, balanceAfter, relatedTransactionId,
  externalReference, actorUserId, createdAt`.
- **Reveal:** `cardNumber, pin, balance, currency, currencyExponent, status, expiresAt,
  programName, merchantName, recipientName, senderName, message`.

**Per-user rate limits:**
`rateLimit: { max, timeWindow: "1 minute", keyGenerator: (req) => "user:" + req.user.id }`.

**Roles.**

- **ADMIN:** everything.
- **STAFF:**
  - read programs;
  - issue paid cards within a program's staff limit, where an admin has set one;
  - read cards and ledgers;
  - lookup and redeem;
  - resend to the same recipient.
- **ADMIN only:**
  - program create and update;
  - issuing promotional cards;
  - refund;
  - suspend, resume, void and unlock;
  - changing the recipient on a resend.

### 7.7 Delivery

```ts
export interface GiftCardDeliveryMessage {
  deliveryId: string; tenantId: string;
  to: { name: string; email: string };
  senderName: string; message: string | null;
  merchantName: string; programName: string;
  amount: number; currency: string; currencyExponent: number;
  link: string;                       // contains the raw token; never logged
}
export interface GiftCardDeliverySender {
  send(message: GiftCardDeliveryMessage, signal: AbortSignal): Promise<void>; // throws on failure
}
```

**Log-only sender.** `LogOnlyDeliverySender(log)` logs `{ deliveryId, tenantId, recipientDomain }`
only.

**Development console sender.** `ConsoleLinkDeliverySender` writes `{ deliveryId, to, link }` with
`console.log` (not the Fastify logger, so redaction is not involved) so a developer can open the
link by hand.

- Selected only when `GIFT_CARD_DEV_PRINT_LINKS=true`, in both `buildApp` and the dispatch script.
- Config refuses `GIFT_CARD_DEV_PRINT_LINKS=true` unless `NODE_ENV=development` (so never in
  `test` or `production`); the leakage tests therefore never see it.
- Unit test: config rejects it under `production` and `test`. Integration test: not needed.

**Token.**

- 32 random bytes, base64url (43 characters), the same as refresh tokens (src/tokens.ts:12-14).
- Stored as its SHA-256 hash.
- TTL of 90 days, computed in SQL (decided with the user: gifts are often opened late and the
  recipient cannot request a resend themselves).
- Reusable until it expires, a resend replaces it, or the card is voided.

**Link.** `GIFT_CARD_LINK_BASE_URL + "#token=" + token`. The token is in the URL fragment.

**Landing-page requirements** (README):

- strip the fragment with `history.replaceState`;
- POST the token to the reveal endpoint;
- render every field with `textContent`, never `innerHTML`;
- strict CSP;
- no third-party scripts;
- the page's origin is listed in `CORS_ORIGIN`.

**Resend.**

1. Lock the card (`id`, `tenant_id`) FOR UPDATE.
2. If its effective status is voided or expired, return 409.
3. Lock the delivery (`gift_card_id`, `tenant_id`) FOR UPDATE.
4. Reset the delivery: clear the token, set it `scheduled` with `next_attempt_at = now()`, zero
   `attempts`, clear `claimed_at` and `last_error`, and set `updated_at`. An admin may also change
   the recipient.
5. Write the audit row `gift_card_delivery.resent`, with the old and new recipient emails masked.
6. Commit, then dispatch.

### 7.8 Config / env additions (`src/config.ts`)

| Variable | Required | Default | Validation |
|---|---|---|---|
| `CARD_ENCRYPTION_KEY` | yes | none | 64 hex characters (32 bytes), at least 16 distinct byte values |
| `CARD_ENCRYPTION_KEY_ID` | no | `1` | integer 1..32767 |
| `CARD_LOOKUP_KEY` | yes | none | same rules; must differ from the encryption key |
| `CARD_LOOKUP_KEY_ID` | no | `1` | integer 1..32767 |
| `GIFT_CARD_LINK_BASE_URL` | yes in production | `http://localhost:3000/gift` | valid URL; `https:` in production; no fragment |
| `GIFT_CARD_DEV_PRINT_LINKS` | no | `false` | boolean; `true` is refused unless `NODE_ENV=development` |
| `CORS_METHODS` (existing) | no | now `GET,POST,PUT,PATCH,DELETE` | |
| `DB_LOGGING` (existing) | no | `false` | `true` is refused when `NODE_ENV=production` |

**Placement.**

- A new `readGiftCardConfig(env, read)` reads the six new variables.
- `loadConfig` calls it alongside `readDbConfig` and `readServerConfig`.
- `loadServerConfig` does **not** call it, so config.test.ts:145 keeps passing.
- The `DB_LOGGING` × `NODE_ENV` check runs in `loadConfig` and `loadDispatchConfig`, the only
  places that hold both values.
- `loadDispatchConfig(env)` returns `DbConfig & { giftCardLinkBaseUrl; nodeEnv }`.

**Hex, not base64.** Keys are hex because base64 decoding silently skips invalid characters.
Generate one with:

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Fixed non-secret keys.** These are listed in `PUBLISHED_NON_SECRET_KEYS` and refused in
production:

| Key | Value |
|---|---|
| Test encryption key | `sha256("gift-card-test-encryption-key")` in hex (31 distinct bytes) |
| Test lookup key | `sha256("gift-card-test-lookup-key")` in hex (27 distinct bytes) |
| CI keys | `sha256("gift-card-ci-encryption-key")` and `sha256("gift-card-ci-lookup-key")` |

**Phase 1 checks:**

- the CI key values pass the 16-distinct-byte rule;
- `"0123456789abcdef".repeat(4)` (8 distinct bytes) is rejected.

**Production test fixtures.** `test/unit/config.test.ts` gains a `prodEnv` with an https link URL
and keys that are not on the published list, for the production cases at :60-66.

**Error messages** name the variable and never echo its value.

### 7.9 Logging redaction

- No secrets appear in URLs.
- **Error handler.** On the 503 and 500 paths, an error with a PG `code` (on the error or on
  `driverError`) is logged as `{ err: { name, code, constraint, table } }`.
- **`buildApp`** merges into the logger options, including caller-supplied loggers:
  `redact: { paths: ["err.detail", "err.where", "err.parameters", "err.query", "err.driverError"], censor: "[REDACTED]" }`.
- Raw secrets are never SQL parameters.
- `DB_LOGGING` is refused in production.
- **Fixed log fields:**
  - `CardCryptoError` messages are fixed;
  - the dispatcher logs `{ deliveryId, tenantId, attempt, errName }`;
  - `auth_failed` logs `{ userId, tenantId, route, outcome }`.

### 7.10 Error-handling mapping

| Condition | Status | Body |
|---|---|---|
| Ajv validation | 400 | Fastify message |
| Unknown program, card or transaction | 404 | specific "not found" |
| Number not normalizable, no card, wrong or missing PIN, locked | 404 | `CARD_AUTH_FAILED` |
| Invalid or expired token, or voided card | 404 | "Link is invalid or has expired" |
| Role, promotional by staff, no staff limit, limit reached | 403 | specific |
| Retired program, state conflict, insufficient balance, refund over limit, immutable field, idempotency conflict | 409 | specific |
| `23505` on any constraint the services don't handle | 409 | "Already exists" |
| `40001`, `40P01`, `55P03` | 503 + `Retry-After: 1` | "Temporary conflict, please retry" |
| `CardCryptoError`, anything else | 500 | "Internal Server Error" |

### 7.11 Audit (`src/services/audit.ts`)

```ts
type AuditEntry =
  | { action: "gift_card_program.created"; details: { programId: string } }
  | { action: "gift_card_program.updated"; details: { programId: string;
      changes: { field: string; from: string | number | boolean | null; to: string | number | boolean | null }[] } }
  | { action: "gift_card.issued"; details: { giftCardId: string; programId: string; amount: number } }
  | { action: "gift_card.suspended" | "gift_card.resumed" | "gift_card.unlocked" | "gift_card.pin_locked";
      details: { giftCardId: string } }
  | { action: "gift_card.voided"; details: { giftCardId: string; voidedAmount: number } }
  | { action: "gift_card_delivery.resent"; details: { giftCardId: string; deliveryId: string;
      recipientChanged: boolean; previousRecipient?: string; newRecipient?: string } }; // masked emails
export function writeAudit(em: EntityManager, ctx: { tenantId: string; userId: string | null },
                           entry: AuditEntry): Promise<void>;
```

- **Same transaction:** audit rows are written in the same transaction as the change.
- **Append-only:** enforced by migration 1760000400000.
- **Retention:** indefinite, with masked emails only. Redaction needs the owner role and a one-off
  migration; the README documents the procedure.
- **Not duplicated:** the ledger already holds redeem and refund, with the actor.
- **Reveals** are counted on the delivery row.
- **Failed authentication** is logged per actor; it is audited only when it causes a lock.

### 7.12 Request hashes (`src/gift-cards/request-hash.ts`)

`sha256(utf8(JSON.stringify(["v1", ...fields])))`. Absent fields are `null` and amounts are
integers. JSON array encoding cannot collide.

| Operation | Fields after `"v1"` |
|---|---|
| Redeem | `"redeem"`, hex(hmac), amount, externalReference |
| Issue | `"issue"`, actorUserId, programId, amount, normalized recipient email, recipient name, sender name, message, `new Date(sendAt).toISOString()` or `null` |
| Refund | `"refund"`, transactionId, amount |

Because the issue hash includes `actorUserId`, a second user who reuses someone else's key gets
409, not a replay of their card.

### 7.13 Key verification at startup (`src/services/cardKeyCheck.ts`)

`verifyCardKeys(db, cardCrypto)` runs in `buildApp` before any route is registered. For each
check value:

1. Read the stored check value for `(purpose, key_id)`.
2. **If a row exists:** compare with `timingSafeEqual`. On a mismatch, throw
   `"CARD_<...>_KEY does not match the key recorded for key id <n>; use the original key or a new key id"`.
3. **If there is no row:**
   - if `gift_cards` rows already use that key id, throw
     `"No key check recorded for CARD_<...>_KEY id <n> although cards use it; restore gift_card_key_checks or follow the README key-check reset procedure"`;
   - otherwise `INSERT ... ON CONFLICT DO NOTHING`, re-read, and compare as in step 2. Two first
     boots at once converge: the first writer wins.

On any failure, `buildApp` closes and rethrows, and `src/index.ts` exits with "Startup failed".

**Reset procedure (README).** The admin role deletes the row. This is valid only when no card uses
that id, and the boot check enforces it.

## 8. Failure modes

| Failure | Detection | Behaviour | Class |
|---|---|---|---|
| Concurrent redeems on one card | `FOR UPDATE` | serialized; no overdraw | handled |
| Client retry after a lost response | unique key + `request_hash`, checked after authentication and before mutable rules | replay or 409 | handled |
| Concurrent same-key staff issue near the cap | advisory lock taken before the idempotency check | replay | handled |
| Concurrent same-key admin issue | `23505`, then a fresh read after rollback, matched on constraint name | 201 + 200 replay | handled |
| Same key used concurrently on two cards | `23505`, then a fresh read after rollback | 409 | handled |
| Card-row lock wait | `lock_timeout` -> `55P03` | 503 | degrade |
| Card-number or reference collision | pre-check + unique index | regenerate / retry; then plain `Error` with `cause` -> 500 | fail loud |
| PIN brute force | counter under the row lock | lock + generic error + audit | handled |
| Lockout used as a DoS by a cashier | audit with actor; `pinLocked` | admin unlocks | accepted |
| Existence oracle via idempotency key | authentication runs first | generic 404 | handled |
| Enumeration or probing by staff | per-user limit; `card_auth_failed` log | alerting on volume is possible | accepted |
| Timing difference between not-found and wrong-PIN | n/a | accepted residual | accepted |
| Staff issuing unpaid value | staff limit (deny by default), lock, audit | 403 | handled |
| Sender throws, hangs or ignores the abort | `Promise.race` | backoff; `failed` after 5 | degrade |
| Dispatcher crash | `sending` lease | reclaimed with a new token | degrade |
| Voided or expired card with a pending delivery | claim joins the card | `cancelled` | handled |
| Bad, published or low-entropy key, or `DB_LOGGING` in production | `loadConfig` | refuses to start | fail loud |
| Wrong key for a configured id | check-value comparison | refuses to start | fail loud |
| Check-value row missing while cards use the id | existence check | refuses to start | fail loud |
| Lost encryption key | n/a | no re-display; PIN cards unusable; keys must be backed up | fail loud |
| Ciphertext tampered | GCM tag | 500 | fail loud |
| Token hash forged by a DB-write attacker | n/a | outside the threat model (7.3) | accepted |
| Ledger or audit UPDATE/DELETE | trigger | 500 | fail loud |
| DB error carrying row data | handler reduction | no PII logged | handled |
| Legacy rows present | migration pre-check | migration aborts | fail loud |
| Migration blocked | `lock_timeout` | fails; re-runnable | fail loud |
| App deployed before migration | `verifyCardKeys` query fails | startup fails | fail loud |

## 9. Testing strategy

**Unit tests** (no DB, `npm test`).

- **`card-number.test.ts`**
  - `luhn: known vectors`
  - `generate: length/prefix/Luhn for 16-19`
  - `generate: uses injected randomInt only`
  - `prefix: rejects first digit 0-6`
  - `prefix: rejects 81/82/9792`
  - `prefix: rejects length 3 and 7`
  - `pinless requires 19`
  - `normalize: strips spaces and hyphens`
  - `normalize: rejects Luhn failure, 15/20 digits, letters`
  - `reference: alphabet, length, O/I/L`
- **`money.test.ts`**
  - `KWD/BHD/OMR exponent 3`
  - `CAD exponent 2`
  - `unsupported currency rejected`
- **`program-rules.test.ts`**
  - `country must be supported`
  - `region must match country`
  - `region format`
  - `expiry only for promotional`
  - `paid with expiry rejected`
  - `staff limit only for paid`
  - `max value bounds`
  - `immutable field list`
- **`card-state.test.ts`**
  - one test per row of the table in 7.5
  - `voided rejects everything`
  - `effective expired overrides`
  - `decideIssue` cases
  - PIN decider cases: 5th failure locks, locked rejects the correct PIN, a missing PIN does not
    count, a correct PIN resets, a length mismatch counts as wrong
- **`card-crypto.test.ts`**
  - `round trip`
  - `fresh IV`
  - `AAD mismatch (cardId/tenantId/purpose/key id) fails`
  - `tampered tag or ciphertext fails`
  - `unknown version fails`
  - `short blob fails`
  - `constructor rejects 31-byte key, equal keys, id 0`
  - `lookupHash deterministic and key-dependent`
  - `keyCheckValues stable, key-dependent, and not equal to HMAC(rawKey, label)`
- **`delivery-token.test.ts`**
  - `43-char base64url`
  - `hash 32 bytes`
  - `token in fragment`
- **`request-hash.test.ts`**
  - `stable`
  - `differs on each field (incl. actorUserId)`
  - `separator characters cannot collide`
  - `absent vs empty differ`
- **`mask.test.ts`**
  - `maskEmail keeps first character and domain only`
- **`config.test.ts`** (`validEnv` with the fixed test keys; `prodEnv` for the production cases)
  - `card keys required`
  - `non-hex, wrong length, low-entropy rejected without echo`
  - `keys must differ`
  - `key id range`
  - `published keys refused in production, accepted in test`
  - `DB_LOGGING=true refused in production`
  - `link URL https in production; fragment rejected`
  - `PATCH in default CORS methods`
  - `loadServerConfig still needs no card keys`
  - `all problems reported together`
  - The existing production CORS cases now use `prodEnv`.
- **`no-import-side-effects.test.ts`**: add the three route modules,
  `src/services/deliveryDispatcher` and `src/gift-cards/card-crypto`.

**Integration tests** (`npm run test:integration`, real PostgreSQL, app role). Deterministic
staging uses `waitUntilBlocked` from `test/support/lock-staging.ts`.

- **`gift-card-schema.test.ts`**
  - `card with another tenant's program rejected by FK`
  - `card currency differs from program rejected`
  - `ledger row with another tenant or currency rejected`
  - `delivery for another tenant's card rejected`
  - `refund pointing at another card's transaction rejected`
  - `ledger UPDATE/DELETE rejected by trigger as the app role`
  - `audit_logs UPDATE/DELETE rejected`
  - `active with balance 0 rejected`
  - `program currency update with cards rejected by FK`
- **`gift-card-keys.test.ts`** (`resetDb()` in both `beforeEach` and `afterEach`)
  - `first boot stores check values`
  - `second boot succeeds`
  - `different encryption key, same id: fails naming CARD_ENCRYPTION_KEY`
  - `same for CARD_LOOKUP_KEY`
  - `new id with new key boots`
  - `row deleted while cards use the id: boot refused`
  - `row deleted and no cards use it: boot re-pins`
- **`gift-card-programs.test.ts`**
  - `admin creates (audit)`
  - `staff cannot create`
  - `staff can list`
  - `name unique per tenant`
  - `network prefix rejected`
  - `pinless 16-digit rejected`
  - `paid with expiry rejected`
  - `unsupported country / mismatched region rejected`
  - `immutable fields editable before first card`
  - `each immutable field (incl. cardType) rejected after first card`
  - `pinRequired / expiry changes apply to new cards only`
  - `retire then issue -> 409`
  - `update audit records from/to for staffDailyIssueLimit`
- **`gift-cards.test.ts`**
  - `issue returns last4 only and the delivery`
  - `issue replay (200)`
  - `same key, different body -> 409`
  - `another user reusing the key -> 409`
  - `retry after program retired -> 200 replay`
  - `retry after max_value lowered -> 200 replay`
  - `concurrent same-key admin issues`: two requests fired together; statuses exactly {201, 200};
    the 200 carries `Idempotent-Replayed: true`; same card id; one card in the DB
  - `issue: idempotency 23505 after rollback replays` (deterministic):
    1. An admin connection opens a transaction and inserts a fixture card, an `issue` ledger row
       with key K and `request_hash = requestHashIssue(body)` for the same actor, and a delivery.
    2. Fire the request with key K.
    3. `waitUntilBlocked`, then commit the admin transaction.
    4. Expect 200 + `Idempotent-Replayed: true` and the fixture card's id.
  - `staff cannot issue promotional`
  - `staff cannot issue without a limit`
  - `staff limit: up to the limit succeeds, the next is 403`
  - `staff limit: concurrent staff issues cannot exceed it`
  - `staff limit: concurrent same-key retry at the cap replays (200, one card)`
  - `admin not subject to the staff limit`
  - `amount over max_value -> 400`
  - `promotional expiry sets expires_at`
  - `sendAt > 365 days -> 400`
  - `get by reference (with/without hyphens)`
  - `transactions list`
  - `suspend/resume/void/unlock transitions, idempotent repeats, audit rows`
  - `void writes the void ledger row`
- **`deliveries.test.ts`** (with `RecordingDeliverySender`)
  - `immediate delivery, token in fragment`
  - `scheduled delivery sent only after next_attempt_at`
  - `reveal returns number/PIN/balance and increments reveal_count`
  - `expired token -> 404`
  - `unknown token -> 404`
  - `resend invalidates the old token; new one works; audit`
  - `staff recipient change -> 403`
  - `admin recipient change audits masked emails`
  - `sender throws: backoff recorded; issue 201`
  - `sender that never settles and ignores the signal: dispatch returns after sendTimeoutMs`
    (100 ms)
  - `fifth failure -> failed, token cleared`
  - `stale sending reclaimed with a new token`
  - `two concurrent dispatches send each delivery once`
  - `void with scheduled delivery: nothing sent, cancelled`
  - `void during sending: no-op outcome, no reclaim, link 404s`
  - `resend and void concurrently: no deadlock; voided + cancelled`
- **`redemption.test.ts`**
  - `lookup with correct number and PIN`
  - `wrong number / wrong PIN / missing PIN / locked -> byte-identical 404 bodies`
  - `idempotency oracle closed`: with a used key, a wrong PIN, missing PIN or locked card returns
    the same 404 as a nonexistent card, never 409 or 200
  - `PIN-less redeems with number only`
  - `5 wrong PINs lock (audit with actor); correct PIN fails; unlock restores`
  - `lock expires after 30 min`
  - `auth_failed warn line has userId and no number`
  - `redeem partial`
  - `redeem to zero -> depleted`
  - `insufficient -> 409, no ledger row`
  - `expired -> 409, stored expired, balance unchanged`
  - `suspended -> 409`
  - `replay returns same transaction id`
  - `key reuse with different amount -> 409`
  - `refund up to redeemed`
  - `refund over refundable -> 409`
  - `refund revives depleted`
  - `refund retry after suspend -> 200 replay`
  - `staff refund -> 403`
  - `ledger invariant after every test` (computed and compared in SQL)
- **`redemption-concurrency.test.ts`** (`lockTimeoutMs: 30_000` unless noted)
  - `double spend: 10 concurrent 30-unit redeems on 100 -> exactly 3 succeed, balance 10, 3 rows`
  - `10 concurrent same-key redeems -> one ledger row, same transaction id`
  - `redeem: same key used concurrently on another card -> 409` (deterministic):
    1. An admin connection opens a transaction and inserts a `redeem` ledger row with key K on
       card X.
    2. Fire a redeem with key K on card Y.
    3. `waitUntilBlocked`, then commit.
    4. Expect 409 "Idempotency key already used with a different request".
    5. Y's balance is unchanged.
  - `PIN attempts are serialized`:
    1. An admin transaction holds FOR UPDATE on the card.
    2. Queue 5 wrong-PIN requests and 1 correct-PIN request, staged with `waitUntilBlocked`.
    3. Commit. The correct PIN must fail.

    The RED check is replacing FOR UPDATE with a plain SELECT, which makes the test fail.
  - `lock_timeout -> 503 with Retry-After` (`lockTimeoutMs: 200`)
- **`gift-card-tenancy.test.ts`**
  - Tenant B gets 404 for A's program, card by id or reference, transactions, refund, resend,
    suspend and void.
  - B gets `CARD_AUTH_FAILED` on lookup or redeem of A's number.
  - A's `failed_pin_attempts` stays 0.
- **`gift-card-leakage.test.ts`** (in-memory log stream at `trace`). The flow:
  1. issue
  2. dispatch
  3. reveal
  4. lookup
  5. wrong PIN
  6. redeem
  7. resend
  8. throwing sender with the token in its message
  9. a real DB error: a test-only route, added before `ready`, inserts a delivery row that violates
     a CHECK, with a marker email
  10. a real `CardCryptoError`: corrupt `card_number_enc` with `adminQuery`, then reveal

  Assertions:
  - the number, PIN, tokens and marker email appear in no log line;
  - the number and PIN appear in no response except reveal;
  - `card_number_enc` does not contain the ASCII number;
  - the PIN is not stored in plaintext;
  - card responses have exactly the card-schema keys.

  `send(..., { forbidden })` is used throughout.

## 10. Rollout / migration

### 10.1 Migrations

Run the migrations in order: `1760000200000`, `1760000300000`, `1760000400000` (see 7.1).

- **Locking.** Only new tables are created, except for brief FK validation against `tenants` and
  `users` (`SHARE ROW EXCLUSIVE`, bounded by `lock_timeout`).
- **No feature flag.**
- **Rollback:** before real cards exist, revert the migrations and the code. After that, rollback
  is forward-fix only.

### 10.2 Operations

**Before deploying:**

- Run `migration:run` before deploying the new app. From Phase 2 on, `buildApp` queries
  `gift_card_key_checks` at startup, and fails without it.
- **`DB_LOGGING=true` is now refused in production.** An existing production environment with it
  set will refuse to boot after this deploy. Unset it first.

**Keys:**

- Add `CARD_ENCRYPTION_KEY` and `CARD_LOOKUP_KEY`, optionally with their ids.
- Back both keys up in a secret manager **before the first boot**, because the first boot records
  their check values.
- To change a key, use a new id.

**Configuration:**

- Set `GIFT_CARD_LINK_BASE_URL`.
- Schedule `npm run deliveries:dispatch:prod` every minute.
- Set `TRUST_PROXY=true` behind a proxy.
- Add the landing page's origin to `CORS_ORIGIN`.

**Protect app-role DB credentials** like the card keys (7.3).

### 10.3 README sections to update

- **Project structure.**
- **Data model:** the 5 new tables, and `audit_logs` now in use and append-only.
- **Environment variables:**
  - the 6 new variables and how to generate them (keys only);
  - back up keys before the first boot; a new key needs a new id;
  - the key-check reset procedure;
  - `CORS_METHODS` now includes PATCH;
  - `DB_LOGGING` is refused in production.
- **API:** the endpoints in 7.6.
- **New "Gift cards" section:**
  - number format, PIN, state machine;
  - idempotency, lockout, staff limits;
  - delivery and reveal;
  - landing-page requirements (7.7);
  - threat model (7.3);
  - audit retention and redaction (7.11).
- **Database migrations:** the dispatch cron and the deploy order.
- **Known limitations:**
  - Remove "No gift card features yet" and the plaintext-PIN item.
  - Add: log-only sender; per-instance rate limits; timing residual; at-least-once delivery; no
    card listing; no key rotation; no public balance check; relay-abuse prerequisites.
- **Project status** test counts.

### 10.4 Implementation plan (one developer pass each)

**Gates.**

- Every phase: `npm run lint`, `npm run typecheck`, `npm test`.
- From Phase 2 on, also: `npm run migration:run`, `npm run migration:check`,
  `npm run test:integration`.

Every phase ends with all gates and CI green.

1. **Pure core and config.**
   - The 8 `src/gift-cards/*` modules.
   - `readGiftCardConfig` and the config checks (7.8).
   - The ESLint boundary rule.
   - In the same phase:
     - the fixed test keys from 7.8 in `loadTestConfig`;
     - card keys in `validEnv`;
     - `prodEnv` for the existing production cases;
     - CI env keys;
     - `.env.example`.
   - The unit tests.
   - **Exit:** gates green. Lint fails on a deliberate `import "typeorm"` placed in
     `src/gift-cards/` (checked once, then removed).
2. **Schema and keys.**
   - The 3 migrations and 6 entities, plus data-source registration.
   - `sql.ts`.
   - Build `CardCrypto` in `buildApp` and wire in `verifyCardKeys`.
   - `test/support/lock-staging.ts`.
   - `gift-card-keys.test.ts` and `gift-card-schema.test.ts`.
   - **Exit:** `migration:check` reports no drift (proves A2), and the VERIFY outputs match.
3. **Programs.** `audit.ts`, the service, routes and schemas, and `gift-card-programs.test.ts`.
4. **Issue, reads, admin state changes.**
   - `GiftCardService` and its routes.
   - `CardCrypto` passed to the routes.
   - A dispatcher with the log-only sender and a stub `dispatch` that does nothing until Phase 5.
   - `gift-cards.test.ts`.
5. **Delivery.**
   - The dispatcher, port and senders (log-only and the development console sender).
   - Reveal and resend.
   - The script and its `package.json` scripts.
   - `deliveries.test.ts`.
6. **Redemption.**
   - `RedemptionService` and its routes.
   - `55P03` handling.
   - The `card_auth_failed` log.
   - `redemption.test.ts` and `redemption-concurrency.test.ts`.
7. **Hardening and docs.**
   - The error-handler reduction and redaction.
   - `gift-card-tenancy.test.ts` and `gift-card-leakage.test.ts`.
   - The additions to `no-import-side-effects`.
   - The README.

## 11. Alternatives rejected

- **Reusing the legacy `gift_cards` table.** Every column changes, and it has no `program_id`.
- **PG enums.** Values can't be removed, and adding one needs `ALTER TYPE`.
- **AES-SIV instead of encryption plus HMAC.** It needs one key for two purposes, and node:crypto
  has no SIV.
- **bcrypt or argon2 for the PIN.** The keyspace is tiny, and the PIN must be re-displayable.
- **Triggers for tenant consistency.** Composite FKs are declarative and tracked by TypeORM.
- **Token in the URL path or query.** Fastify and proxies log URLs.
- **An in-process timer for scheduled sends.** It is a boot side effect, and duplicates across
  instances.
- **A new `gift_card_events` table.** The existing `audit_logs` fits (X-5).
- **ADMIN-only issuance until payment exists.** Rejected in favour of staff limits that deny by
  default (open question 1).
- **Batch-claiming deliveries.** The lease would have to cover the whole batch.
- **A keyed (HMAC) delivery-token hash.** Rejected as a cost-benefit call, not as infeasible.
  - It adds a key that the dispatch script must hold (it otherwise holds none) and that needs its
    own rotation story.
  - It protects only against an attacker with DB write access, who can already edit balances
    (7.3).
  - Unkeyed SHA-256 matches `refresh_tokens.token_hash`.
- **Plaintext emails in audit rows.** Masked forms are enough for investigation.
- **Repository classes.** X-3.
- **Fallback if A2 fails:** `@ManyToOne` with an array of `@JoinColumn`s.

## 12. Decisions on the open questions (with the user, 2026-11-13)

1. **Staff issuance:** deny by default, as designed. The admin can set `staffDailyIssueLimit`
   when creating the program.
2. **Refunds:** ADMIN-only for this version.
3. **Link lifetime:** 90 days (changed from 30; see 7.7).
4. **PIN lockout:** 5 failures lock the card for 30 minutes; an admin can unlock. Unchanged.
5. **Paid-card expiry:** paid cards never expire in this version. GCC expiry rules come with the
   per-country rules engine.
6. **Development sender:** yes, `ConsoleLinkDeliverySender` behind `GIFT_CARD_DEV_PRINT_LINKS`,
   development only (7.7, 7.8).
7. **Card prefixes:** keep 7, 8 or 9 (minus 81, 82 and 9792). No tenant needs a 6-range.
8. **Card listing:** none in this version; added later together with pagination.
9. **Audit retention:** indefinite for now; revisit with legal review of the privacy policy
   (e.g. Quebec Law 25 retention limits).

## 13. Out of scope (deferred by the user)

- reloads
- taking payment
- a real email provider (send caps and escaped templates are prerequisites)
- cross-currency
- physical cards
- key-rotation tooling
- GCC legal review
- public balance check
- a per-country rules engine

## Review log

### Mid-design requirement change

**Added by the user during design:** jurisdiction on `gift_card_programs`.

- **Fields:** `country` (ISO 3166-1 alpha-2, required) and `region` (ISO 3166-2, optional).
- **Immutability:** both are immutable once a card is issued.
- **Inheritance:** cards inherit them through `program_id`, with no copy.
- **Where it lands:** 7.1, 7.4 (country = format + known list; region = regex + country prefix)
  and 7.6.

### Round 1

| Reviewer | Verdict |
|---|---|
| Feasibility | CHANGES-REQUIRED: 6 MAJOR, 8 MINOR |
| Security | CHANGES-REQUIRED: 5 MAJOR, 4 MINOR |

**Feasibility** (all accepted):

| # | Severity | Objection | Resolution |
|---|---|---|---|
| F1 | MAJOR | Void did not stop pending or in-flight deliveries; resend/void could deadlock | `cancelled` status; the claim joins the card; reveal filters voided cards; lock order program -> card -> delivery |
| F2 | MAJOR, E-6 | The timeout relied on the sender cooperating; the lease was too short | `Promise.race`; constructor defined; one delivery per claim; lease invariant |
| F3 | MAJOR, E-5 | Issue rules ran before idempotency; refund ordering unspecified | Reordered |
| F4 | MAJOR | Idempotency before PIN created an oracle | Lookup -> PIN -> idempotency -> rules |
| F5 | MAJOR | `cardType` mutability unspecified | Immutable after the first card |
| F6 | MAJOR | The phase plan left CI red | Phase 1 updates helpers, `validEnv`, CI and `.env.example` |
| F7-F14 | MINOR | `lockTimeoutMs`; parameter casts; aggregate strings; `em.query` shape; PATCH in CORS; impossible tests; migration `lock_timeout`; hash fields | Applied |

**Security:**

| # | Severity | Objection | Resolution |
|---|---|---|---|
| S1 | MAJOR | Idempotency before PIN (oracle and replay without PIN) | **Accepted** |
| S2 | MAJOR | Unlimited unpaid staff issuance | **Accepted:** per-program staff limit, deny by default (open question 1) |
| S3 | MAJOR, E-3 | Wrong key or key-id mismatch undetected | **Accepted:** check-value table verified at boot |
| S4 | MAJOR | No durable audit trail | **Accepted** via the existing `audit_logs` (X-5) |
| S5 | MAJOR, E-4 (downgraded by the reviewer) | Redaction gaps | **Accepted** |
| S6-S8 | MINOR | Lockout DoS; reveal hardening; relay abuse | **Accepted** |
| S9a | MINOR | Published keys allowed in production | **Accepted** |
| S9b | MINOR | Non-enumerable config keys | **Rejected:** `jwtSecret` is held the same way (src/config.ts:20, :152), and nothing logs the config |

### Round 2

| Reviewer | Verdict |
|---|---|
| Security | **SIGN-OFF** with 7 MINOR |
| Feasibility | CHANGES-REQUIRED: 1 MAJOR, 4 MINOR |

The feasibility reviewer confirmed:

- `AuditLog` and `GiftCardKeyCheck` cause no drift;
- `verifyCardKeys` is compatible with the tests;
- there is no deadlock between claim, void and resend.

| # | Severity | Objection | Resolution |
|---|---|---|---|
| F2-1 | MAJOR, E-5 | A concurrent same-key staff retry near the cap got 403 | **Accepted:** the staff advisory lock now comes before the idempotency check |
| F2-2 | MINOR | Test isolation of `gift-card-keys.test.ts` | **Accepted** |
| F2-3 | MINOR | Phase plan inconsistent about `CardCrypto` | **Accepted** |
| F2-4 | MINOR | Invariants and filters | **Accepted** |
| F2-5 | MINOR | Deploy order and key backup | **Accepted** |
| S2-1 | MINOR | Landing-page XSS | **Accepted:** `textContent` rule |
| S2-2 | MINOR | `DB_LOGGING` bypasses redaction | **Accepted:** refused in production |
| S2-3 | MINOR | Check value pinned on first sight | **Accepted:** refuse when cards use the id; low-entropy rule; HKDF subkey; reset procedure |
| S2-4 | MINOR | Audit lacked values; the claim about types was false | **Accepted:** from/to values; typed entries |
| S2-5 | MINOR | PII in an append-only table | **Accepted:** masked emails; retention documented (open question 9) |
| S2-6 | MINOR | No per-actor record of failed authentication | **Accepted:** `card_auth_failed` log |
| S2-7 | MINOR | Unkeyed token hash forgeable by a DB-write attacker | **Accepted in part:** threat model stated; keyed hash rejected (section 11) |

### Round 3 (final; the round cap is reached)

| Reviewer | Verdict |
|---|---|
| Security | **SIGN-OFF**, 3 MINOR |
| Feasibility | **CHANGES-REQUIRED**, 1 MAJOR and 3 MINOR, plus a conditional commitment to sign off |

**Security** confirmed:

- the check-value changes open no new path; the first-boot race converges, and the reset is
  enforced at boot;
- the staff cap cannot be exceeded under the reordering;
- the S2-7 conclusion holds.

**Feasibility** confirmed:

- F2-1 is closed for its scenario;
- no gate is broken by the round-2 changes (`DB_LOGGING` refusal, `hkdfSync` on Node 22/24, app
  role in the CI boot test).

The feasibility reviewer stated: "If objection 1's (a), (b) and (c) are written into the design as
stated, I sign off on that text without another review round."

| # | Severity | Objection | Resolution |
|---|---|---|---|
| F3-1 | MAJOR, T-3 / E-5 | The `23505` replay paths are untested, and the wording allowed a re-read inside the aborted transaction (`25P02`), or a constraint-name miss that falls to the generic 409 | **Accepted as specified.** (a) 6.1 step 8 and 6.2 "After rollback" specify a re-read outside the callback after rejection, matched on `constraint === "gift_card_transactions_tenant_id_idempotency_key_key"`. (b) The admin concurrent test asserts {201, 200}, the replay header and the same card id. (c) Deterministic staged tests for issue (`issue: idempotency 23505 after rollback replays`) and redeem (`redeem: same key used concurrently on another card -> 409`), with `test/support/lock-staging.ts` |
| F3-2 | MINOR | Phase 1 config traps: the production test at config.test.ts:60-66; the low-entropy rule vs a hand-written test key; config placement; `hkdfSync` ArrayBuffer | **Accepted:** `prodEnv`; fixed SHA-256-derived test and CI keys (7.8); `readGiftCardConfig` kept out of `readServerConfig`; `DB_LOGGING` × `NODE_ENV` check in `loadConfig` and `loadDispatchConfig`; `Buffer.from(hkdfSync(...))` |
| F3-3 | MINOR, B-6 | Deploy checklist omitted the `DB_LOGGING` refusal; typo | **Accepted:** 10.2 bullet; `gift_card_key_checks` typo fixed |
| S3-1 | MINOR | The isolation dependency was not enforced | **Accepted:** every gift-card transaction passes `"READ COMMITTED"` explicitly (A3) |
| S3-2 | MINOR | Cross-actor replay of issue | **Accepted:** `actorUserId` added to the issue request hash; test `another user reusing the key -> 409` |
| S3-3 | MINOR | The section 11 rationale for the keyed token hash overstated its case | **Accepted:** reworded as a cost-benefit rejection |

**Sign-off status at close:**

- **Security:** signed off (round 2, re-confirmed in round 3).
- **Feasibility:** has not explicitly re-confirmed the final text. Its round-3 verdict was
  CHANGES-REQUIRED, with a stated conditional sign-off once F3-1 (a), (b) and (c) were written
  in. They now are, as specified. A confirmation pass by the feasibility reviewer is recommended
  before Phase 1 starts.
