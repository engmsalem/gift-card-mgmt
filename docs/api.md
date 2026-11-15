# API reference

All request and response bodies are JSON. Requests and responses are validated against Fastify
JSON schemas.

## Conventions

- **Authentication:** send the access token as `Authorization: Bearer <token>`. The tenant always
  comes from the token, never from the request body.
- **Validation is strict.** Unknown body fields are rejected with `400`, and wrong types are
  rejected rather than coerced (a numeric `password` gets `400`).
- **Errors** are `{ "error": "<message>" }` with:

  | Status | Meaning |
  | ------ | ------- |
  | `400` | Validation failed |
  | `401` | Missing or invalid token, or bad credentials |
  | `403` | Wrong role |
  | `404` | Not found |
  | `409` | Duplicate, or a conflicting change |
  | `429` | Rate limit exceeded |
  | `503` | A concurrent database conflict; comes with `Retry-After` and is safe to retry |

- **Rate limits:** 100 requests per minute per IP unless an endpoint says otherwise.
- **Amounts** are integers in the currency's minor unit (cents for CAD; KWD, BHD and OMR have 3
  decimals). Responses include `currencyExponent` so clients can format them.
- Password hashes are never returned (excluded from queries and stripped by response schemas).

## Tenants, authentication and users

| Method | Path | Auth | Body | Response |
| ------ | ---- | ---- | ---- | -------- |
| POST | `/tenants` | none | `{ tenant: { name, subdomain }, admin: { name, email, password } }` | `201 { tenant, user }`. Creates the tenant and its first `admin` in one transaction. `409` if the subdomain or email is taken. 5 / minute |
| POST | `/auth/login` | none | `{ email, password }` | `200 { accessToken, refreshToken, expiresIn }`. `401` on bad credentials. 10 / minute |
| POST | `/auth/refresh` | none | `{ refreshToken }` | `200` with a **new** token pair. The old refresh token stops working |
| POST | `/auth/logout` | none | `{ refreshToken }` | `204`. Revokes the refresh token (idempotent) |
| GET | `/users/me` | Bearer | none | `200` own profile |
| GET | `/users` | Bearer, admin | none | `200` users of the caller's tenant |
| POST | `/users` | Bearer, admin | `{ name, email, password, role? }` | `201`. Creates a user in the caller's tenant (`role` defaults to `staff`) |

Field rules: `subdomain` is 3–50 characters (lowercase letters, digits and hyphens); `password`
is 8–72 characters; emails are trimmed and lowercased.

## Gift card programs

All need a Bearer token.

| Method | Path | Role | Body | Response |
| ------ | ---- | ---- | ---- | -------- |
| POST | `/gift-card-programs` | admin | `{ name, cardType, currency, country, region?, cardNumberPrefix, cardNumberLength, pinRequired, maxValue, expiryMonths?, staffDailyIssueLimit? }` | `201` program |
| GET | `/gift-card-programs` | admin, staff | none | `200` the tenant's programs |
| GET | `/gift-card-programs/:id` | admin, staff | none | `200` program |
| PATCH | `/gift-card-programs/:id` | admin | Any non-empty subset of the fields, or `status: "retired"` | `200` program. `409` (naming the fields) when changing currency, prefix, length or another fixed field after the first card |

## Gift cards

All need a Bearer token.

| Method | Path | Role | Body | Response |
| ------ | ---- | ---- | ---- | -------- |
| POST | `/gift-cards` | admin, staff | `{ programId, amount, idempotencyKey, recipient: { name, email }, senderName, message?, sendAt? }` | `201 { card, delivery }`. A replay of the same request returns `200` + `Idempotent-Replayed: true`, and retries the email if its first send failed and is due again. 60 / minute per user |
| GET | `/gift-cards/:id` | admin, staff | none | `200 { card, delivery }` |
| GET | `/gift-cards/by-reference/:reference` | admin, staff | none | `200 { card, delivery }`, found by the printed reference number |
| GET | `/gift-cards/:id/transactions` | admin, staff | none | `200` ledger rows, oldest first |
| POST | `/gift-cards/lookup` | admin, staff | `{ cardNumber, pin? }` | `200 { card }`. 30 / minute per user |
| POST | `/gift-cards/redeem` | admin, staff | `{ cardNumber, pin?, amount, idempotencyKey, externalReference? }` | `201 { transaction, card }`; replay `200`. 30 / minute per user |
| POST | `/gift-card-transactions/:id/refunds` | admin | `{ amount, idempotencyKey }` | `201 { transaction, card }`; replay `200`. Refunds part or all of a redemption |
| POST | `/gift-cards/:id/suspend`, `/resume`, `/void`, `/unlock` | admin | none | `200 { card, delivery }`. Repeating an action that's already in effect returns `200` |
| POST | `/gift-cards/:id/resend` | admin, staff | `{ recipient?: { name?, email? } }` | `200 { delivery }` with a new link; the old one stops working. An email scheduled for later keeps its `sendAt`. Only admins may change the recipient. 10 / minute per user |

Card numbers and PINs only ever appear in the reveal response. Everywhere else a card shows
`last4` and `referenceNumber`.

## Gift links (public)

| Method | Path | Auth | Body | Response |
| ------ | ---- | ---- | ---- | -------- |
| POST | `/gift-card-links/reveal` | none | `{ token }` | `200` card number, PIN, balance, sender and message. `Cache-Control: no-store`. 30 / minute per IP |

The token is the 43-character value after `#token=` in the gift link.

## Tokens

- **Access token:** a JWT (HS256, signed with `JWT_SECRET`), valid for **15 minutes**, with claims
  `sub` (user UUID), `tid` (tenant UUID), `role` and `typ: "access"`.
- **Refresh token:** a random opaque string, valid for **7 days**. Only its SHA-256 hash is stored.
- **Rotation.** Each refresh revokes the old refresh token and returns a new pair. Rotation is
  atomic: if issuing the new pair fails, the old token stays valid. Every revocation records a
  reason (`rotated`, `logout`, `reuse`, `evicted`).
- **Reuse detection.** Presenting a token that was **rotated** more than **10 seconds** ago is
  treated as theft, and **all** of that user's refresh tokens are revoked, forcing a new login.
  Within those 10 seconds (two tabs or a client retry racing on the same token), or for a token
  revoked by logout or eviction, the request just gets `401`.
- **Session limit.** A user can have at most **10** active refresh tokens. Logging in again
  revokes the oldest.
- Access tokens can't be revoked early. After logout they stay valid until they expire (at most 15
  minutes).
