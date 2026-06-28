# Maintenance

- `server.mjs` owns HTTP wiring; reusable logic belongs in `src/routes`, `src/services`, or `src/middleware`.
- Runtime JSON databases and their `.bak` files are state. Do not delete active databases while the API is running.
- Run `npm run maintenance:prune -- --apply` to retain the newest runtime backups per database.
- Validate changes with `npm test`. Secrets belong only in `.env` and must never be logged or committed.
