# Configuration

The app reads its settings from environment variables, usually from a `.env` file in the project
root (`cp .env.example .env`). Docker Compose and `db/setup-local.sh` read the same file. Variables
already set in the environment take precedence.

The app refuses to start if anything is missing or invalid, and lists every problem at once.

## Environment variables

### Server

| Variable | Required | Default | Notes |
| -------- | -------- | ------- | ----- |
| `HOST` | no | `localhost` | Interface to listen on. Use `0.0.0.0` in Docker or production so the server is reachable from outside the container or host |
| `PORT` | no | `3000` | HTTP port |
| `NODE_ENV` | no | `development` | Exactly `development`, `test` or `production`; anything else (e.g. `Production`, `staging`) is refused. `production` turns on the production safeguards and lowers log verbosity |
| `TRUST_PROXY` | no | `false` | `true` behind a reverse proxy or load balancer, so rate limits use the real client IP (`X-Forwarded-For`). Leave `false` otherwise: clients could spoof their IP |

### Database

| Variable | Required | Default | Notes |
| -------- | -------- | ------- | ----- |
| `DB_HOST` | no | `localhost` | |
| `DB_PORT` | no | `5432` | With Docker, also the host port PostgreSQL is published on. Pick another (e.g. `5434`) if 5432 is taken |
| `DB_DATABASE` | yes | none | e.g. `gift_card_mgmt`. `<DB_DATABASE>_test` is created alongside it for the integration tests |
| `DB_USERNAME` | yes | none | **App role**: reads and writes rows, can't change the schema |
| `DB_PASSWORD` | yes | none | |
| `DB_ADMIN_USERNAME` | yes\* | `DB_USERNAME` | **Admin role** (schema owner), used only by migrations. Set both admin variables or neither (neither = use the app credentials). \*Required by Docker Compose and `db/setup-local.sh`, and must differ from `DB_USERNAME` |
| `DB_ADMIN_PASSWORD` | yes\* | `DB_PASSWORD` | |
| `DB_LOGGING` | no | `false` | `true` logs every SQL statement with its parameters. Refused when `NODE_ENV=production` |

### Authentication

| Variable | Required | Default | Notes |
| -------- | -------- | ------- | ----- |
| `JWT_SECRET` | yes | none | At least 32 characters. Generate one: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |

### Gift cards

| Variable | Required | Default | Notes |
| -------- | -------- | ------- | ----- |
| `CARD_ENCRYPTION_KEY` | yes | none | Encrypts card numbers and PINs (AES-256-GCM). 64 hex characters: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. See [Card keys](#card-keys) |
| `CARD_LOOKUP_KEY` | yes | none | Keyed hash (HMAC-SHA256) for finding cards by number. Same format; must differ from the encryption key |
| `CARD_ENCRYPTION_KEY_ID` | no | `1` | Integer 1–32767. Don't change it once cards exist |
| `CARD_LOOKUP_KEY_ID` | no | `1` | Integer 1–32767. Don't change it once cards exist |
| `GIFT_CARD_LINK_BASE_URL` | no\* | `http://localhost:3000/gift` | The landing page gift emails link to; the token is appended as `#token=...`. \*Required in production, and must be `https` |
| `GIFT_CARD_DEV_PRINT_LINKS` | no | `false` | `true` prints gift links to the console so you can open them by hand. Refused unless `NODE_ENV=development` |

### CORS

| Variable | Required | Default | Notes |
| -------- | -------- | ------- | ----- |
| `CORS_ORIGIN` | no\* | `*` | One origin, or a comma-separated list. \*Required when `NODE_ENV=production` (set `*` explicitly to allow any origin) |
| `CORS_METHODS` | no | `GET,POST,PUT,PATCH,DELETE` | Comma-separated |
| `CORS_ALLOWED_HEADERS` | no | `Content-Type,Authorization` | Comma-separated. Browsers can always read the `Idempotent-Replayed` and `Retry-After` response headers |

## Example `.env` for local development

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
JWT_SECRET=<output of the JWT_SECRET command above>
CARD_ENCRYPTION_KEY=<64 hex characters>
CARD_LOOKUP_KEY=<a different 64 hex characters>
GIFT_CARD_DEV_PRINT_LINKS=true
```

## What each entry point needs

Configuration is loaded only by the entry points and passed down explicitly.

- **API** (`src/index.ts`): the full configuration.
- **Migrations and the refresh-token purge script:** only the database settings, so they don't
  need `JWT_SECRET`, the card keys or `CORS_ORIGIN`.
- **Delivery dispatcher:** the database settings and `GIFT_CARD_LINK_BASE_URL`.

## Card keys

- **Back up both card keys (e.g. in a secret manager) before the first start.** The first start
  records a check value for each key id. After that, starting with a different key under the same
  id fails with `CARD_ENCRYPTION_KEY does not match the key recorded for key id 1`. A lost
  encryption key means the stored card numbers and PINs can't be read again.
- **Don't change either key or its id once cards exist.** Every card records the ids of the keys
  that protect it, and the app holds one key of each kind. Re-encrypting existing cards under a new
  key (rotation) isn't built yet. So the startup check refuses to start if any card uses an id
  other than the loaded `CARD_ENCRYPTION_KEY_ID` / `CARD_LOOKUP_KEY_ID`; the error names the
  variable and the ids. The fix is to restore the original key and id. A new key with a new id is
  only safe while no cards exist.
- **Key-check reset:** if a check value was recorded for a key you never used for real cards,
  delete its row from `gift_card_key_checks` as the admin role. The startup check refuses this
  situation if any card still uses that key id.
- The published test and CI keys in this repo are refused when `NODE_ENV=production`.
