# Gift Card Management API

A multi-tenant API for issuing, delivering and redeeming digital gift cards.

[![CI](https://github.com/engmsalem/gift-card-mgmt/actions/workflows/ci.yml/badge.svg)](https://github.com/engmsalem/gift-card-mgmt/actions/workflows/ci.yml)

Merchants (tenants) define gift card programs; their staff issue cards, email them to recipients,
and redeem and refund balances, with a full audit trail.

> **Status: work in progress.** Tenants, users, authentication and digital gift cards are
> implemented and tested. Gift emails are only logged for now, not sent, so the API doesn't start
> in production yet. See the [roadmap](#roadmap).

## Features

- **Multi-tenant**: one shared database, every row scoped to its tenant; the tenant always comes
  from the caller's token.
- **Gift card programs**: paid or promotional, per-currency and per-country, with configurable
  card number formats, PINs, maximum values and expiry rules.
- **Secure cards**: card numbers and PINs encrypted with AES-256-GCM and found by HMAC; PIN
  lockout; identical errors for every failed lookup.
- **Safe balances**: an append-only ledger, no overdrafts under concurrent requests, and
  idempotent issue, redeem and refund.
- **Email delivery**: scheduled sending, retries with backoff, and expiring reveal links that a resend or void disables.
- **Authentication**: short-lived JWT access tokens and rotating refresh tokens with reuse
  detection; `admin` and `staff` roles.
- **Audit log**: sensitive actions recorded in the same transaction, emails masked.

## Tech stack

Node.js and TypeScript · [Fastify 5](https://fastify.dev/) · [TypeORM 1.x](https://typeorm.io/) ·
PostgreSQL 18 · `node:test` · ESLint 9 · GitHub Actions

## Quick start

### Prerequisites

- Node.js **22.13+ or 24.11+**
- PostgreSQL 18, either through **Docker Compose** or a **local install**

### 1. Configure

```bash
cp .env.example .env
```

Fill in the database credentials and generate the secrets. Every variable is described in
[Configuration](docs/configuration.md). **Back up the two card keys before the first start**: card
data can't be decrypted without them (see [Card keys](docs/configuration.md#card-keys)).

### 2. Start PostgreSQL

**Option A: Docker**

```bash
docker compose up -d --wait
```

On first start this creates the admin role, the app role, `DB_DATABASE` and `DB_DATABASE_test`.
The roles and databases are only created **the first time** the `postgres_data` volume is
initialised. If you change any `DB_*` credentials later, reset it with `docker compose down -v`
(this deletes all data). SQL shell: `docker compose exec postgres psql -U <DB_ADMIN_USERNAME> -d <DB_DATABASE>`.

**Option B: local PostgreSQL (no Docker)**

Set `DB_HOST` and `DB_PORT` in `.env` to your server, then run, in Git Bash on Windows or any
POSIX shell:

```bash
bash db/setup-local.sh
```

It connects as a superuser (`PGUSER`, default `postgres`; it asks for the password unless
`PGPASSWORD` is set) and creates the same roles and databases as the Docker setup. It's safe to
re-run: existing roles get their passwords reset to the `.env` values and existing databases are
kept. Unlike Docker's, the admin role is not a superuser.

### 3. Install, migrate and run

```bash
npm install
npm run migration:run     # create or upgrade the schema (admin role)
npm run dev               # start with ts-node on http://localhost:3000
```

For a compiled build: `npm run build && npm run migration:run:prod && npm start`.

### 4. Try it

With `GIFT_CARD_DEV_PRINT_LINKS=true` in `.env`, gift links are printed to the app's console.

```bash
# Create a tenant and its first admin
curl -X POST localhost:3000/tenants -H "Content-Type: application/json" \
  -d '{"tenant":{"name":"Acme","subdomain":"acme"},"admin":{"name":"Ada","email":"ada@acme.com","password":"correct-horse"}}'

# Log in -> { accessToken, refreshToken, expiresIn }
curl -X POST localhost:3000/auth/login -H "Content-Type: application/json" \
  -d '{"email":"ada@acme.com","password":"correct-horse"}'

# Create a program (amounts are in cents) -> { id, ... }
curl -X POST localhost:3000/gift-card-programs -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{"name":"Store card","cardType":"paid","currency":"CAD","country":"CA","cardNumberPrefix":"7001","cardNumberLength":16,"pinRequired":true,"maxValue":50000}'

# Issue a $25 card; its link (…#token=<token>) appears in the app's console
curl -X POST localhost:3000/gift-cards -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{"programId":"<program id>","amount":2500,"idempotencyKey":"first-card-0000001","recipient":{"name":"Bob","email":"bob@example.com"},"senderName":"Ada"}'

# Open the link as the recipient would -> { cardNumber, pin, balance, ... }
curl -X POST localhost:3000/gift-card-links/reveal -H "Content-Type: application/json" \
  -d '{"token":"<token>"}'

# Spend $10 -> { transaction, card: { balance: 1500, ... } }
curl -X POST localhost:3000/gift-cards/redeem -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{"cardNumber":"<cardNumber>","pin":"<pin>","amount":1000,"idempotencyKey":"first-redeem-000001"}'
```

In PowerShell, use `Invoke-RestMethod` or a REST client instead of these single-quoted bodies.

## Development

```bash
npm test                    # unit tests (no database needed)
npm run test:integration    # integration tests against PostgreSQL
npm run lint                # ESLint (lint:fix to auto-fix)
npm run typecheck           # tsc over src/ and test/
npm run migration:check     # fail if the entities and the schema differ
```

Integration tests use `<DB_DATABASE>_test`: they apply the migrations to it and empty its tables
between tests. As a safety net, they **refuse to run against any database whose name doesn't end
in `_test`** (override with `TEST_DB_DATABASE` only if you know what you're doing), so your development data is never touched.

**CI** (`.github/workflows/ci.yml`) runs two jobs on every pull request and every push to `main`:

- **checks** (Node 22 and 24): lint, typecheck, build and unit tests.
- **integration** (Node 24): starts PostgreSQL from this repo's `docker-compose.yml`, so the role
  setup is tested too. It then runs the migrations, the drift check, the integration tests, and a
  boot smoke test of the compiled server running as the app role.

**Debugging:** start the server with the inspector, then attach your editor's debugger to port 9229:

```bash
node --inspect --no-experimental-strip-types -r ts-node/register src/index.ts
```

## Documentation

| Document | Contents |
| -------- | -------- |
| [Configuration](docs/configuration.md) | Environment variables, card keys |
| [API reference](docs/api.md) | Endpoints, errors, rate limits, tokens |
| [How gift cards work](docs/gift-cards.md) | Programs, cards, ledger, idempotency, delivery, landing page |
| [Architecture](docs/architecture.md) | Layering, project structure, data model |
| [Operations](docs/operations.md) | Migrations, scheduled jobs, deploying, logs |
| [Security](docs/security.md) | Threat model, database roles, residual risks |
| [Known limitations](docs/limitations.md) | What isn't built yet, and accepted trade-offs |
| [Gift card design](docs/design/gift-cards.md) | The reviewed design behind the gift card feature |

## Roadmap

Before production:

1. A real email provider for gift deliveries, with per-tenant send caps and HTML-escaped templates.
2. The recipient landing page that gift links open.
3. Sessions: session-aware access tokens, so a role change or logout takes effect immediately.
   Plus user management endpoints (update role, deactivate, reset password).
4. Tenant-aware login: per-tenant emails (which also closes the cross-tenant email check) and
   subdomain-based tenant resolution. It changes the login API, so it should land before outside
   clients integrate.
5. Card key rotation: re-encrypting existing cards under a new key.
6. A shared rate-limit store (e.g. Redis) for multiple instances, and per-account login throttling.

After launch:

7. Gift card listing and search, and pagination for list endpoints (including `GET /users`).
8. API documentation (OpenAPI via `@fastify/swagger`).
9. Reloads and payment taking.
10. GCC markets: per-country gift card rules, a legal review per market, 3-decimal currencies.
11. On client demand: physical cards, a public balance check, cross-currency.

## Contributing

Issues and pull requests are welcome. Only maintainers can merge, and every change goes through a
pull request with CI passing. New dependencies must use a permissive license (MIT, Apache-2.0,
BSD, ISC or similar): no copyleft (GPL, LGPL, AGPL). By submitting a pull request you agree that
your contribution is licensed under Apache-2.0.

## License

Copyright 2025–2026 [@engmsalem](https://github.com/engmsalem). Licensed under the
[Apache License 2.0](LICENSE); see [NOTICE](NOTICE).
