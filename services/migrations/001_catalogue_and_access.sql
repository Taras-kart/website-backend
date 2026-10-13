DO $$
DECLARE t text; value text;
BEGIN
  IF to_regclass('public.products') IS NULL OR to_regclass('public.product_variants') IS NULL OR to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION 'This upgrade requires the existing Tara database. Restore its backup before running this migration.';
  END IF;
  SELECT udt_name INTO t FROM information_schema.columns WHERE table_schema='public' AND table_name='users' AND column_name='role_enum' AND data_type='USER-DEFINED';
  IF t IS NOT NULL THEN EXECUTE format('ALTER TYPE %I ADD VALUE IF NOT EXISTS %L',t,'ADMIN'); END IF;
  SELECT udt_name INTO t FROM information_schema.columns WHERE table_schema='public' AND table_name='sales' AND column_name='status' AND data_type='USER-DEFINED';
  IF t IS NOT NULL THEN FOREACH value IN ARRAY ARRAY['PLACED','PROCESSING','SHIPPED','DELIVERED','CANCELLED','B2B_PENDING','APPROVED','DISPATCHED'] LOOP EXECUTE format('ALTER TYPE %I ADD VALUE IF NOT EXISTS %L',t,value); END LOOP; END IF;
END $$;
BEGIN;
SELECT pg_advisory_xact_lock(73498101);
ALTER TABLE branches ADD COLUMN IF NOT EXISTS code text;
ALTER TABLE branches ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
ALTER TABLE branches ADD COLUMN IF NOT EXISTS address text;
ALTER TABLE branches ADD COLUMN IF NOT EXISTS city text;
ALTER TABLE branches ADD COLUMN IF NOT EXISTS state text;
ALTER TABLE branches ADD COLUMN IF NOT EXISTS pincode text;
ALTER TABLE branches ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE branches ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE branches ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_version integer NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login timestamptz;
ALTER TABLE products ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
ALTER TABLE products ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE products ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE products ADD COLUMN IF NOT EXISTS mark_code text;
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS pack_size integer NOT NULL DEFAULT 1;
ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS gender text;
ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS category_id bigint;
ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS file_hash text;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS stock_committed boolean NOT NULL DEFAULT false;
ALTER TABLE sales ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE sale_items ALTER COLUMN variant_id DROP NOT NULL;
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS b2b_product_id bigint;
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS product_name_snapshot text;
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS brand_name_snapshot text;
CREATE TABLE IF NOT EXISTS import_rows (id bigserial PRIMARY KEY,import_job_id bigint NOT NULL REFERENCES import_jobs(id),raw_row_json jsonb NOT NULL,status_enum text,error_msg text,created_at timestamptz NOT NULL DEFAULT now(),processed_at timestamptz);
ALTER TABLE import_rows ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE import_rows ADD COLUMN IF NOT EXISTS processed_at timestamptz;
CREATE TABLE IF NOT EXISTS tara_audit_log (id bigserial PRIMARY KEY,user_id bigint,branch_id bigint,action text NOT NULL,entity_id text,details jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS tara_stock_movements (id bigserial PRIMARY KEY,branch_id bigint NOT NULL,variant_id bigint NOT NULL,delta integer NOT NULL,balance integer NOT NULL,reason text NOT NULL,user_id bigint,reference text,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS tara_requests (key text PRIMARY KEY,user_id bigint NOT NULL,branch_id bigint,request_hash text NOT NULL,response jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS shiprocket_warehouses(id bigserial PRIMARY KEY,branch_id bigint UNIQUE NOT NULL REFERENCES branches(id),warehouse_id bigint,name text NOT NULL,pincode text,city text,state text,address text,phone text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS tara_login_attempts (key text PRIMARY KEY,attempts integer NOT NULL DEFAULT 0,window_started timestamptz NOT NULL DEFAULT now());
CREATE OR REPLACE FUNCTION tara_normalize(value text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT regexp_replace(lower(trim(COALESCE(value,''))),'[^a-z0-9]','','g') $$;
CREATE OR REPLACE FUNCTION tara_style_key(brand text,name text,pattern text,gender text,category_id bigint,fit text,pack_size integer) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT md5(tara_normalize(brand)||'|'||tara_normalize(name)||'|'||tara_normalize(pattern)||'|'||tara_normalize(gender)||'|'||COALESCE(category_id::text,'')||'|'||tara_normalize(fit)||'|'||COALESCE(pack_size,1)::text) $$;
CREATE INDEX IF NOT EXISTS tara_products_identity ON products (lower(trim(brand_name)),lower(trim(name)),gender,category_id);
CREATE INDEX IF NOT EXISTS tara_products_gender_category ON products(gender,category_id) WHERE is_active=true;
CREATE INDEX IF NOT EXISTS tara_products_category ON products(category_id) WHERE is_active=true;
CREATE INDEX IF NOT EXISTS tara_variants_product ON product_variants(product_id) WHERE is_active=true;
CREATE INDEX IF NOT EXISTS tara_stock_variant_branch ON branch_variant_stock(variant_id,branch_id) WHERE is_active=true;
CREATE INDEX IF NOT EXISTS tara_barcodes_variant ON barcodes(variant_id,id);
ALTER TABLE product_images ADD COLUMN IF NOT EXISTS image_type text NOT NULL DEFAULT 'front';
DO $$
DECLARE entry record;
BEGIN
  FOR entry IN SELECT c.conname FROM pg_constraint c WHERE c.conrelid='product_images'::regclass AND c.contype='u' AND c.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='product_images'::regclass AND attname='ean_code')]::smallint[] LOOP
    EXECUTE format('ALTER TABLE product_images DROP CONSTRAINT %I',entry.conname);
  END LOOP;
  FOR entry IN SELECT ci.relname FROM pg_index ix JOIN pg_class ci ON ci.oid=ix.indexrelid WHERE ix.indrelid='product_images'::regclass AND ix.indisunique AND NOT ix.indisprimary AND ix.indnatts=1 AND ix.indkey[0]=(SELECT attnum FROM pg_attribute WHERE attrelid='product_images'::regclass AND attname='ean_code') LOOP
    EXECUTE format('DROP INDEX %I',entry.relname);
  END LOOP;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS tara_image_ean_type ON product_images(ean_code,image_type);
CREATE INDEX IF NOT EXISTS tara_images_ean ON product_images(ean_code,image_type,uploaded_at DESC);
CREATE INDEX IF NOT EXISTS tara_colour_images ON product_colour_images(product_id,lower(trim(colour)),lower(trim(COALESCE(fit,''))));
CREATE INDEX IF NOT EXISTS tara_categories_parent ON product_categories(parent_id) WHERE is_active=true;
CREATE INDEX IF NOT EXISTS tara_sales_branch_date ON sales(branch_id,created_at DESC);
CREATE INDEX IF NOT EXISTS tara_sale_items_sale ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS tara_import_pending ON import_rows(import_job_id,status_enum,id);
CREATE UNIQUE INDEX IF NOT EXISTS tara_import_file_once ON import_jobs(branch_id,category_id,file_hash) WHERE file_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS tara_branches_code ON branches(lower(code)) WHERE code IS NOT NULL;
CREATE INDEX IF NOT EXISTS tara_audit_branch_date ON tara_audit_log(branch_id,created_at DESC);
CREATE INDEX IF NOT EXISTS tara_movements_branch ON tara_stock_movements(branch_id,created_at DESC);
COMMIT;
