# Taras Kart — Instagram / Reel Products Feature

## Added to the existing projects

**Database**: `migrations/002_instagram_reel_products.sql` creates `public.instagram_products` with a unique case-insensitive code, variant and branch references, video link, caption, publication status and timestamps. No old table, product category, admin, or branch records are dropped. Expect **49 public tables** if you previously had 48.

**Backend**: `routes/instagramProductRoutes.js`, `services/instagramProducts.js`, updated `app.js`, catalogue code search in `utils/catalogue.js`, and updated `scripts/migrate.js`. Existing checkout and POS stock allocation are unchanged.

**Admin**: new **Instagram Products** admin menu at `/instagram-products`: **Bulk Upload** is default (Section 1 Excel, Section 2 photos), plus **Single Product**, video upload, editing, code links, list/search. Template located at `public/templates/Tara-Instagram-Import-Template.xlsx`.

**Storefront**: the standard storefront catalogue/search includes Reel products; there is NO extra Shop Reels navigation item. `/reels` redirects to regular `/search`, while `/reel/REEL-1001` remains a valid direct code link, with buying through `/product/:variantId`.

## Deployment order (do not reverse)

1. **Back up Neon PostgreSQL** and check the backup can be restored. Use a staging Neon branch first.
2. In DBeaver connected to the correct database `neondb`, open the SQL file `tara-backend/migrations/002_instagram_reel_products.sql`, execute the whole script once. Running it again is idempotent for a correct existing table. **Do not rerun any commerce reset SQL.**
3. Confirm migration:

```sql
SELECT to_regclass('public.instagram_products') AS new_table;
SELECT COUNT(*) AS instagram_rows FROM public.instagram_products;
SELECT COUNT(*) AS admins_kept FROM public.users;
SELECT COUNT(*) AS categories_kept FROM public.product_categories;
SELECT COUNT(*) AS branches_kept FROM public.branches;
```

   Expected initially: new table exists, instagram_rows=0, admin/categories/branches still present.
4. Merge the backend changes into the **existing** GitHub backend repo, preserving its Git history; deploy the backend to Vercel.
5. Merge/deploy admin and storefront changes. **These ZIPs are based on the latest source ZIPs provided in this chat, not a live pull from GitHub.** Merge carefully if your GitHub repos have newer changes.
6. In Vercel, ensure the backend has `DATABASE_URL`, `JWT_SECRET` and existing payment/storage settings. For **image and direct video upload**, configure `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` on the **backend** only (never in a React client). Image uploads use Cloudinary when configured; otherwise set a working `BLOB_READ_WRITE_TOKEN` for Vercel Blob. If Cloudinary video upload isn't configured, paste an HTTPS video or Instagram Reel URL instead.
7. Admin Vercel: set `REACT_APP_API_BASE` (your deployed backend URL) and `REACT_APP_STOREFRONT_URL` (your **actual** customer site). Website Vercel: set `REACT_APP_API_BASE`. The API backend must allow both frontend origins in `CORS_ORIGINS` (if configured).
8. If you run `npm run migrate`, `scripts/migrate.js` now applies the older migration 001 and the new migration 002. Prefer the SQL file directly for an already-upgraded production DB. Never paste a production connection string into source or Git.

## Reel stock semantics

- A Reel code identifies **one existing physical product variant** (one colour and size), not a separate virtual warehouse.
- Creating a Reel product uses the existing product+variant+branch stock receipt path. Its new quantity increases the shared physical inventory. POS and website checkout operate on the same stock.
- Looking up or viewing a Reel does **not** deduct or reserve any stock; purchase processing does.
- Reel codes accept 3–32 characters: A–Z, 0–9, underscore, hyphen. Case-insensitive; `00123` is distinct from `123`. Use TEXT formatting in Excel to preserve leading zeros.
- Re-uploading a used code is an error and **does not add stock again**. To adjust stock later, use the existing Admin → Stocks workflow.
- A new code defaults to published unless `is_published` is FALSE. Editing publish status hides/shows the **Reel page/listing only**; it does not globally retire a product from regular product catalogues. Use product management if you need to remove the item everywhere.
- An Instagram Reel URL is linked to external Instagram. Upload a direct MP4/WebM or a Cloudinary video link to play it on the storefront. Add the matching Reel code as an overlay in your marketing video before posting to Instagram; this app does not edit the external video.
- Deleting an underlying product permanently also removes its Reel association via foreign-key cascade; deleting a branch is restricted if Reel rows still reference it.

## Excel format

Download from Admin → Instagram Products → Bulk Upload → Section 1 → **Download Excel template**. Only the first sheet, `ReelProducts`, is imported. Each row has `reel_code`, `product_name`, `brand`, `gender`, `category_id`, `style_code`, `fit`, `colour`, `size`, `barcode`, `mrp`, `selling_price`, `cost_price`, `quantity`, `pack_size`, `image_url`, `video_url`, `caption`, `is_published`.

Required fields: code, name, brand, gender, **existing active subcategory ID**, colour, size, MRP and quantity. Barcode optional (defaults to `IG-<CODE>`), other optional fields may be blank. Maximum 200 rows/2 MB. When any row fails, the transaction rolls back **all** rows and stock receipts.

### Essential staging QA

- [ ] Admin login works; select branch. Add Reel `REEL-101` with one variant, photo, price and 5 stock.
- [ ] Same code entered as lowercase in customer search returns the correct product.
- [ ] `/reel/REEL-101` shows the correct size, price and image; `/reels` redirects to normal `/search`; the normal product list includes the product.
- [ ] `00123` and `123` are distinguishable. Duplicate `REEL-101` rejected; stock unchanged.
- [ ] Upload two spreadsheet rows, one intentionally invalid: no products or stock created.
- [ ] Correct the file: both rows imported and attached to the chosen branch. Re-upload same file: rejected without doubling quantity.
- [ ] Publish toggle hides Reel-code lookup from `/reel/:code` but does not erase stock or independently hide a normal catalogue product.
- [ ] Create with zero stock: visible as out-of-stock; checkout must disallow purchase.
- [ ] Buy one in staging and verify that the actual stock decreases from 5 to 4 in the existing checkout transaction, not on search.
- [ ] Branch admin cannot upload/edit another branch's inventory.
- [ ] Test video upload with Cloudinary credentials; test paste-only Instagram link fallback.
- [ ] Test mobile search, card layout and direct product navigation.

**Local verification performed:** Backend JS syntax checks and TypeScript JSX syntax parses passed. Six source/service-level unit tests passed. **Not performed:** full npm/Vercel builds, live Neon migration, browser runs, Cloudinary uploads, real checkout or POS transactions. Test these on staging before production.

## Future commerce resets

Your earlier Option 1 reset SQL was written before this new table. If you reset again later, it must include `public.instagram_products` in the same transaction before truncating variants/products or PostgreSQL `RESTRICT` will block the reset. Do not casually re-run your earlier reset script or delete categories/users/branches.

## 2026-11-03 — Import/MRP fix and separate photo upload

The `Row 3: MRP is invalid` error was caused by reading Excel's formatted display strings. Example: an Excel numeric `1099` can display as `1,099`; `Number('1,099')` is NaN. The importer now reads **raw numeric cells** and accepts valid currency-formatted strings such as `₹ 1,099.00` or `1,50,000` (it still rejects malformed input). All rows remain transactional. Duplicate code uploads do not add stock again.

Admin → Instagram Products now opens on the **Bulk Upload** tab. Section 1 uploads Excel/CSV. Section 2 uploads image files matching existing Reel codes from Section 1. Select 1–30 JPG, PNG, or WebP photos (each up to 10 MB). Use one image per code/view per batch:

- `910011.jpg` or `910011__front.jpg`: front image for code `910011`
- `910011__back.png`: back image for code `910011`
- `REEL-910013__side.webp`: side image for code `REEL-910013`
- `REEL-910013__detail.jpg`: detail image for code `REEL-910013`

Image batches precheck that **all codes exist in the selected branch**. Then files upload to Cloudinary or Vercel Blob and the image URL associations are committed in a **single database transaction**. Photo upload does NOT change product quantity. The standard `product_images` and `product_variants.image_url` are used, so **no new table or migration is needed** if `instagram_products` already exists. A failed cloud upload may leave unlinked media files in cloud storage but does not partially attach DB image records.

The **Single Product** tab can create a product with one photo or a direct HTTPS image URL. Video uploads remain available. Product metadata is visible on the normal catalogue and regular checkout. The `is_published` flag controls Reel-code links, not the visibility of an already active catalogue variant.

### Deployment order for this update

1. Update and deploy the **backend** first; wait for its `/api/health` success. **No SQL change required** after the already-run Instagram migration.
2. Update and deploy the **admin**, then **customer website**. These files derive from earlier ZIPs; if GitHub has newer commits, carefully merge instead of overwriting.
3. Download and test `Tara_Kart_Instagram_Dummy_Test_Fixed.xlsx` in staging. Verify category ID 57 is a valid active WOMEN child category and select an active branch.
4. On Bulk Upload, upload Excel. Image filenames must exactly match the uploaded Reel codes. Then upload images in Section 2.
5. Test searching code `00910012` in normal website search; check product photo gallery, price, stock, checkout and POS. Test bad filenames, unknown codes, duplicate view files, oversized files and image storage errors.

**Limitations:** Full production npm/React builds, real Cloudinary uploads and the live Neon/checkout integration could not be executed in this working environment. Static source and unit checks are not substitutes for those deployment tests.
