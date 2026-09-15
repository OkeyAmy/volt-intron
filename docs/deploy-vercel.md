# Deploying to Vercel

Vercel runs the Next.js app as serverless functions. It can't host the live voice
**WebSocket gateway** (`web/server.mts`) or a **local SQLite** file, so on Vercel:

- **Voice uses record-then-upload.** The browser records the sale, then sends it once
  to `/api/voice/transcribe`, which calls Intron from the server with the same client
  the gateway uses. Words appear after you tap **Stop**, not while you speak, and each
  recording can be up to two minutes long (Vercel's 4.5 MB request limit). The Intron
  key stays on the server.
- **Drafts and invoices are stored in Postgres** (for example Neon). Without a database
  the app still loads, but it can't save drafts or show invoices. It shows a clear
  "not set up" notice instead.
- The invoice API runs the money logic in-process in TypeScript
  (`web/src/lib/invoice/core`, a port of the Python engine, parity checked in
  `web/tests/invoice-core.test.ts`).

To get live words while speaking, deploy the Docker image (custom server + `ws`
gateway) to a container host such as Render (`render.yaml`). The same upload route
also works there as a fallback.

## Steps

1. **Project → Settings → General → Root Directory: `web`.** The build command is the
   default `next build`.

2. **Add a Postgres database.** Project → **Storage → Create Database → Neon**, then
   connect it to the project for Production and Preview. Vercel adds `DATABASE_URL`
   (and `POSTGRES_URL`) automatically. Any other Postgres works too; set `DATABASE_URL`
   yourself. It must start with `postgres://` or `postgresql://`. Tables are created on
   first use, so there's no migration step.

3. **Set environment variables** (Project → Settings → Environment Variables):

   | Variable | Value | Why |
   |---|---|---|
   | `DATABASE_URL` | your `postgres://…` URL | Added by the Neon integration. Required for drafts and invoices. |
   | `INTRON_API_KEY` | your Intron key | Required for voice. Without it the app asks people to type instead. |
   | `NEXT_PUBLIC_VOICE_TRANSPORT` | `upload` | Optional. Vercel builds already default to `upload`; set it to be explicit. |
   | `NEXT_PUBLIC_VOICE_ENABLED` | `false` | Optional. Only if you want to hide the microphone entirely. |
   | `APP_URL` | `https://your-domain` | Optional. Adds a custom domain to the voice route's allowed origins. Same-site requests are already allowed. |

   `NEXT_PUBLIC_*` values are baked in at build time, so **redeploy** after changing them.

4. **Redeploy**, then check the deployment:

   ```
   curl -s https://<your-app>.vercel.app/api/health
   # {"ok":true,"database":"postgres","databaseReachable":true,
   #  "voice":{"enabled":true,"transport":"upload","apiKeyConfigured":true}}
   ```

   - `database: "missing"` means no `postgres://` URL is set for this environment.
   - `databaseReachable: false` means the URL is set but the database can't be reached. Check the URL, and give a sleeping Neon database a few seconds to wake.
   - `apiKeyConfigured: false` means voice will ask people to type.

## Verifying the flows

```
# draft (should be ready, total ₦62,500)
curl -s -XPOST https://<your-app>.vercel.app/api/invoice/draft \
  -H 'content-type: application/json' \
  -d '{"transcript":"Adebayo Stores bought five bags of cement at twelve thousand five hundred naira each","selections":{"lines":[]}}'
```

Then in a browser, on a phone if you can:
- `/` → **Start speaking** → say the sale → **Stop recording** → fix any words → **Check the details** → **Create invoice**.
- `/invoices` lists issued invoices, and `/invoice/<id>` can be shared, printed, or saved as a PDF.

## Troubleshooting

| Symptom | Cause |
|---|---|
| "Saving invoices isn't set up on this site yet" | No `postgres://` database URL in this environment. See step 2. |
| "Speech isn't available right now" | `INTRON_API_KEY` is missing, invalid, or out of credit. |
| `spawn python ENOENT` | Stale deployment from before the in-process engine. Redeploy. |

## Notes

- API routes use the Node.js runtime (`runtime = "nodejs"`), which the `postgres` driver and outbound `ws` need.
- `node:sqlite` is only imported when no database URL is set, so it never loads on Vercel.
- The invoice snapshot is taken at confirmation, and totals are never recomputed on view.
- The Postgres connection uses a pooled URL, `prepare: false`, and a small pool, which suits serverless.
- Server errors are logged (see Vercel → Logs), and browsers only get a stable `code` with plain text.
