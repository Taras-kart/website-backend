# Tara's Kart Backend

## Permanent deletion

Use the authenticated `DELETE /api/manage/products/:id` endpoint to permanently delete one variant, or `DELETE /api/manage/products/by-product/:productId` to permanently delete the product with all variants. The transaction deletes operational product/variant rows and associated barcodes, branch stock, carts and unshared image mappings. Historical stock movements are preserved in `tara_audit_log`.

A deletion request is rejected if there are stock reservations, sale-item references, branch ownership conflicts, or foreign-key dependencies not covered by the service. The previous `retireVariant` export is a compatibility alias for the permanent-delete implementation. The mounted routes are in the top-level `routes/` directory.

For earlier inactive CHARAK and ESSA records, review `ONE_TIME_CHARAK_ESSA_PERMANENT_CLEANUP.sql` and `PERMANENT_DELETE_DEPLOYMENT.md` before any database changes. The cleanup runs with `ROLLBACK` by default.

## Tests

Run `node --test test/*.unit.test.js test/coinRedemption.test.js test/subcategories.test.js`. Database integration tests require a separately configured local test database.
