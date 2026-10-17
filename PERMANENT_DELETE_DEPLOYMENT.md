# Permanent Product Deletion

The admin `/products/delete` screen now offers two actions:

- **Delete Variant** permanently removes the selected SKU's variant row, barcodes, branch stock records, and images for freed barcodes. If it was the last variant, it also removes the parent product row.
- **Delete Entire Product** permanently removes the product and all its variants as one database transaction. Cart, wishlist, product images, and inventory links are cleared.

No soft-delete record is left in `products` or `product_variants` after a successful permanent delete. The operation blocks when stock reservations exist, a sale item is linked by variant or barcode, the product belongs to another branch, or unknown foreign key dependencies need review. Stock movement history is copied into `tara_audit_log` before deletion of the operational movement rows. The record in that audit log is intentionally retained.

An HTTP 409 indicates the deletion was blocked and rolled back. Physical storage files held in Cloudinary/Vercel Blob are not deleted by the SQL operation, but their database mappings are removed when unshared.

## Existing inactive CHARAK and ESSA rows

1. Take a full PostgreSQL backup.
2. Confirm the old brands still have exactly 95 CHARAK and 45 ESSA products, 267 variants total, no active products/variants, no stock or reservations, and no sales references.
3. Open `ONE_TIME_CHARAK_ESSA_PERMANENT_CLEANUP.sql` in pgAdmin or DBeaver and execute **the entire script**, not the selected statement. It ends in `ROLLBACK` by default.
4. Check all `ce_validation` results. An incorrect count or conflicting data intentionally fails the transaction.
5. When approved, replace the last line `ROLLBACK;` with `COMMIT;` and rerun the entire script once, in a fresh SQL session.
6. Validate with `SELECT brand_name,COUNT(*) FROM products WHERE UPPER(BTRIM(brand_name)) IN ('CHARAK','ESSA') GROUP BY brand_name;`. This should return zero rows.

If you already reuploaded either brand or its counts differ, **do not alter the guards to force deletion**. Review which products are live and generate a new targeted cleanup list. The previous `ce_retirement_backup_20261016` recovery schema and historical import jobs are preserved; they are outside the active catalogue tables.

This project has been checked with local unit tests and syntax checks, but no production database connection is available here. Deploy the backend before the admin UI.
