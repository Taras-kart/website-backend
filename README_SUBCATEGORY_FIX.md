# Tara Backend — Public Brand Subcategories Endpoint

## Original error
The Tara website requests `GET /api/products/subcategories?brand=Twin+Birds&categoryId=6` but the original backend did not register the route, so it returned its global HTML `Not found` handler (HTTP 404).

## Changes
- New public `GET /api/products/subcategories` in `routes/catalogueRoutes.js`.
  - Requires a nonempty `brand` and a positive integer `categoryId` (400 for invalid input).
  - Filters by active products/variants, selected brand, and category descendants.
  - Groups distinct product styles into labels inferred from product name, fit, and pattern code (Shimmer, Cotton, etc.; unknown items go to Other).
  - Returns `{ "subcategories": [{ "slug": "shimmer", "count": 1, "representative_image": null, "images": [] }], "total": 1 }` when matching products exist.
  - Returns HTTP 200 `{ "subcategories": [], "total": 0 }` for a category with no matching products; this is not an error.
- The existing `GET /api/products/catalogue` and `/facets` now honour the `subtype` query parameter for matching style-group links, using the same categorization rules. Unknown subtype values produce empty catalogues rather than broadening scope.
- No new database tables or schema migrations.

## Deploy
1. Back up the backend before replacing it. Deploy the included `backend/` project to the same Vercel backend project used by the website.
2. Verify:
   `https://taras-kart-backend.vercel.app/api/products/subcategories?brand=Twin+Birds&categoryId=6`
3. The response should be JSON with keys `subcategories` and `total`. The count may be 0 if no active Twin Birds products belong to category 6; this is not the original missing-route 404.
4. Verify the `/api/products/catalogue?brand=Twin+Birds&categoryId=6&subtype=shimmer` list contains only the selected style (when matching products exist).
5. Deploy the website ZIP and retest on desktop/mobile.

## Tests
- `node --test test/subcategories.unit.test.js`: passed (2 tests)
- `node --check routes/catalogueRoutes.js` and related source syntax: passed
- An integration regression test was added to `test/integration.test.js` but not run because this working environment lacks the required npm packages (notably PostgreSQL PGlite and supertest). Run `npm ci` and `npm test` in CI before production deployment.
