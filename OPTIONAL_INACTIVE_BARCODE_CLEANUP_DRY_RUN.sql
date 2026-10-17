BEGIN;

CREATE TEMP TABLE target_charak_eans(ean_code text PRIMARY KEY) ON COMMIT DROP;
INSERT INTO target_charak_eans(ean_code) VALUES
('11559175'),('11559274'),('11559276'),('11559267'),('11559265'),
('11559266'),('11559264'),('11559256'),('11559258'),('11559260'),
('11559262'),('11559257'),('11559259'),('11559261'),('11559263'),
('11559268'),('11559269'),('11559270'),('11559272'),('11559279'),
('11559271'),('11559280'),('11559275'),('11559277'),('11559273'),('11559278');

CREATE TEMP TABLE stale_charak_barcodes ON COMMIT DROP AS
SELECT b.id, b.ean_code, b.variant_id
FROM barcodes b
JOIN target_charak_eans e ON e.ean_code=b.ean_code
JOIN product_variants v ON v.id=b.variant_id
JOIN products p ON p.id=v.product_id
WHERE UPPER(BTRIM(p.brand_name))='CHARAK'
 AND p.is_active=FALSE AND v.is_active=FALSE
 AND NOT EXISTS (
  SELECT 1 FROM branch_variant_stock s
  WHERE s.variant_id=v.id AND
  (s.is_active=TRUE OR COALESCE(s.on_hand,0)<>0 OR COALESCE(s.reserved,0)<>0)
 );

SELECT 'eligible_retired_barcode_mappings' AS metric, COUNT(*) AS count FROM stale_charak_barcodes;
SELECT 'still_assigned_to_other_or_active_records' AS metric, COUNT(*) AS count
FROM barcodes b JOIN target_charak_eans e ON e.ean_code=b.ean_code
WHERE b.id NOT IN (SELECT id FROM stale_charak_barcodes);

DELETE FROM product_images i USING stale_charak_barcodes s WHERE i.ean_code=s.ean_code;
DELETE FROM barcodes b USING stale_charak_barcodes s WHERE b.id=s.id;

SELECT 'remaining_mappings_after_dry_run' AS metric, COUNT(*) AS count
FROM barcodes b JOIN target_charak_eans e ON e.ean_code=b.ean_code;

ROLLBACK;
