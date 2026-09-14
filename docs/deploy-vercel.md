# Deploying to Vercel (typing path)

Vercel's serverless platform cannot host this app's **voice gateway** (a persistent
WebSocket server) or its **local SQLite** file, and has **no Python** to spawn. So on
Vercel the app runs the **typing** path end to end:

- The invoice API (`/api/invoice/*`) runs the money/resolution logic **in-process**
  in TypeScript (`web/src/lib/invoice/core`, a faithful port of the Python engine —
  parity checked in `web/tests/invoice-core.test.ts`). No subprocess.
- Drafts and issued invoices persist in **Postgres** (any Postgres via a database
  URL). SQLite is still used locally when no URL is set.
- **Voice input is disabled** on Vercel; typing reaches the same review and works.

For the full experience *including voice*, deploy the whole app (custom server +
`ws` gateway) to a container host that runs a persistent Node process — that path
is unchanged.

## Steps on Vercel

1. **Project → Settings → General → Root Directory: `web`** (the app lives in `web/`).
   The build command is the default `next build`.

2. **Add a Postgres database.** Project → **Storage → Create → Postgres** (Neon).
   Vercel injects `POSTGRES_URL` (and `DATABASE_URL`) into the project automatically.
   Any external Postgres works too — set `DATABASE_URL` yourself. The store creates
   its tables on first use; no migration step.

3. **Set environment variables** (Project → Settings → Environment Variables):

   | Variable | Value | Why |
   |---|---|---|
   | `NEXT_PUBLIC_VOICE_ENABLED` | `false` | Hides "Start speaking"; the app leads with typing. Without it the mic button shows and fails (a serverless function can't hold the Sahara WebSocket). |
   | `DATABASE_URL` *or* `POSTGRES_URL` | your Postgres URL | Durable drafts/invoices. `POSTGRES_URL` is set for you by Vercel Postgres. |

   `INTRON_API_KEY` is **not** needed on Vercel (no voice).

4. **Redeploy.** Push to the production branch (or click Redeploy). Then:
   - `/` shows the typing composer (no mic button).
   - Type a sale → **Check the details** → answer any question → **Create invoice**.
   - `/invoices` lists issued invoices; `/invoice/<id>` prints/saves as PDF.

## Verifying

```
# draft (should be ready, total ₦62,500)
curl -s -XPOST https://<your-app>.vercel.app/api/invoice/draft \
  -H 'content-type: application/json' \
  -d '{"transcript":"Adebayo Stores bought five bags of cement at twelve thousand five hundred naira each","selections":{"lines":[]}}'
```

If `/api/invoice/draft` returns `spawn python ENOENT`, the code is stale (redeploy
the branch with this fix). If `/invoices` 500s, `DATABASE_URL`/`POSTGRES_URL` is not
set or not reachable.

## Notes

- The API route handlers use the Node.js runtime (`runtime = "nodejs"`), required by
  the `postgres` driver.
- `node:sqlite` is only imported when no database URL is set, so it never loads on
  Vercel.
- The invoice snapshot is taken at confirmation; totals are never recomputed on view.
- Postgres connection: pooled URL + `prepare: false` + a small pool suit serverless.
