# Known limitations

## Gift cards

- **Gift emails are only logged, not sent.** There's no email provider yet; the default sender
  logs the delivery id and recipient domain. Because of this, the app refuses to start with
  `NODE_ENV=production`. Before adding a provider: per-tenant send caps (so the API can't be used
  to send unwanted email) and HTML-escaped templates.
- **No card listing or search**, and no public balance check (recipients use their link). List
  endpoints will come with pagination.
- **No key rotation.** Card keys can't be changed once cards exist; re-encrypting existing cards
  isn't built (see [Card keys](configuration.md#card-keys)).
- **No reloads, no payment taking, no physical cards, single currency per card.** Expiry rules
  beyond "promotional only" (e.g. for GCC markets) need a per-country rules engine and a legal
  review per market.
- **Card lookup timing.** An unknown card number answers slightly faster than a known one with a
  wrong PIN. The rate limits and the PIN lockout make this impractical to exploit, and it's an
  accepted residual.

## Tenants and users

- **No subdomain routing.** Tenants have a `subdomain`, but requests aren't resolved by `Host`
  header yet. The tenant comes from the access token.
- **Emails are unique across all tenants.** One person can't belong to two tenants with the same
  email, and a `409 Email already registered` on `POST /users` or `POST /tenants` reveals that an
  address exists in *some* tenant. Fixing this needs per-tenant emails and a tenant-aware login
  (e.g. by subdomain).
- `GET /users` has no pagination.
- Audit rows are kept indefinitely. Set a retention period with the privacy policy (e.g. Quebec's
  Law 25 limits how long personal data may be kept).

## Authentication

- **Access tokens are stateless.** They stay valid for up to 15 minutes after logout or theft
  detection, and a demoted admin keeps admin rights until their access token expires. Role changes
  apply on the next refresh.
- **A refresh retried more than 10 seconds after a lost response logs the user out everywhere.**
  For example, the server rotated the token but the response never reached a mobile client. That
  retry is indistinguishable from a stolen token being replayed, and this is the standard
  trade-off of refresh-token rotation with reuse detection. Clients should retry failed refreshes
  promptly (within 10 seconds) or send the user to log in again.

## Infrastructure

- **Rate limits are in memory.** Limits are per IP (and per user for gift card issue, lookup,
  redeem and resend). There is no per-account login throttling, and counters aren't shared between
  server instances. Set `TRUST_PROXY=true` behind a proxy, or every client shares one limit.
- Request validation is strict: wrong types are rejected rather than coerced. Future querystring
  or params schemas must parse numbers and booleans themselves.
