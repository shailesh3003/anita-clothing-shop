# Anita Clothing Shop

Anita Clothing Shop uses a React/Vite client, an Express API, PostgreSQL, and server-enforced `ADMIN` / `STAFF` access. The app includes staff login and management, sale entry and history, a real-record sales dashboard, and admin-only reports and exports. Dashboard and report totals omit voided sales and use the shop's `Asia/Kolkata` business calendar; weekly reports run Monday through Sunday.

## Requirements

- Node.js 20 or newer and npm
- PostgreSQL 14 or newer (local or hosted, including Supabase PostgreSQL)

## Configure

1. Copy `.env.example` to `.env` in the repository root.
2. Set `DATABASE_URL` to the PostgreSQL connection string. For a hosted database that requires TLS, set `DATABASE_SSL=true` in `.env`.
3. Set `SESSION_SECRET` to a private random value of at least 32 characters. For example, generate one with `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` and paste it into `.env`.
4. Keep `.env` private; it is ignored by Git. Never put database credentials or service-role keys in frontend variables.

The server loads the root `.env`. `APP_ORIGIN` documents the local frontend origin; development requests use Vite's same-origin `/api` proxy. In production, serve the frontend and API from the same origin and enable HTTPS so session cookies are secure.

### This workstation's local PostgreSQL

The local development cluster for this workstation is stored outside the OneDrive project folder at `%LOCALAPPDATA%\AnitaClothingShop\postgres-data`. It listens on `127.0.0.1:5433`; the root `.env` already contains the generated app-user connection string. Start it again after a Windows restart with:

```powershell
& "$env:ProgramFiles\PostgreSQL\18\bin\pg_ctl.exe" -D "$env:LOCALAPPDATA\AnitaClothingShop\postgres-data" -l "$env:LOCALAPPDATA\AnitaClothingShop\postgres.log" -o "-h 127.0.0.1 -p 5433" -w start
```

Stop it when needed with:

```powershell
& "$env:ProgramFiles\PostgreSQL\18\bin\pg_ctl.exe" -D "$env:LOCALAPPDATA\AnitaClothingShop\postgres-data" -m fast -w stop
```

The cluster's superuser password is not needed for normal app use. Keep the generated `.env` private and do not commit it.

### Local database backups

On this workstation, `server/scripts/register-daily-backup.ps1` registers a Windows Task Scheduler task that runs `server/scripts/backup-postgres.ps1` daily at 2:00 AM local time. It retains the latest 30 days of custom-format dumps under `%LOCALAPPDATA%\AnitaClothingShop\backups` and writes a credential-free log there. The task runs as the current Windows user and runs when Windows is available after that user signs in. The files are restricted to that user and SYSTEM. This is a local copy on this machine, not an offsite or hosted-provider backup.

To check task status, run `Get-ScheduledTaskInfo -TaskName 'Anita Clothing Shop PostgreSQL Backup'`. To run it manually, run `powershell -NoProfile -ExecutionPolicy Bypass -File .\server\scripts\backup-postgres.ps1` from the project folder. To restore, create a new empty database first, then use PostgreSQL's `pg_restore --no-owner --no-acl --dbname <new-database-connection> <backup-file.dump>`. Verify the restored database and app against that new database before considering any recovery complete; do not restore over the live database. For production, configure and verify automated backups and point-in-time recovery in the selected PostgreSQL host, with a documented retention policy and an offsite restore test. No production host is configured by this project.

## Install and migrate

```sh
npm install
npm run migrate --workspace=server
```

The migration runner applies numbered SQL migrations once and records their names in `schema_migrations`. The migrations create profiles, sales, audit logs, PostgreSQL-backed sessions, and sale items. Sale items belong to one parent sale and store a name, positive whole quantity, and exact `NUMERIC(12,2)` unit price. New sale totals are calculated from item rows on the server. Older sales remain available with no fabricated items and are labeled as having unavailable item details. Migration `003_sale_items.sql` is additive and does not delete or reset existing sales.

## Create the first administrator

There is no public registration route. After migration, run:

```sh
npm run create-admin --workspace=server
```

Enter the administrator name, email and a unique password of at least 12 characters when prompted. Password input is hidden. The command can only insert an admin, refuses duplicate emails, and does not print or store the plaintext password. Create additional staff accounts later through the administrator-only API (`GET/POST /api/admin/users`, `PATCH /api/admin/users/:id`).

## Run locally

```sh
npm run dev
```

Open <http://localhost:5173>. The API listens on <http://localhost:3001>. Login sessions are stored in PostgreSQL, use an HTTP-only, SameSite=Lax cookie, expire after eight hours, and regenerate on login. Login attempts are rate-limited. Inactive profiles are denied and their sessions are invalidated on authenticated requests. `ADMIN` checks run on the server; staff receive `403` from the admin API.

## Interface language

Choose **English** or **मराठी** using the **Language / भाषा** selector in the sidebar or on the login page. The choice is remembered in this browser. Navigation, forms, summaries, dates, and common messages update immediately. Saved item names, descriptions, staff names, and existing PDF/Excel/CSV downloads keep their original content; the language setting does not change stored sales or calculations.

## Inventory

Migration `008_stock_purchase_dates.sql` adds actual purchase dates to positive opening stock and stock receipts. Inventory displays **Last purchase date**, and Movement history separates **Purchase date** from **Recorded at**. Existing undated entries remain **Not recorded**. New dates default to the shop's current Asia/Kolkata date and cannot be in the future.

Customer returns: migration `007_returns_exchanges.sql` adds admin-only **Return / exchange** actions in Sales history. Refunds use original bargained rates. Only sellable goods return to available stock; damaged and inspection returns remain separate. Exchanges atomically record a replacement sale and the amount to collect/refund. Dashboards and reports show net sales after credits on the return date, with return details in all download formats. See [the returns workflow and limitations](docs/RETURNS.md) before approving returns. The app records payments; it does not transfer money.

Admins can remove mistaken inventory items using **Remove item**, a reason and confirmation. Never-sold items move to **Removed items** and can be restored; anything with sales history is archived. Restore places the item in **Archived** for review before activation. All records, quantities, costs and audit history are retained. Apply migration `006_inventory_removal.sql` before using these actions.

Migration `004_inventory.sql` adds stock tracking. Admins set up one product/SKU per size and colour using actual current physical stock. Staff choose these products in Sales; stock decreases atomically when a sale is saved. Admin corrections reconcile stock differences and voids restore linked quantities once. Inventory shows available/sold quantities, searchable SKU/barcode records, low-stock filters, and admin-only receipts, damage/loss adjustments, physical counts and movement history. Earlier sales remain untracked; no stock is guessed or seeded. Read [the inventory workflow, research and next-feature recommendations](docs/INVENTORY.md) before entering opening quantities. Voiding a mistaken sale returns its tracked goods to available stock; customer returns/refunds require a separate workflow.

## Available checks

Purchase costs and bargaining: apply migration `005_purchase_cost_profit.sql`. Inventory now records the supplier purchase rate, not a fixed selling price. Enter the negotiated rate on every sale. Admins can see gross profit in inventory, sale history, Overview and Reports; receipts blend purchase costs using a weighted average, and each sale freezes its own cost. Set actual purchase rates on existing products before selling them. Historical costs remain unavailable and are excluded from profit rather than guessed. See the inventory guide for rounding, corrections and cost privacy.

```sh
npm run lint --workspace=client
npm run lint --workspace=server
npm run build
npm test
```

The report tests use the configured PostgreSQL database and create then remove temporary test accounts and sales. Start the local PostgreSQL cluster first. Apply all numbered migrations before using inventory, profit, reports or exports. Sales reports query the existing `sales`, `profiles` and void fields. Admins can choose a day, a date within a Monday–Sunday week, a month and year, or a custom range on **Reports**. The preview refreshes for the selected range; PDF, Excel and CSV downloads use the same server-calculated totals. Staff dashboards are limited to their own sales, and the server denies staff access to reports and exports.
