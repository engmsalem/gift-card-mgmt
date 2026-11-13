# gift-card-mgmt

A multi-tenant **gift card management API** built with Fastify, TypeORM and PostgreSQL.

The goal is a backend where tenants (merchants) issue gift cards and their staff can redeem and refund balances, with an audit trail.

> **Status: work in progress.** Tenant signup, user management, authentication and digital gift cards (programs, issuing, email delivery, redemption, refunds, audit trail) are implemented and tested. Emails are only logged for now, not sent. See [Project status](#project-status).

---

## Tech stack

| Layer      | Choice                                                                 |
| ---------- | ---------------------------------------------------------------------- |
| Runtime    | Node.js + TypeScript 5 (CommonJS)                                      |
| HTTP       | [Fastify 5](https://fastify.dev/)                                      |
| ORM        | [TypeORM 1.x](https://typeorm.io/) (`postgres`, `pg` driver), migrations |
| Database   | PostgreSQL 18 (via Docker Compose)                                     |
| Auth       | `@fastify/jwt` access tokens + opaque rotating refresh tokens, `bcrypt` |
| Validation | Fastify JSON schemas (request and response)                            |
| Tooling    | `node:test`, ESLint 9 + typescript-eslint, GitHub Actions              |

## Project structure

```
src/
├── index.ts                 # Entry point: load config, connect DB, build app, listen, graceful shutdown
├── app.ts                   # buildApp({ config, dataSource }): Fastify instance, plugins, routes (no listen)
├── config.ts                # loadConfig(env): validates environment variables (pure, no side effects on import)
├── data-source.ts           # createDataSource(config, "app" | "admin"): DataSource factory
├── migration-data-source.ts # Entry point for the TypeORM CLI (admin role)
├── migrations/              # Schema history; the source of truth for the database schema
├── entities/                # Tenant, User, RefreshToken, AuditLog, GiftCardProgram, GiftCard,
│                            # GiftCardTransaction, GiftCardDelivery, GiftCardKeyCheck
├── enums/roles.ts           # admin | staff
├── errors.ts                # AppError + 400/401/403/404/409 subclasses
├── credentials.ts           # Email normalisation/validation, bcrypt 72-byte check
├── tokens.ts                # Refresh token generation and hashing, token lifetimes
├── gift-cards/              # Pure gift card rules (no database, framework or config imports; ESLint enforces it):
│                            # card numbers, money/countries, program rules, card states, card crypto,
│                            # delivery tokens, request hashes, email masking
├── delivery/                # Email senders: log-only (default) and the development console sender
├── plugins/
│   ├── error-handler.ts     # Maps errors to status codes; logs database errors without parameters
│   ├── jwt.ts               # Access token signing/verification, `authenticate`, `requireRole`
│   └── rate-limit.ts        # 100 requests / minute per IP (login: 10, tenant signup: 5)
├── routes/                  # tenant, auth, user, gift card program, gift card and gift card link routes
├── services/                # Tenant, Auth, User, GiftCardProgram, GiftCard, Redemption, Delivery services,
│                            # the delivery dispatcher, audit writer and startup key check
├── scripts/                 # Cron entry points: purge expired refresh tokens, dispatch gift card emails
└── types/requests.d.ts      # Fastify / JWT type augmentations

test/
├── unit/                    # No database needed
├── integration/             # Real PostgreSQL via app.inject(); helpers.ts sets up the test DB
└── support/                 # test-db.ts (refuses to reset any database not named *_test),
                             # lock-staging.ts (deterministic concurrency tests), recording sender

db/init/01-app-role.sh       # First-start Postgres script: creates the app role and the _test database
docker-compose.yml           # PostgreSQL, configured from .env
.github/workflows/ci.yml     # CI pipeline
```

Layering is **routes → services → TypeORM repositories**. Configuration is loaded only by the entry points (`src/index.ts`, `src/migration-data-source.ts`, `src/scripts/`) and passed down explicitly. Importing any other module doesn't read the environment, load `.env` or open connections (the only global effect is the `reflect-metadata` polyfill TypeORM needs), so tests can build apps with their own config. The API entry point validates the full config (`loadConfig`). Migrations and the purge script only validate the database settings (`loadDbConfig`), so they don't need `JWT_SECRET` or `CORS_ORIGIN`. The `DataSource` is exposed to services as a Fastify decorator (`fastify.db`).

## Data model

Defined by the migrations in `src/migrations/`. All tenant-owned tables carry a `tenant_id` (one shared database, isolated by tenant).

**Ids are UUIDv7**, generated by PostgreSQL (`DEFAULT uuidv7()`, built into PostgreSQL 18) and returned as strings in the API, e.g. `"01a1d1a8-a62b-7303-ae9d-dcf7dbad406a"`. Unlike sequential integers, they don't reveal how many tenants or users exist and can't be guessed. Unlike random UUIDv4, they're time-ordered, so inserts and indexes stay efficient. Don't rely on ids for sorting: list endpoints order by `created_at`.

| Table            | Purpose                                                                  | Entity / API |
| ---------------- | ------------------------------------------------------------------------ | ------------ |
| `tenants`        | Merchants, each with a unique `subdomain`                               | Yes          |
| `users`          | Tenant staff: `name`, globally unique `email`, `role` (`admin` / `staff`) | Yes          |
| `refresh_tokens` | SHA-256 hashes of issued refresh tokens, with expiry and revocation       | Yes          |
| `gift_card_programs` | A tenant's gift card offerings: type (paid / promotional), currency, country/region, number prefix and length, PIN required, max value, expiry, staff daily limit | Yes |
| `gift_cards`     | Encrypted card number and PIN, HMAC lookup hash, last 4 digits, reference number, balance, status | Yes |
| `gift_card_transactions` | Append-only ledger: `issue`, `redeem`, `refund`, `void`, with idempotency keys | Yes |
| `gift_card_deliveries` | Recipient, message, scheduled send time, delivery status, hashed link token | Yes |
| `gift_card_key_checks` | Check values (not keys) that detect a wrong card key at startup | Internal |
| `audit_logs`     | Append-only JSON (`jsonb`) log of sensitive actions per tenant/user, emails masked | Yes (written by the API) |

The database enforces the important invariants itself: a card's tenant and currency must match its program's, a ledger row's must match its card's, balances can't go negative, and the ledger and audit log reject `UPDATE` and `DELETE`.

## Getting started

### Prerequisites

- Node.js **22.13+ or 24.11+** (TypeORM 1.x needs 20.19+, and the test scripts need 22+)
- Docker with Docker Compose

### 1. Configure environment

```bash
cp .env.example .env
```

Both the app and `docker-compose.yml` read this file.

| Variable               | Required | Default                      | Notes |
| ---------------------- | -------- | ---------------------------- | ----- |
| `HOST`                 | no       | `localhost`                  | Interface to listen on. Use `0.0.0.0` in Docker or production so the server is reachable from outside the container/host |
| `PORT`                 | no       | `3000`                       | HTTP port the API listens on |
| `NODE_ENV`             | no       | `development`                | `production` lowers log verbosity |
| `DB_HOST`              | no       | `localhost`                  | |
| `DB_PORT`              | no       | `5432`                       | Also the host port Docker publishes PostgreSQL on. Pick another (e.g. `5434`) if 5432 is taken |
| `DB_DATABASE`          | yes      | none                         | e.g. `gift_card_mgmt`. Docker also creates `<DB_DATABASE>_test` for integration tests |
| `DB_USERNAME`          | yes      | none                         | **App role**: read/write data only, cannot change the schema |
| `DB_PASSWORD`          | yes      | none                         | Password for the app role |
| `DB_ADMIN_USERNAME`    | yes\*    | `DB_USERNAME`                | **Admin role** (schema owner), used only by migrations. Set both admin variables or neither (neither = use the app credentials). \*Required by Docker Compose, and must differ from `DB_USERNAME` |
| `DB_ADMIN_PASSWORD`    | yes\*    | `DB_PASSWORD`                | Password for the admin role |
| `JWT_SECRET`           | yes      | none                         | At least 32 characters. Generate: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `CARD_ENCRYPTION_KEY`  | yes      | none                         | Encrypts gift card numbers and PINs (AES-256-GCM). 64 hex characters: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. See [Card keys](#card-keys) |
| `CARD_LOOKUP_KEY`      | yes      | none                         | Keyed hash (HMAC-SHA256) for finding cards by number. Same format, must differ from the encryption key |
| `CARD_ENCRYPTION_KEY_ID` | no     | `1`                          | Integer 1–32767. Change only together with the key |
| `CARD_LOOKUP_KEY_ID`   | no       | `1`                          | Integer 1–32767. Change only together with the key |
| `GIFT_CARD_LINK_BASE_URL` | no*   | `http://localhost:3000/gift` | Where gift emails link to (the landing page); the token is appended as `#token=...`. *Required in production, and must be `https` |
| `GIFT_CARD_DEV_PRINT_LINKS` | no  | `false`                      | `true` prints gift links to the console so you can open them by hand. Refused unless `NODE_ENV=development` |
| `DB_LOGGING`           | no       | `false`                      | `true` logs every SQL statement with its parameters. Refused when `NODE_ENV=production` |
| `CORS_ORIGIN`          | no*     | `*`                          | One origin, or a comma-separated list. *Required when `NODE_ENV=production` (set `*` explicitly to allow any origin) |
| `TRUST_PROXY`          | no       | `false`                      | Set to `true` behind a reverse proxy / load balancer so rate limits use the real client IP (`X-Forwarded-For`). Leave `false` otherwise: clients could spoof their IP |
| `CORS_METHODS`         | no       | `GET,POST,PUT,PATCH,DELETE`  | Comma-separated |
| `CORS_ALLOWED_HEADERS` | no       | `Content-Type,Authorization` | Comma-separated |

The app refuses to start if anything is missing or invalid, and lists every problem at once.

Example `.env` for local development:

```dotenv
PORT=3000
NODE_ENV=development
DB_HOST=localhost
DB_PORT=5432
DB_DATABASE=gift_card_mgmt
DB_USERNAME=gcm_app
DB_PASSWORD=change-me
DB_ADMIN_USERNAME=gcm_owner
DB_ADMIN_PASSWORD=change-me-too
JWT_SECRET=<output of the command above>
CARD_ENCRYPTION_KEY=<64 hex characters>
CARD_LOOKUP_KEY=<a different 64 hex characters>
GIFT_CARD_DEV_PRINT_LINKS=true
```

#### Card keys

- **Back up both card keys (e.g. in a secret manager) before the first start.** The first start records a check value for each key id. After that, starting with a different key under the same id fails with `CARD_ENCRYPTION_KEY does not match the key recorded for key id 1`. A lost encryption key means the stored card numbers and PINs can't be read again.
- To use a new key, give it a new id (`CARD_..._KEY_ID`). Re-encrypting existing cards under a new key (rotation) isn't built yet.
- **Key-check reset:** if a check value was recorded for a key you never used for real cards, delete its row from `gift_card_key_checks` as the admin role. The startup check refuses this situation if any card still uses that key id.
- The published test and CI keys in this repo are refused when `NODE_ENV=production`.

**Why two database users?** The API connects as the app role, which can only read and write rows. If the API is ever compromised, the attacker can't drop tables, create roles or reach other databases. Schema changes need the admin role, which only migrations use. In production, keep the admin credentials out of the API server's environment and use them only in the deploy step that runs migrations.

### 2. Start PostgreSQL

```bash
docker compose up -d --wait
```

On first start this creates the admin role, the app role, `DB_DATABASE` and `DB_DATABASE_test`, and stores data in the `postgres_data` volume.

> The roles and databases are only created **the first time** the volume is initialised. If you change any `DB_*` credentials later, or are upgrading from an older version of this project, reset it with `docker compose down -v` (this deletes all data) and start again.

To open a SQL shell: `docker compose exec postgres psql -U <DB_ADMIN_USERNAME> -d <DB_DATABASE>`.

### 3. Install, migrate and run

```bash
npm install
npm run migration:run     # create/upgrade the schema (admin role)
npm run dev               # ts-node src/index.ts
# or
npm run build && npm run migration:run:prod && npm start
```

The server listens on `http://localhost:3000` (or `$PORT`).

### 4. Try it

```bash
# Create a tenant and its first admin
curl -X POST localhost:3000/tenants -H "Content-Type: application/json" \
  -d '{"tenant":{"name":"Acme","subdomain":"acme"},"admin":{"name":"Ada","email":"ada@acme.com","password":"correct-horse"}}'

# Log in -> { accessToken, refreshToken, expiresIn }
curl -X POST localhost:3000/auth/login -H "Content-Type: application/json" \
  -d '{"email":"ada@acme.com","password":"correct-horse"}'

# Call a protected route
curl localhost:3000/users/me -H "Authorization: Bearer <accessToken>"
```

(In PowerShell, use `Invoke-RestMethod` or a REST client instead of these single-quoted bodies.)

## API

| Method | Path            | Auth          | Body | Response |
| ------ | --------------- | ------------- | ---- | -------- |
| POST   | `/tenants`      | none          | `{ tenant: { name, subdomain }, admin: { name, email, password } }` | `201 { tenant, user }`. Creates the tenant and its first `admin` in one transaction. `409` if the subdomain or email is taken. Limited to 5 / minute |
| POST   | `/auth/login`   | none          | `{ email, password }` | `200 { accessToken, refreshToken, expiresIn }`. `401` on bad credentials. Limited to 10 / minute |
| POST   | `/auth/refresh` | none          | `{ refreshToken }` | `200` with a **new** token pair. The old refresh token stops working |
| POST   | `/auth/logout`  | none          | `{ refreshToken }` | `204`. Revokes the refresh token (idempotent) |
| GET    | `/users/me`     | Bearer        | none | `200` own profile |
| GET    | `/users`        | Bearer, admin | none | `200` users of the caller's tenant |
| POST   | `/users`        | Bearer, admin | `{ name, email, password, role? }` | `201`. Creates a user in the caller's tenant (`role` defaults to `staff`) |

Rules:
- `subdomain`: 3–50 characters, lowercase letters, digits and hyphens. `password`: 8–72 characters. Emails are trimmed and lowercased.
- Unknown body fields are rejected with `400`. The tenant always comes from the caller's token, never from the body.
- Errors use `{ "error": "<message>" }` with `400` (validation), `401` (missing/invalid token or credentials), `403` (wrong role), `404`, `409` (duplicate), `429` (rate limit), `503` with `Retry-After` (a concurrent database conflict; safe to retry).
- Password hashes are never returned (excluded from queries and stripped by response schemas).

### Gift card endpoints

All need a Bearer token except the reveal link. "Global" means the default 100 requests / minute per IP.

| Method | Path | Role | Body | Notes |
| ------ | ---- | ---- | ---- | ----- |
| POST  | `/gift-card-programs` | admin | `{ name, cardType, currency, country, region?, cardNumberPrefix, cardNumberLength, pinRequired, maxValue, expiryMonths?, staffDailyIssueLimit? }` | `201` program |
| GET   | `/gift-card-programs` | admin, staff | none | `200` the tenant's programs |
| GET   | `/gift-card-programs/:id` | admin, staff | none | `200` program |
| PATCH | `/gift-card-programs/:id` | admin | any non-empty subset of the fields, or `status: "retired"` | `409` (naming the fields) when changing currency, prefix, length or other fixed fields after the first card |
| POST  | `/gift-cards` | admin, staff | `{ programId, amount, idempotencyKey, recipient: { name, email }, senderName, message?, sendAt? }` | `201 { card, delivery }`. Replay of the same request: `200` + `Idempotent-Replayed: true`. 60 / minute per user |
| GET   | `/gift-cards/:id` | admin, staff | none | `200 { card, delivery }` |
| GET   | `/gift-cards/by-reference/:reference` | admin, staff | none | Look up by the printed reference number |
| GET   | `/gift-cards/:id/transactions` | admin, staff | none | Ledger rows, oldest first |
| POST  | `/gift-cards/lookup` | admin, staff | `{ cardNumber, pin? }` | `200 { card }`. 30 / minute per user |
| POST  | `/gift-cards/redeem` | admin, staff | `{ cardNumber, pin?, amount, idempotencyKey, externalReference? }` | `201 { transaction, card }`; replay `200`. 30 / minute per user |
| POST  | `/gift-card-transactions/:id/refunds` | admin | `{ amount, idempotencyKey }` | Refund part or all of a redemption |
| POST  | `/gift-cards/:id/suspend`, `/resume`, `/void`, `/unlock` | admin | none | `200 { card, delivery }`. Repeating an action that's already in effect returns `200` |
| POST  | `/gift-cards/:id/resend` | admin, staff | `{ recipient?: { name?, email? } }` | New link, old one stops working. Only admins may change the recipient. 10 / minute per user |
| POST  | `/gift-card-links/reveal` | public | `{ token }` | `200` card number, PIN, balance, sender and message. 30 / minute per IP, `Cache-Control: no-store` |

Amounts are integers in the currency's minor unit (cents for CAD; KWD, BHD and OMR have 3 decimals). Responses include `currencyExponent` so clients can format them. Card numbers and PINs only ever appear in the reveal response; everywhere else a card shows `last4` and `referenceNumber`.

### Tokens

- **Access token:** a JWT (HS256, signed with `JWT_SECRET`), valid for **15 minutes**, with claims `sub` (user UUID), `tid` (tenant UUID), `role` and `typ: "access"`. Send it as `Authorization: Bearer <token>`.
- **Refresh token:** a random opaque string, valid for **7 days**. Only its SHA-256 hash is stored. Each refresh **rotates** it: the old one is revoked and a new pair is returned. Rotation is atomic: if issuing the new pair fails, the old token stays valid. Every revocation records a reason (`rotated`, `logout`, `reuse`, `evicted`). Presenting a token that was **rotated** more than **10 seconds** ago is treated as theft, and **all** of that user's refresh tokens are revoked, forcing a new login. Within those 10 seconds (two tabs or a client retry racing on the same token), or for a token revoked by logout or eviction, the request just gets `401`. A user can have at most **10** active refresh tokens (sessions). Logging in again revokes the oldest.
- Access tokens can't be revoked early. After logout they stay valid until they expire (at most 15 minutes).

## Gift cards

Digital gift cards, sent to a recipient by email. The full design, including the review that led to it, is in [`docs/design/gift-cards.md`](docs/design/gift-cards.md).

- **Programs.** Each tenant defines programs: paid or promotional, one currency, a country (ISO 3166-1, e.g. `CA`) and optional region (`CA-QC`). Currency, country, prefix, number length and card type are fixed once the program has issued a card. Programs are retired, never deleted.
- **Card numbers.** 16–19 digits: the program prefix (4–6 digits starting with 7, 8 or 9, outside payment-card ranges), random digits from a cryptographic generator, and a Luhn check digit. Programs without a PIN must use 19 digits, so numbers are much harder to guess.
- **PINs** are 6 random digits, when the program requires one.
- **Storage.** Numbers and PINs are encrypted with AES-256-GCM, bound to their card and tenant so a ciphertext can't be copied to another row. Cards are found by an HMAC of the number under a separate key. Only the last 4 digits are stored in clear.
- **States.** `active`, `suspended`, `depleted` (balance 0), `voided`, `expired`. Paid cards never expire. Only promotional cards can have an expiry (Canadian provinces ban expiry on paid gift cards). There are no fees.
- **Ledger.** Every balance change is a ledger row; the ledger can't be edited. Redemptions can't overdraw a card, even when requests arrive at the same time.
- **Idempotency.** Issue, redeem and refund take an `idempotencyKey` (16–64 characters). Retrying the same request returns the original result with `Idempotent-Replayed: true`. Reusing a key for a different request is `409`.
- **PIN lockout.** 5 wrong PINs lock the card for 30 minutes; an admin can unlock it. An unknown number, a wrong or missing PIN, a locked card and another tenant's card all get the same `404 Invalid card number or PIN`.
- **Staff limits.** Staff can issue paid cards only if an admin set a `staffDailyIssueLimit` on the program, and only up to that total per rolling 24 hours. Promotional cards, refunds, suspend, resume, void and unlock are admin only.
- **Delivery.** Issuing a card schedules an email to the recipient (immediately or at `sendAt`, up to 365 days ahead). It carries a link with a random token, valid for 90 days; only its SHA-256 hash is stored. Opening the link reveals the card. Resending issues a new link and the old one stops working. Voiding a card cancels a pending email and disables its link. Sending is retried with backoff (5 attempts, 10 s timeout each) and is at least once: if a timed-out send actually arrived, the recipient may get a second email, and only the newest link works.
- **Audit.** Program changes, issuing, state changes, lockouts and resends are written to `audit_logs`, in the same transaction as the change, with emails masked. Audit rows are kept indefinitely. Like the ledger, the table rejects `UPDATE` and `DELETE` for every role, so redacting a row needs a deliberate one-off migration run as the admin (owner) role.
- **Logs** never contain card numbers, PINs, link tokens, full email addresses or SQL parameters. Database errors are logged as their code, constraint and table only.

**Landing page (not in this repo).** `GIFT_CARD_LINK_BASE_URL` points at a page that must: remove the token from the address bar (`history.replaceState`), POST it to `/gift-card-links/reveal`, render every field with `textContent` (never `innerHTML`), use a strict Content Security Policy and no third-party scripts. Add its origin to `CORS_ORIGIN`.

**Threat model.** The encryption protects card data if the database is read by someone who shouldn't: a leaked backup or replica, read-only SQL injection, logged SQL parameters. It doesn't protect against someone who can *write* to the database as the app role: they could already change balances. Protect the app-role database credentials as carefully as the card keys.

**Trying it locally.** With `NODE_ENV=development` and `GIFT_CARD_DEV_PRINT_LINKS=true`, issuing a card prints its link to the console. Copy the `token` from it and POST it to `/gift-card-links/reveal` to see the card number and PIN, then redeem with them.

## Database migrations

The schema is managed only through migrations in `src/migrations/`. The app never changes the schema itself. Migrations run as the admin role.

```bash
npm run migration:run                                   # apply pending migrations
npm run migration:revert                                # undo the most recent one
npm run migration:show                                  # list applied / pending
npm run migration:generate -- src/migrations/AddXyz     # write a migration from entity changes
npm run migration:check                                 # fail if entities and schema differ
npm run migration:run:prod                              # apply using the compiled dist/ files
```

Expired refresh tokens are deleted automatically for users who log in or refresh. To clean up rows of users who never return, run the purge script periodically (e.g. a daily cron job or scheduled task):

```bash
npm run tokens:purge          # ts-node
npm run tokens:purge:prod     # compiled dist/ files
```

Gift card emails are sent by a dispatcher. Issuing and resending try to send right away; run the dispatch script **every minute** (cron or a scheduled task) to send scheduled emails and retry failed ones:

```bash
npm run deliveries:dispatch          # ts-node
npm run deliveries:dispatch:prod     # compiled dist/ files
```

It needs only the database settings and `GIFT_CARD_LINK_BASE_URL`, not the card keys or `JWT_SECRET`.

**Deploy order.** Run migrations before starting a new version: the API checks the card keys against `gift_card_key_checks` at startup and refuses to start without that table. Note that `DB_LOGGING=true` now stops the API from starting in production, so unset it before deploying.

To change the schema: edit the entity, run `migration:generate`, review the generated SQL, run `migration:run`, and commit the migration together with the code. Don't edit a migration that has already been applied anywhere that matters. Add a new one instead.

## Testing and linting

```bash
npm test                    # unit tests (no database needed)
npm run test:integration    # integration tests against PostgreSQL
npm run lint                # ESLint (lint:fix to auto-fix)
npm run typecheck           # tsc over src/ and test/
```

Integration tests need the Docker database running. They automatically use `<DB_DATABASE>_test`, apply migrations to it, and empty its tables between tests. As a safety net, they **refuse to run against any database whose name doesn't end in `_test`** (override with `TEST_DB_DATABASE` only if you know what you're doing). Your development data is never touched.

## Continuous integration

`.github/workflows/ci.yml` runs on every pull request and every push to `main`:

- **checks** (Node 22 and 24): `npm ci`, lint, typecheck, build, unit tests.
- **integration** (Node 24): starts PostgreSQL with this repo's `docker-compose.yml` (so the role setup is tested too), runs migrations, `migration:check`, the integration tests, and a boot smoke test of the compiled server running as the app role.

## Project status

_Last reviewed: 2026-11-13. All checks pass locally: lint, typecheck, build, 129 unit tests, 207 integration tests and the migration drift check._

### Known limitations

- **Gift emails are only logged, not sent.** There's no email provider yet; the default sender logs the delivery id and recipient domain. Before adding one: per-tenant send caps (so the API can't be used to send unwanted email) and HTML-escaped templates.
- **No card listing or search**, and no public balance check (recipients use their link). List endpoints will come with pagination.
- **No key rotation.** A new key needs a new key id; re-encrypting existing cards isn't built.
- **No reloads, no payment taking, no physical cards, single currency per card.** Expiry rules beyond "promotional only" (e.g. for GCC markets) need a per-country rules engine and a legal review per market.
- **Card lookup timing.** An unknown card number answers slightly faster than a known one with a wrong PIN. The rate limits and the PIN lockout make this impractical to exploit, and it's an accepted residual.
- **No subdomain routing.** Tenants have a `subdomain`, but requests aren't resolved by `Host` header yet. The tenant comes from the access token.
- **Emails are unique across all tenants.** One person can't belong to two tenants with the same email, and a `409 Email already registered` on `POST /users` or `POST /tenants` reveals that an address exists in *some* tenant. Fixing this needs per-tenant emails and a tenant-aware login (e.g. by subdomain).
- **Access tokens are stateless.** They stay valid for up to 15 minutes after logout or theft detection, and a demoted admin keeps admin rights until their access token expires. Role changes apply on the next refresh.
- **Rate limits are in memory.** Limits are per IP (and per user for gift card issue, lookup, redeem and resend). There is no per-account login throttling, and counters aren't shared between server instances. Set `TRUST_PROXY=true` behind a proxy, or every client shares one limit.
- `GET /users` has no pagination.
- **A refresh retried more than 10 seconds after a lost response logs the user out everywhere.** For example, the server rotated the token but the response never reached a mobile client. That retry is indistinguishable from a stolen token being replayed, and this is the standard trade-off of refresh-token rotation with reuse detection. Clients should retry failed refreshes promptly (within 10 seconds) or send the user to log in again.
- Request validation is strict: wrong types are rejected rather than coerced (a numeric `password` gets `400`). Future querystring or params schemas must parse numbers and booleans themselves.
- Audit rows are kept indefinitely. Set a retention period with the privacy policy (e.g. Quebec's Law 25 limits how long personal data may be kept).

### Security notes

- MariaDB data files and an old MariaDB root password were committed in earlier history. They were removed from the tree, but still exist in git history. Don't reuse that password anywhere.
- The Docker admin role is a Postgres superuser. Outside local development, use a dedicated schema-owner role instead.

## Roadmap

1. A real email provider for gift deliveries (with send caps and escaped templates), and the recipient landing page.
2. Gift card listing and search with pagination; card key rotation.
3. Subdomain-based tenant resolution and per-tenant settings.
4. User management endpoints (update role, deactivate, reset password), with session-aware access tokens so role changes and logout take effect immediately.
5. Per-tenant emails with tenant-aware login. Per-account login throttling and a shared rate-limit store (e.g. Redis) for multiple instances. Pagination for list endpoints.
6. Reloads, payment taking, and per-country gift card rules for GCC markets.
7. API documentation (OpenAPI via `@fastify/swagger`).

## Author

Maintained by [@engmsalem](https://github.com/engmsalem).

## License

`package.json` declares the **ISC** license, but the repo has no `LICENSE` file yet. Add one to make the license explicit.
