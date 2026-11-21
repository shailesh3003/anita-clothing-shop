# Vercel deployment

The root `vercel.json` builds the React client into `client/dist` and routes `/api/*` to `api/index.js`, which reuses Express. All browsers use one HTTPS origin and the existing PostgreSQL-backed login sessions. Local `npm run dev` remains unchanged.

## Accounts and database

1. Use an eligible Vercel plan for commercial shop use. Hobby is restricted to personal/non-commercial use. Do not purchase a plan without the owner's approval.
2. Create a hosted PostgreSQL database with your chosen provider (for example Neon). Choose a region close to the application and configure provider backups/retention. Review the provider's plan and limits before accepting anything paid.
3. Obtain its pooled connection URL for Vercel, and direct connection URL for migrations. Keep both private. `localhost` and `127.0.0.1` refer to the Vercel runtime there, not the shop computer.
4. For an empty cloud database, set `DATABASE_URL` and `DATABASE_SSL=true` in a private local PowerShell session, then run `npm.cmd run migrate --workspace=server`. Environment variables override the local `.env`. Use the provider's certificate-verified TLS connection settings; never disable certificate verification.
5. In that same session run `npm.cmd run create-admin --workspace=server` and enter the new cloud admin email and password interactively. Local accounts are not automatically copied to a new cloud database.
6. Remove those session overrides afterward (`Remove-Item Env:DATABASE_URL` and `Remove-Item Env:DATABASE_SSL`) so local commands use the local database again.

Do not run the integration tests against production: they create and clean up test records. Do not put migration/admin commands in the Vercel build command.

If existing local shop records must be preserved online, first back up locally and explicitly plan a restore into a verified empty cloud database. Do not mix a full restore with migrations already applied to the target. Review which accounts and records will be uploaded. Never overwrite an existing cloud database. Data transfer is a separate step; the initial deployment does not copy any local sales, inventory or accounts.

## Import and configure Vercel

1. Push the deployment configuration and latest app changes to `shailesh3003/anita-clothing-shop` on GitHub.
2. Sign in at https://vercel.com/new and import that repository.
3. Leave **Root Directory** at the repository root (not `client` or `server`). Select **Other** if asked for a framework. The committed config supplies `npm ci`, `npm run build` and `client/dist`.
4. Select Node.js 22.x in project settings.
5. Add server environment variables in Vercel settings:

   | Variable | Value |
   | --- | --- |
   | `NODE_ENV` | `production` |
   | `DATABASE_URL` | Hosted PostgreSQL pooled URL |
   | `DATABASE_SSL` | `true` |
   | `SESSION_SECRET` | A new private random secret, at least 32 characters |

   Generate a new secret locally with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`. Store it in Vercel, not source code or a browser `VITE_*` variable. Do not reuse the local session secret.
6. Give Preview a separate non-production database and secret if using previews. Never connect automatic branch previews to live shop records.
7. Deploy and wait for Ready. Open `/api/health`, then sign in with the cloud admin. Verify stock, a controlled sale, reports, downloads and logout before sharing the URL. Share the site URL and give each staff member their own account.

## Operational checks before real shop use

- Verify secure/HTTP-only session cookies over HTTPS and staff denial from admin APIs.
- The existing login rate limiter is per function instance. Configure Vercel Firewall rate limiting for `/api/auth/login` for enforcement across instances; check plan support. Application memory does not provide a global login limit on serverless hosting.
- Use a pooled database endpoint and monitor total connections. Each warm function currently permits up to 10 database connections; adjust capacity against the provider's limits before scaling to many shops.
- Confirm provider backup frequency, retention and a restore drill on a separate database. Local Windows backups do not back up cloud data automatically.
- Verify all report exports on the deployed environment; Vercel function duration and response-size limits apply to large reports.
- Your shop computer can be off once both the website and cloud database are running. Never expose the shop's local PostgreSQL port to the internet.

References: https://vercel.com/docs/functions/runtimes/node-js, https://vercel.com/docs/project-configuration/vercel-json, https://vercel.com/docs/plans/hobby.
