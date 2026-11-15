# Operations

## Database migrations

The schema is managed only through migrations in `src/migrations/`. The app never changes the
schema itself. Migrations run as the admin role.

```bash
npm run migration:run                                   # apply pending migrations
npm run migration:revert                                # undo the most recent one
npm run migration:show                                  # list applied / pending
npm run migration:generate -- src/migrations/AddXyz     # write a migration from entity changes
npm run migration:check                                 # fail if entities and schema differ
npm run migration:run:prod                              # apply using the compiled dist/ files
```

To change the schema: edit the entity, run `migration:generate`, review the generated SQL, run
`migration:run`, and commit the migration together with the code.

**Never edit a migration that has already been applied** anywhere that matters. TypeORM records
migrations by name, so an edited one doesn't run again and that database silently keeps the old
schema. Add a new migration instead.

## Scheduled jobs

Run both with cron or a scheduled task.

### Gift card emails: every minute

```bash
npm run deliveries:dispatch          # ts-node
npm run deliveries:dispatch:prod     # compiled dist/ files
```

Issuing and resending try to send right away when the email is due; the dispatcher sends scheduled
emails and retries failed ones.

- It needs only the database settings and `GIFT_CARD_LINK_BASE_URL`, not the card keys or
  `JWT_SECRET`.
- It exits with code 1 if the database fails, so the scheduler can alert you.
- A failed send to the email provider is not an error: it's retried with backoff and marked
  `failed` after 5 attempts. A send attempted while issuing or resending never fails that request.

### Expired refresh tokens: daily

```bash
npm run tokens:purge          # ts-node
npm run tokens:purge:prod     # compiled dist/ files
```

Expired refresh tokens are already deleted for users who log in or refresh. The purge script
cleans up the rows of users who never return.

## Deploying

1. **Run migrations before starting a new version.** The API checks the card keys against
   `gift_card_key_checks` at startup and refuses to start without that table.
2. **Keep the admin credentials out of the API server's environment.** Use them only in the deploy
   step that runs migrations. See [Security](security.md#database-roles).
3. **Don't set `DB_LOGGING=true`**: the API refuses to start with it in production.
4. **Set `TRUST_PROXY=true` behind a proxy**, or every client shares one rate limit.

**Production needs an email provider.** None is built yet, so with `NODE_ENV=production` both the
API and the dispatch script refuse to start. Otherwise production would mark gift emails as sent
without delivering them, and recipients' links would be lost.

## Logs

The API logs JSON lines (pino) to stdout. Logs never contain card numbers, PINs, link tokens, full
email addresses or SQL parameters. Database errors are logged as their code, constraint and table
only.
