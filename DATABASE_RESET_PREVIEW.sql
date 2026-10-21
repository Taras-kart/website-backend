-- READ-ONLY inventory of tables relevant to a full catalogue + orders reset.
-- Run against a COPY of production first. Does not change the database.
WITH targets(name) AS (
  VALUES ('product_images'),('product_colour_images'),('product_variants'),('products'),
    ('barcodes'),('branch_variant_stock'),('tara_stock_movements'),('tarascart'),
    ('taraswishlist'),('sale_items'),('sales'),('payments'),('shipments'),
    ('reverse_shipments'),('return_items'),('return_requests'),('order_cancellations'),
    ('import_rows'),('import_jobs'),('tara_requests'),('b2b_products'),
    ('b2b_stock_movements'),('coin_transactions')
)
SELECT name AS candidate_table,
       to_regclass(format('public.%I',name)) IS NOT NULL AS table_exists
FROM targets ORDER BY name;

-- Find tables with foreign keys into catalogue and sale records. These may
-- need an application-specific archival/deletion decision BEFORE a reset.
SELECT referencing.relname AS referencing_table,
       referenced.relname AS referenced_table,
       con.conname AS foreign_key
FROM pg_constraint con
JOIN pg_class referencing ON referencing.oid=con.conrelid
JOIN pg_class referenced ON referenced.oid=con.confrelid
WHERE con.contype='f'
 AND referenced.relname IN ('products','product_variants','sales','sale_items','b2b_products')
ORDER BY referenced.relname, referencing.relname;
