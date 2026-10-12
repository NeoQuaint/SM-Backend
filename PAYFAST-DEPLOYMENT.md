# PayFast release

This release replaces new Yoco checkouts with PayFast once configured. Both old cached checkout URLs and the new `/api/payments` URLs use PayFast. Existing Yoco webhooks and paid accounts remain supported. Purchases are one-off (Basic R39 / Standard R59 for 30 days; subject swaps R19), not recurring debits.

## Render configuration

Set secrets directly in the existing Smartclass Render service's environment; do not commit or paste them into chat:

- `PAYFAST_MERCHANT_ID`
- `PAYFAST_MERCHANT_KEY`
- `PAYFAST_PASSPHRASE` (must match the PayFast integration setting)
- `PAYFAST_TEST_MODE=true` for sandbox credentials; `false` for the verified live account
- `FRONTEND_URL=https://www.smartclasss.com`
- `BACKEND_URL=https://smartclass-wlgb.onrender.com`

Keep the existing database, JWT, email and Yoco webhook settings. The application creates an additive `smartclass_payfast_orders` table. Existing subscription/payment tables are reused. No existing rows are migrated or deleted.

The notify URL is `https://smartclass-wlgb.onrender.com/api/payfast/webhook`. It is passed on every checkout. Signed notifications must pass PayFast source-IP, merchant, signature, server-validation, exact amount and stored-order checks. A browser success redirect cannot grant access. Transactional settlement preserves duplicate protection and receipt delivery through the existing worker.

## Release order

1. Verify merchant activation and integration credentials in PayFast. Run a sandbox purchase with sandbox credentials and confirm the notification, exact plan, receipt, repeat delivery and subject swap.
2. Configure verified live credentials in Render; deploy backend and confirm `/api/payfast/health` reports `configured:true` and `mode:live`.
3. Deploy the prepared frontend from `work/release-exam-dates`, not the main frontend folder (it contains unrelated unfinished onboarding changes).
4. The merchant should complete a live test purchase, then verify the account plan and receipt. No real payment is initiated automatically by the deployment scripts.

If configuration is missing, new checkout creation fails closed with a temporary-unavailability message; it never falls back to Yoco. Do not release the frontend ahead of the backend.

## Validation

`node --test test/payfast-security.test.js test/yoco-settlement.test.js test/profile-actions.test.js test/payment-emails.test.js`

Additional workspace test: `node work/test-payfast-database.cjs` uses local PostgreSQL-compatible PGlite and test-only identities, without production database access.

Official references: https://developers.payfast.co.za/docs and https://support.payfast.help/portal/en/kb/articles/what-causes-the-itn-security-check-errors-20-9-2022
