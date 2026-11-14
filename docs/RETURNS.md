# Customer returns and exchanges

## In the shop

1. An admin opens **Sales → Sales history**, finds the original purchase using the date filter, and selects **Return / exchange**. Earlier returns and remaining returnable quantities are shown.
2. Enter only the quantities physically received, and choose a condition per original sale line:
   - **Sellable:** return to available stock using the original saved cost. Archived products stay archived until reviewed.
   - **Damaged:** record the received quantity separately; available stock does not increase.
   - **Inspection:** keep goods out of available stock while their condition or identity is uncertain.
3. Enter the actual return date, reason and refund/payment method. The date must be between the original sale date and today's Asia/Kolkata date.
4. For an exchange, enable **Exchange for replacement items** and select the replacement products, quantities and actual negotiated rates. The app shows the original-price credit, replacement total and exact difference to collect or refund. Zero difference means no payment is due.
5. Check the goods and money with the customer, then approve and confirm. The app records the cash/refund/payment; it does not transfer money or contact a payment provider.

Refund credit is the original bargained unit price multiplied by returned quantity. This version supports full original-price returns of selected units; it does not impose restocking fees or record discretionary partial-value refunds. Return quantities are capped across every prior return. Each original line can be selected only once in one return; split mixed-condition units across separate return records if needed.

## Safety and audit

- Only active admins can view detailed return history and approve a return. Staff cannot access the return APIs or approve refunds/exchanges.
- Approvals are immutable in this version. The original sale and any exchange replacement cannot be edited or voided afterwards; doing so would invalidate the refund. Check the preview carefully. A cancellation/reversal workflow is not included.
- Replacement sales can themselves be returned through the same workflow. Their original negotiated rates and remaining quantities apply.
- A return, its item records, all stock/cost movements, replacement sale and audit entries commit together. An unavailable replacement rolls everything back.
- Sale and product locks protect concurrent requests. A request key makes a repeated or retried submission apply once. A return racing a sale void cannot both succeed.
- Goods with no inventory link cannot be automatically restocked. Historical item lines may be returned under inspection. Aggregate-only old sales need verified item details added before a return can be recorded. No product identities, costs or refund amounts are guessed.
- Damaged-return quantities in Inventory are lifetime received totals, not current damaged on-hand stock: disposal, supplier claims and recovery of damaged goods need a separate later workflow. Do not use ordinary stock receipt to make damaged goods sellable.

## Sales, money and profit

The original sale stays intact. A return credit reduces net revenue and payment-method totals on the **return date**, not the original sale date. A later return therefore does not rewrite a previously issued daily report. Reports show gross sales, return credits, net sales, sale transaction count and return transaction count separately. Net totals can be negative on a refund-heavy day.

For an exchange, the replacement is a real new sale on the return date. Its total minus the return credit equals the actual settlement. Both financial entries use the chosen settlement method, so the net payment total equals the additional money collected or refunded. Staff attribution retains the original staff member for the return credit and the approving admin for the replacement sale; staff totals reconcile with the shop total.

Profit is merchandise gross profit before shop expenses. Sellable goods reverse the corresponding original cost and blend that original cost into current stock. Damaged/inspection goods do not reverse purchase cost: a full refund of a damaged item leaves its purchase cost as a loss. Cost reversals allocate cumulative rounded cost to avoid paisa drift across repeated partial returns. Historical missing costs are labelled and excluded from calculated profit rather than assumed to be zero.

Sales history shows the original sale's profit after all its returns. Period reports show dated sale and return events; their sale detail rows retain the original sale amounts/profit, followed by a separate returns section. PDF includes a returns appendix, Excel includes a **Returns** sheet, and CSV includes a return table. All use the same selected dates and server-calculated totals.

## Setup

Back up the database and apply `npm run migrate --workspace=server`. Migration `007_returns_exchanges.sql` creates return headers/items and extends movement kinds. It does not generate returns, change existing sales, or remove business data. Test against an isolated database using the existing test command; never insert test sales into production.
