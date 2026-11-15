# Architecture

## Layering

**Routes → services → TypeORM repositories.** The `DataSource` is exposed to services as a Fastify
decorator (`fastify.db`).

Configuration is loaded only by the entry points (`src/index.ts`, `src/migration-data-source.ts`,
`src/scripts/`) and passed down explicitly. Importing any other module doesn't read the
environment, load `.env` or open connections (the only global effect is the `reflect-metadata`
polyfill TypeORM needs), so tests can build apps with their own config.

`src/gift-cards/` holds the pure gift card rules. It imports no database, framework or config
code, and ESLint enforces that.

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
├── gift-cards/              # Pure gift card rules: card numbers, money/countries, program rules,
│                            # card states, card crypto, delivery tokens, request hashes, email masking
├── delivery/                # Email senders: log-only (default) and the development console sender
├── plugins/
│   ├── error-handler.ts     # Maps errors to status codes; logs database errors without parameters
│   ├── jwt.ts               # Access token signing/verification, `authenticate`, `requireRole`
│   └── rate-limit.ts        # 100 requests / minute per IP (login: 10, tenant signup: 5)
├── routes/                  # Tenant, auth, user, gift card program, gift card and gift card link routes
├── services/                # Tenant, Auth, User, GiftCardProgram, GiftCard, Redemption, Delivery services,
│                            # the delivery dispatcher, audit writer and startup key check
├── scripts/                 # Cron entry points: purge expired refresh tokens, dispatch gift card emails
└── types/requests.d.ts      # Fastify / JWT type augmentations

test/
├── unit/                    # No database needed
├── integration/             # Real PostgreSQL via app.inject(); helpers.ts sets up the test DB
└── support/                 # test-db.ts (refuses to reset any database not named *_test),
                             # lock-staging.ts (deterministic concurrency tests), recording sender

db/
├── init/01-app-role.sh      # Docker first-start script: creates the app role and the _test database
└── setup-local.sh           # The same setup for a locally installed PostgreSQL (no Docker)

docs/                        # Configuration, API, operations, security; design/ holds design documents
docker-compose.yml           # PostgreSQL, configured from .env
.github/workflows/ci.yml     # CI pipeline
```

## Data model

Defined by the migrations in `src/migrations/`. All tenant-owned tables carry a `tenant_id`: one
shared database, isolated by tenant.

| Table | Purpose |
| ----- | ------- |
| `tenants` | Merchants, each with a unique `subdomain` |
| `users` | Tenant staff: `name`, globally unique `email`, `role` (`admin` / `staff`) |
| `refresh_tokens` | SHA-256 hashes of issued refresh tokens, with expiry and revocation |
| `gift_card_programs` | A tenant's gift card offerings: type (paid / promotional), currency, country and region, number prefix and length, PIN required, max value, expiry, staff daily limit |
| `gift_cards` | Encrypted card number and PIN, HMAC lookup hash, last 4 digits, reference number, balance, status |
| `gift_card_transactions` | Append-only ledger: `issue`, `redeem`, `refund`, `void`, with idempotency keys |
| `gift_card_deliveries` | Recipient, message, scheduled send time, delivery status, hashed link token |
| `gift_card_key_checks` | Check values (not keys) that detect a wrong card key at startup. Internal: no entity in the API |
| `audit_logs` | Append-only JSON (`jsonb`) log of sensitive actions per tenant and user, emails masked |

The database enforces the important invariants itself: a card's tenant and currency must match its
program's, a ledger row's must match its card's, balances can't go negative, and the ledger and
audit log reject `UPDATE` and `DELETE`.

**Ids are UUIDv7**, generated by PostgreSQL (`DEFAULT uuidv7()`, built into PostgreSQL 18) and
returned as strings in the API, e.g. `"01a1d1a8-a62b-7303-ae9d-dcf7dbad406a"`. Unlike sequential
integers, they don't reveal how many tenants or users exist and can't be guessed. Unlike random
UUIDv4, they're time-ordered, so inserts and indexes stay efficient. Don't rely on ids for
sorting: list endpoints order by `created_at`.
