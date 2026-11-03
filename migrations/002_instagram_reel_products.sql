-- ADDITIVE migration only. Run on existing PostgreSQL database after verifying a backup.
BEGIN;
SET LOCAL lock_timeout = '10s';
DO $$ BEGIN
 IF to_regclass('public.products') IS NULL OR to_regclass('public.product_variants') IS NULL
 OR to_regclass('public.branches') IS NULL OR to_regclass('public.users') IS NULL
 THEN RAISE EXCEPTION 'Existing Tara Kart schema required'; END IF;
END $$;
CREATE TABLE IF NOT EXISTS public.instagram_products (
 id BIGSERIAL PRIMARY KEY,
 code TEXT NOT NULL CHECK(code ~ '^[A-Z0-9][A-Z0-9_-]{2,31}$'),
 variant_id BIGINT NOT NULL REFERENCES public.product_variants(id) ON DELETE CASCADE,
 branch_id BIGINT NOT NULL REFERENCES public.branches(id) ON DELETE RESTRICT,
 video_url TEXT CHECK(video_url IS NULL OR video_url ~ '^https://'),
 caption TEXT NOT NULL DEFAULT '' CHECK(length(caption)<=500),
 is_published BOOLEAN NOT NULL DEFAULT TRUE,
 created_by BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ig_products_code_unique ON public.instagram_products(UPPER(BTRIM(code)));
CREATE INDEX IF NOT EXISTS ig_products_variant ON public.instagram_products(variant_id);
CREATE INDEX IF NOT EXISTS ig_products_public ON public.instagram_products(branch_id, created_at DESC) WHERE is_published;
COMMIT;
