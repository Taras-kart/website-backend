-- DANGER: PERMANENT DATA DELETION. NEVER RUN WITHOUT A VERIFIED DB BACKUP.
-- This script is NOT invoked by the application or deployment.
-- Run this ONLY on a staged duplicate until FK dependencies and backups are verified.
-- To approve in your psql session: SET tara.reset_authorized = 'I_HAVE_A_VERIFIED_BACKUP';
-- No CASCADE: an unanticipated foreign key ABORTS the transaction safely.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
DO $reset$
DECLARE
  authorized boolean := current_setting('tara.reset_authorized',true) = 'I_HAVE_A_VERIFIED_BACKUP';
  names text[] := ARRAY[
    'product_images','product_colour_images','product_variants','products',
    'barcodes','branch_variant_stock','tara_stock_movements','tarascart',
    'taraswishlist','sale_items','sales','payments','shipments',
    'reverse_shipments','return_items','return_requests','order_cancellations',
    'import_rows','import_jobs','tara_requests','b2b_products',
    'b2b_stock_movements','coin_transactions'
  ];
  existing text[];
  missing_essentials text[];
  stmt text;
BEGIN
  IF NOT authorized THEN
    RAISE EXCEPTION 'Reset blocked: require an independently verified backup and session approval';
  END IF;
  SELECT array_agg(format('public.%I',tbl)) INTO existing FROM unnest(names) AS t(tbl)
   WHERE to_regclass(format('public.%I',tbl)) IS NOT NULL;
  SELECT array_agg(tbl) INTO missing_essentials FROM unnest(ARRAY['products','product_variants','sales','sale_items','tarascart','taraswishlist']) AS t(tbl)
   WHERE to_regclass(format('public.%I',tbl)) IS NULL;
  IF array_length(missing_essentials,1) IS NOT NULL THEN
    RAISE EXCEPTION 'Reset blocked: expected commerce tables missing: %',missing_essentials;
  END IF;
  IF array_length(existing,1) IS NULL THEN
    RAISE EXCEPTION 'Reset blocked: no known tables located';
  END IF;
  -- Does not erase users, branches, category definitions, staff, configuration,
  -- coin balances, or home-page settings. FK restrictions may prevent commit.
  stmt := 'TRUNCATE TABLE ' || array_to_string(existing,', ') || ' RESTART IDENTITY RESTRICT';
  EXECUTE stmt;
  RAISE NOTICE 'Commerce tables cleared. Verify with SELECTs before releasing the environment.';
END;
$reset$;
COMMIT;
