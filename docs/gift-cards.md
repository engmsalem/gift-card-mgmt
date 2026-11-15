# How gift cards work

Digital gift cards, sent to a recipient by email. This page describes the behaviour; the full
design, including the review that led to it, is in [`design/gift-cards.md`](design/gift-cards.md).
The endpoints are in the [API reference](api.md#gift-cards).

## Programs

Each tenant defines programs: paid or promotional, one currency, a country (ISO 3166-1, e.g. `CA`)
and an optional region (`CA-QC`). Card type, currency, country, region, prefix and number length
are fixed once the program has issued a card. Programs are retired, never deleted, and a retired
program can be made active again.

## Cards

- **Card numbers** are 16–19 digits: the program prefix (4–6 digits starting with 7, 8 or 9,
  outside payment-card ranges), random digits from a cryptographic generator, and a Luhn check
  digit. Programs without a PIN must use 19 digits, so numbers are much harder to guess.
- **PINs** are 6 random digits, when the program requires one.
- **Storage.** Numbers and PINs are encrypted with AES-256-GCM, bound to their card and tenant so
  a ciphertext can't be copied to another row. Cards are found by an HMAC of the number under a
  separate key. Only the last 4 digits are stored in clear. See [Card keys](configuration.md#card-keys).
- **States:** `active`, `suspended`, `depleted` (balance 0), `voided`, `expired`. Paid cards never
  expire. Only promotional cards can have an expiry (Canadian provinces ban expiry on paid gift
  cards). There are no fees.

## Balances

- **Ledger.** Every balance change is a ledger row (`issue`, `redeem`, `refund`, `void`), and the
  ledger can't be edited. Redemptions can't overdraw a card, even when requests arrive at the same
  time.
- **Idempotency.** Issue, redeem and refund take an `idempotencyKey` (16–64 letters, digits, `_`
  or `-`), unique per tenant across all three. Retrying the same request returns the original
  result with `Idempotent-Replayed: true`. Reusing a key for a different request is `409`.
- **Redeem retries** are checked like a new request first: card number, PIN and lockout. Without
  that, retries could be used to probe cards. So if the card was PIN-locked in the meantime, the
  retry gets the same `404` as a wrong PIN rather than the original result. Staff can then see
  whether the redemption went through in the card's transaction history
  (`GET /gift-cards/:id/transactions`).

## Access control

- **PIN lockout.** 5 wrong PINs lock the card for 30 minutes; an admin can unlock it. An unknown
  number, a wrong or missing PIN, a locked card and another tenant's card all get the same
  `404 Invalid card number or PIN`. A missing PIN doesn't count towards the lockout.
- **Staff limits.** Staff can issue paid cards only if an admin set a `staffDailyIssueLimit` on the
  program, and only up to that total per staff member, per program, in any rolling 24 hours. Promotional cards, refunds, suspend,
  resume, void and unlock are admin only.

## Delivery

- Issuing a card schedules an email to the recipient, immediately or at `sendAt` (up to 365 days
  ahead; a past `sendAt` sends right away). The email carries a link with a random token, valid for
  90 days; only the token's SHA-256 hash is stored. Opening the link reveals the card.
- A due email for a card that has since been voided or has expired is marked `cancelled`, not sent.
- **Resending** issues a new link, and the old one stops working.
- **Voiding** a card cancels an email that hasn't been sent yet and disables the link. An email
  already sent keeps its `sent` status, so the history stays accurate.
- **Retries.** Sending is retried with backoff (5 attempts, 10 s timeout each). A send interrupted
  by a crash is picked up again after a 10-minute lease and counts as an attempt; after the 5th,
  the delivery is marked `failed` (`LeaseExpired`).
- Sending is **at least once**: if a timed-out send actually arrived, the recipient may get a
  second email, and only the newest link works.
- Emails are only logged for now; no email provider is built yet. See
  [Scheduled jobs](operations.md#scheduled-jobs).

## Landing page

The page `GIFT_CARD_LINK_BASE_URL` points at is not in this repo. It must:

- remove the token from the address bar (`history.replaceState`);
- POST it to `/gift-card-links/reveal`;
- render every field with `textContent`, never `innerHTML`;
- use a strict Content Security Policy and no third-party scripts.

Add its origin to `CORS_ORIGIN`.

## Audit

Program changes, issuing, state changes, lockouts and resends are written to `audit_logs`, in the
same transaction as the change, with emails masked. Audit rows are kept indefinitely. Like the
ledger, the table rejects `UPDATE` and `DELETE` for every role, so redacting a row needs a
deliberate one-off migration run as the admin (owner) role.

## Trying it locally

With `NODE_ENV=development` and `GIFT_CARD_DEV_PRINT_LINKS=true`, issuing a card prints its link to
the console. Copy the part of the printed `link` after `#token=` and POST it to `/gift-card-links/reveal` to see the card
number and PIN, then redeem with them. The [README](../README.md#4-try-it) has the commands.
