BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '180s';
SELECT pg_advisory_xact_lock(2026101702);

CREATE TEMP TABLE ce_products ON COMMIT DROP AS
SELECT id,brand_name,is_active FROM products
WHERE UPPER(BTRIM(brand_name)) IN ('CHARAK','ESSA');

SELECT p.id FROM products p JOIN ce_products t ON t.id=p.id FOR UPDATE OF p;

CREATE TEMP TABLE ce_variants ON COMMIT DROP AS
SELECT v.id,v.product_id,v.is_active
FROM product_variants v JOIN ce_products p ON p.id=v.product_id;

SELECT v.id FROM product_variants v JOIN ce_variants t ON t.id=v.id FOR UPDATE OF v;
SELECT s.variant_id FROM branch_variant_stock s JOIN ce_variants t ON t.id=s.variant_id FOR UPDATE OF s;

CREATE TEMP TABLE ce_barcodes ON COMMIT DROP AS
SELECT b.id,b.variant_id,b.ean_code FROM barcodes b
JOIN ce_variants v ON v.id=b.variant_id;

CREATE TEMP TABLE ce_validation (
  name text NOT NULL,
  ok boolean NOT NULL CHECK (ok)
) ON COMMIT DROP;

INSERT INTO ce_validation (name,ok) VALUES
('Exactly 95 CHARAK product rows', (SELECT count(*)=95 FROM ce_products WHERE UPPER(BTRIM(brand_name))='CHARAK')),
('Exactly 45 ESSA product rows', (SELECT count(*)=45 FROM ce_products WHERE UPPER(BTRIM(brand_name))='ESSA')),
('Exactly 267 variant rows', (SELECT count(*)=267 FROM ce_variants)),
('No active target products', NOT EXISTS(SELECT 1 FROM ce_products WHERE is_active IS DISTINCT FROM FALSE)),
('No active target variants', NOT EXISTS(SELECT 1 FROM ce_variants WHERE is_active IS DISTINCT FROM FALSE)),
('No reserved stock', NOT EXISTS(SELECT 1 FROM branch_variant_stock s JOIN ce_variants v ON s.variant_id=v.id WHERE COALESCE(s.reserved,0)<>0)),
('No remaining stock', NOT EXISTS(SELECT 1 FROM branch_variant_stock s JOIN ce_variants v ON s.variant_id=v.id WHERE COALESCE(s.on_hand,0)<>0)),
('No sale item references', NOT EXISTS(
    SELECT 1 FROM sale_items si
    WHERE si.variant_id IN (SELECT id FROM ce_variants)
       OR si.ean_code IN (SELECT ean_code FROM ce_barcodes WHERE ean_code IS NOT NULL)
       OR UPPER(BTRIM(COALESCE(to_jsonb(si)->>'brand_name_snapshot',''))) IN ('CHARAK','ESSA')
)),
('No unknown foreign key dependencies', NOT EXISTS(
    SELECT 1 FROM pg_constraint
    WHERE contype='f' AND confrelid IN ('products'::regclass,'product_variants'::regclass)
      AND conrelid NOT IN (
        'product_variants'::regclass,'barcodes'::regclass,'branch_variant_stock'::regclass,
        'sale_items'::regclass,'product_colour_images'::regclass,'tarascart'::regclass,'taraswishlist'::regclass
      )
));

INSERT INTO tara_audit_log(user_id,branch_id,action,entity_id,details)
SELECT NULL,NULL,'OLD_BRANDS_PERMANENTLY_CLEANED','CHARAK_ESSA',
    jsonb_build_object(
        'removed_product_ids',(SELECT COALESCE(jsonb_agg(id),'[]'::jsonb) FROM ce_products),
        'removed_variant_ids',(SELECT COALESCE(jsonb_agg(id),'[]'::jsonb) FROM ce_variants),
        'old_stock_movements', (SELECT COALESCE(jsonb_agg(to_jsonb(m)),'[]'::jsonb)
          FROM tara_stock_movements m WHERE m.variant_id IN (SELECT id FROM ce_variants))
    );

DELETE FROM barcodes b USING ce_variants t WHERE b.variant_id=t.id;
DELETE FROM product_images pi WHERE pi.ean_code IN (SELECT ean_code FROM ce_barcodes)
  AND NOT EXISTS(SELECT 1 FROM barcodes b WHERE b.ean_code=pi.ean_code);
DELETE FROM branch_variant_stock s USING ce_variants t WHERE s.variant_id=t.id;
DELETE FROM tara_stock_movements m USING ce_variants t WHERE m.variant_id=t.id;
DELETE FROM tarascart c USING ce_products t WHERE c.product_id=t.id;
DELETE FROM taraswishlist w USING ce_products t WHERE w.product_id=t.id;
DELETE FROM product_colour_images pci USING ce_products t WHERE pci.product_id=t.id;
DELETE FROM product_variants v USING ce_variants t WHERE v.id=t.id;
DELETE FROM products p USING ce_products t WHERE p.id=t.id;

INSERT INTO ce_validation(name,ok) VALUES
('No remaining target products', NOT EXISTS(SELECT 1 FROM products WHERE UPPER(BTRIM(brand_name)) IN ('CHARAK','ESSA'))),
('No remaining target variants', NOT EXISTS(SELECT 1 FROM product_variants v JOIN ce_variants t ON t.id=v.id)),
('No remaining barcode mappings', NOT EXISTS(SELECT 1 FROM barcodes b JOIN ce_variants v ON v.id=b.variant_id)),
('No remaining stock records', NOT EXISTS(SELECT 1 FROM branch_variant_stock s JOIN ce_variants v ON v.id=s.variant_id));

SELECT name,ok FROM ce_validation ORDER BY name;
SELECT UPPER(BTRIM(brand_name)) brand,COUNT(*) remaining_product_rows
FROM products WHERE UPPER(BTRIM(brand_name)) IN ('CHARAK','ESSA') GROUP BY 1;

ROLLBACK;
