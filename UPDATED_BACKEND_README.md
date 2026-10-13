# Backend update — 13 October 2026

## New behavior

- `DELETE /api/manage/products/:id` (staff auth, branch isolation) atomically retires a selected product variant.
- Legacy `DELETE /api/products/:id` now also uses the same barcode-releasing transaction (and retains its super-admin gateway restriction).
- The `productRetirement` service checks pending stock reservations; non-super-admin users cannot delete cross-branch variants.
- Stock in associated branches is set to zero and deactivated; each nonzero adjustment gets a `PRODUCT_DELETED` stock-movement row.
- `DELETE FROM barcodes WHERE variant_id=$1` permanently removes EAN associations, **freeing barcode uniqueness for a new upload**.
- The variant is made inactive; its parent product is made inactive only if no active variants remain. Historical sales and movement rows are not removed.
- `/api/manage/stock` now excludes retired product variants.
- Unit tests: `node --test test/productRetirement.unit.test.js`. Integration tests are in `test/integration.test.js` and require `npm ci` plus the bundled PGlite test dependency.

## Deploy safely

1. Back up your database and verify that order reservations have been completed or canceled before retiring products.
2. Deploy this backend before deploying the updated admin frontend. Existing API routes and DB migration 001 are retained.
3. Provide environment variables in your hosting platform. The original uploaded `.env` was **deliberately omitted** from this ZIP. Copy `.env.example` locally and supply proper secrets outside version control.
4. Test the staging flow: create a variant with barcode X → delete it → assert no rows remain in `barcodes` for that variant → upload a different product with barcode X → confirm success and inspect historical orders.
5. Existing source includes duplicate route files in `services/routes`; they are retained for compatibility, but **`backend/app.js` mounts `backend/routes`**. Use `backend/` as the deployment root.

This release does not run migration or modify a live database itself. New barcode-release behavior takes effect only after the updated server is deployed. Existing previously soft-deleted barcodes are not automatically purged; inspect those rows separately before any one-time cleanup.
