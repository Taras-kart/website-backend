WITH target_eans(ean_code) AS (
 VALUES
 ('11559175'),
 ('11559274'),('11559276'),('11559267'),('11559265'),('11559266'),
 ('11559264'),('11559256'),('11559258'),('11559260'),('11559262'),
 ('11559257'),('11559259'),('11559261'),('11559263'),('11559268'),
 ('11559269'),('11559270'),('11559272'),('11559279'),('11559271'),
 ('11559280'),('11559275'),('11559277'),('11559273'),('11559278')
),
styles(name, pattern_code) AS (
 VALUES
 ('NIGHTY','CH-ND-02'),
 ('FEEDING NIGHTY','CH-ND-02'),('FEEDING NIGHTY','CH-ND-03'),
 ('FEEDING NIGHTY','CH-ND-04'),('FEEDING NIGHTY','CH-ND-05'),
 ('FEEDING NIGHTY','CH-ND-06'),('FEEDING NIGHTY','CH-ND-07'),
 ('FEEDING NIGHTY','CH-ND-08'),('FEEDING NIGHTY','CH-ND-09'),
 ('FEEDING NIGHTY','CH-ND-10')
),
counts AS (
 SELECT
   (SELECT COUNT(*) FROM target_eans) AS file_barcodes,
   (SELECT COUNT(*) FROM barcodes b JOIN target_eans t ON t.ean_code=b.ean_code) AS still_assigned_barcodes,
   (SELECT COUNT(DISTINCT v.id) FROM products p JOIN product_variants v ON v.product_id=p.id JOIN styles s ON UPPER(BTRIM(p.name))=s.name AND UPPER(BTRIM(COALESCE(p.pattern_code,'')))=s.pattern_code WHERE UPPER(BTRIM(p.brand_name))='CHARAK' AND p.gender::text='WOMEN' AND v.is_active=TRUE) AS matching_active_variants,
   (SELECT COUNT(DISTINCT p.id) FROM products p JOIN styles s ON UPPER(BTRIM(p.name))=s.name AND UPPER(BTRIM(COALESCE(p.pattern_code,'')))=s.pattern_code WHERE UPPER(BTRIM(p.brand_name))='CHARAK' AND p.gender::text='WOMEN' AND p.is_active=FALSE) AS historical_retired_products
)
SELECT *,
 CASE WHEN still_assigned_barcodes=0 AND matching_active_variants=0
 THEN 'READY: Both complete files can be reimported after deploying new backend'
 ELSE 'BLOCKED: Some barcodes or variants are still active; do not reimport the entire file yet' END AS reimport_status
FROM counts;

SELECT id, file_name, status_enum, rows_total, rows_success, rows_error, category_id, uploaded_at
FROM import_jobs
WHERE branch_id=3 AND (file_name ILIKE '%CHARAK%NIGHTY%' OR file_name ILIKE '%CHARAK%FEEDING%')
ORDER BY id DESC LIMIT 30;
