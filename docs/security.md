# Security

## Threat model

The card encryption protects card data if the database is read by someone who shouldn't: a leaked
backup or replica, read-only SQL injection, logged SQL parameters. It doesn't protect against
someone who can *write* to the database as the app role: they could already change balances.
Protect the app-role database credentials as carefully as the card keys.

## Database roles

The API connects as the **app role**, which can only read and write rows. If the API is ever
compromised, the attacker can't drop tables, create roles or reach other databases. Schema changes
need the **admin role**, which only migrations use.

- In production, keep the admin credentials out of the API server's environment and use them only
  in the deploy step that runs migrations.
- The Docker admin role is a PostgreSQL superuser. `db/setup-local.sh` creates a non-superuser
  owner instead, granted `pg_read_all_stats` for the integration tests. Outside local development,
  use a dedicated schema-owner role without that grant.

## Built-in protections

- Card numbers and PINs are encrypted (AES-256-GCM) and bound to their card and tenant. See
  [How gift cards work](gift-cards.md#cards) and [Card keys](configuration.md#card-keys).
- Only hashes are stored for refresh tokens and gift link tokens (SHA-256) and for passwords
  (bcrypt).
- Card lookups give the same `404` for every failure, with a PIN lockout and per-user rate limits.
- The ledger and the audit log reject `UPDATE` and `DELETE` for every role.
- Logs leave out card data, tokens, full email addresses and SQL parameters.
- Production safeguards: the published test keys, `DB_LOGGING=true`, a missing `CORS_ORIGIN` and a
  non-`https` gift link URL are refused when `NODE_ENV=production`.

## Accepted residual risks

- **Card lookup timing.** An unknown card number answers slightly faster than a known one with a
  wrong PIN. The rate limits and the PIN lockout make this impractical to exploit.
- **Stateless access tokens** stay valid for up to 15 minutes after logout or theft detection.
- **Emails are unique across all tenants**, so a `409 Email already registered` reveals that an
  address exists in *some* tenant.

See [Known limitations](limitations.md) for the full list.
