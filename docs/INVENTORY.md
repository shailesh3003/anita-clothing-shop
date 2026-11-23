# Inventory workflow and design

On sale entry, Admins can type a purchase rate (for example `250` or `250.50`) in Inventory product to find products at that current average purchase cost, rounded to two decimal places. Matches show their purchase rate, SKU and available quantity. Name, SKU and barcode searches still work. Staff cannot search by purchase cost or see it in results; this is enforced by the inventory API.

## What this version tracks

One inventory product is one independently countable variant, with a unique SKU, name, optional size, colour and barcode, purchase rate/average cost, available quantity, and low-stock threshold. Create separate SKUs for the same garment in different sizes or colours. Whole pieces are supported; weighted goods and fractional units require another design.

This remains a single-shop application. Inventory does not introduce shop isolation, subscriptions, or a commercial multi-shop service.

## First day in the shop

1. Pause sales briefly and count the physical goods on the shelf.
2. As an admin, open **Inventory → Add product** for each variant. Enter a unique SKU, supplier purchase rate per piece, actual opening stock and low-stock threshold. Leave barcode blank unless the shop uses one.
3. Do not enter total historical purchases as opening stock. Older sales have already affected today's physical quantity; subtracting them again would understate stock.
4. Check the catalogue before staff start selling. No products or quantities are automatically guessed from old free-text sale names.
5. Staff select a catalogue product on **Sales**. Search by name, SKU, size, colour or exact barcode. Enter the actual negotiated selling rate. There is no required or prefilled fixed selling price.

## Purchase costs and bargaining profit

Migration `005_purchase_cost_profit.sql` adds purchase costs and sale cost snapshots. It leaves all existing costs unknown: old selling prices must never be treated as supplier purchase rates. Admins must edit existing products to enter the real cost of remaining stock before making new sales or receiving additional stock. Historical sales are not backfilled from today's rate.

When receiving a delivery, enter its actual supplier rate. New average cost = (old available quantity × old average cost + received quantity × delivery rate) ÷ new quantity. The calculation uses PostgreSQL NUMERIC, retains six decimal places per unit, and displays monetary totals to two decimals. Sale purchase cost is rounded to paisa per transaction before summing report totals. Receipts remain traceable with their own rate in movement history. A physical stock count or damage adjustment retains the current average rate; it does not invent a supplier receipt.

Each sale saves the purchase cost from that moment. Gross profit = negotiated sale amount − recorded purchase cost. Below-cost bargaining produces a negative profit, which is allowed and shown. Admins see per-sale profit in Sales history, per-product recorded profit in Inventory, today's profit on Overview, and selected-period profit in Reports and downloads. Purchase rates and profit are excluded from staff API responses and screens.

Later deliveries or an audited manual purchase-rate correction affect remaining stock and future sales only. Corrections of an existing sale preserve its original product cost; switching to another product uses that product's current cost. A correction that returns units or a void adds them back at the original recorded cost and blends that value into remaining stock. If a returned historical cost is unknown, the resulting stock cost remains unknown until reviewed by an admin.

Reports exclude voids. Transactions without complete cost snapshots are labelled **Cost unavailable** and excluded from profit totals, with a missing-cost transaction count. Per-product profit similarly excludes unknown-cost units and shows the missing unit count. These figures describe merchandise gross profit before shop expenses; they are not net profit or a tax calculation.

New sale lines require valid inventory links on the server. Earlier lines remain unlinked and can still be viewed and corrected. Their stock impact is unknown and is not reconstructed automatically. The **Sold** quantity includes current, non-voided linked sales only, not all historical sales.

## Daily workflows

For new opening stock and **Receive new stock**, enter the actual **Stock purchase date** (defaults to today in Asia/Kolkata). Positive opening stock and receipts require a valid date no later than today. Zero opening stock has no purchase date. Inventory shows the latest dated purchase, while Movement history shows every delivery's purchase date separately from its recording timestamp. Old entries without a known purchase date show **Not recorded**; no date is guessed from the entry timestamp. Purchase dates are reference information: a backdated receipt affects available stock when recorded and does not rebuild historical stock/profit or reorder cost calculations. Supplier bill management remains a separate later feature.

Admins can use **Remove item** with a reason and a confirmation showing the item name/SKU. A never-sold product is moved to the **Removed items** filter, where it can be restored. Products linked to any sale, including voided sales or earlier corrected lines, are archived instead. Removed products cannot be sold, edited, or adjusted. Removal and restoration preserve stock, cost and movement history and are recorded with the administrator and reason in the audit log. SKU/barcode codes stay reserved; restore the existing item instead of recreating it. Restored items appear under **Archived** until an admin reviews the quantity and activates them. These actions never permanently delete a record or change its stock quantity. Migration `006_inventory_removal.sql` adds this removal state without changing existing products.

| Action | Stock effect | Who can do it |
| --- | --- | --- |
| Save sale | Decrease by the total quantity of each variant across all its sale lines | Staff, admin |
| Correct sale | Reconcile the difference between the old and new quantities, including changes of product | Admin |
| Void an incorrect sale | Restore the linked quantities exactly once | Admin |
| Receive new stock | Increase by the quantity actually received; record delivery/invoice reference | Admin |
| Remove damaged/lost stock | Decrease by the quantity removed; record why | Admin |
| Physical count | Replace the recorded balance with the actual count, recording the difference | Admin |
| Archive product | Stop new sales and adjustments; preserve the product, sales and history | Admin |

**A void reverses a mistaken sale and returns its goods to available stock. Confirm that those goods are physically sellable. For customer returns and exchanges, use the dedicated [Returns workflow](RETURNS.md), not void.** That workflow restocks only goods marked sellable and records damaged/inspection returns separately. Approved returns and their replacement sales are protected from later editing or voiding.

Regularly filter **Low stock** to identify products at or below their threshold, and compare shelf counts with recorded balances. Refresh inventory before adjusting. A count or product edit based on an outdated balance/version is rejected instead of overwriting an intervening sale. Opening stock, receipts, damage, counts, sales, corrections and voids are visible in the movement history with actor, timestamp, reason, delta and resulting balance. Times use Asia/Kolkata.

## Integrity and permissions

- Sale creation, item rows, stock changes, movements and sale audit metadata commit or roll back together.
- A PostgreSQL row lock is acquired on each affected product in UUID order before checking or changing its balance. Concurrent sales cannot both consume the last unit. Repeated lines for one product are combined for the stock check.
- Corrections use the net quantity difference. Removing a line restores it; adding or increasing one checks the extra stock. Archived products cannot be newly sold, but a correction can release stock and a void can restore it.
- Existing sale and request keys prevent repeated requests from applying a stock movement twice. Create-product and adjustment requests have their own idempotency keys.
- Product versions protect physical counts, receipts, damage adjustments and catalogue edits against stale screens.
- Database constraints prevent negative stock, invalid units/prices, duplicate SKUs/barcodes and inconsistent before/after movement arithmetic. Amounts use NUMERIC and the existing exact-paisa calculations.
- The server controls sale product-name snapshots, checks product IDs, and enforces admin-only stock management and movement history. Staff can read availability but cannot change catalogue or stock balances.
- No API permanently deletes products, movements or sales. Catalogue changes are audited. Direct database administrators still require restricted access and backups.

## Research behind these choices

Reviewed 14 November 2026, using vendor documentation rather than comparison articles:

- [Shopify: Inventory fundamentals](https://help.shopify.com/en/manual/inventory-and-locations/fundamentals) describes variant-level quantities, the distinction between available/on-hand/committed stock, and checking recorded stock against physical counts. This app has immediate completed shop sales, so it tracks available stock without adding order reservations.
- [Shopify: Inventory adjustment history](https://help.shopify.com/en/manual/inventory-and-locations/adjusting-inventory/adjustment-history) describes recording variant adjustments and activity. This implementation retains a chronological movement ledger rather than silently replacing stock quantities.
- [Square: Inventory adjustment reasons](https://developer.squareup.com/docs/inventory-api/adjustment-reasons) separates received, damaged, lost, returned, recount and sale activity. This version implements opening stock, received stock, damage/loss and physical count, plus automatic sale corrections/voids. Customer returns are intentionally a separate next feature because refunds and sellable condition matter.
- [PostgreSQL: Explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html) explains row locks and deadlocks. Consistent product lock order and transactional updates protect concurrent shop sales.

These are workflow/design references. The app does not connect to Shopify or Square.

## Recommended next features, in order

1. **Return follow-up:** the original-sale-linked return/exchange workflow is implemented. Later additions could cover approved-return reversals, supplier recovery and inspection release; those require additional audit and stock controls.
2. **Supplier purchasing and receiving:** supplier names, purchase orders, partial deliveries and purchase references. Increase stock only on actual receipt, not when placing an order.
3. **Barcode checkout:** this version searches stored barcodes. A keyboard-style scanner workflow and labels can follow after checking the shop's scanner/printer. No hardware support has been tested here.
4. **Count sessions:** pause or reconcile stock movements during a full-store count, with per-user counts, differences and approval. Current counts are per product and reject stale versions.
5. **Advanced valuation:** the current version records moving weighted average cost and gross sales profit. Supplier purchasing, landed-cost allocation and expense accounting would be separate additions; never infer missing purchase cost from selling price.
6. **Multiple shops/locations:** introduce shop memberships, strict data isolation and transfer/receiving controls before using one database for unrelated shops. A transfer must account for dispatch, in transit and receipt separately.
7. **Reorder suggestions:** build from actual supplier lead time and sales history after enough data exists. Current low-stock thresholds are configured by the shop, without invented forecasts.

## Setup and verification

Back up the configured database, then run `npm run migrate --workspace=server`. Migration `004_inventory.sql` is additive: it creates product/movement tables and a nullable product link on existing sale items. It widens sale-name snapshots to include variants. It does not seed products, assign historical item links, or change existing sales totals.

Run `npm test`, both workspace lint commands and `npm run build`. Integration tests create and clean fixture records; use an isolated database via the DATABASE_URL environment variable. Test files run sequentially because report totals use the shared test database. Do not run fixture tests against production.

Inventory correctness tests cover roles, unique codes, validation, low-stock filters, duplicate requests, repeated product lines, full rollback, concurrent last-unit sales, corrections, voids, archived products, stock-count conflicts, and ledger reconciliation. Existing report/export and authentication tests also run.
