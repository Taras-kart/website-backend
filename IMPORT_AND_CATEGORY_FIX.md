# Tara's Kart — parent/child categories and Excel import fixes

## What changed
- The storefront uses actual active admin categories. For legacy parent-assigned products, storefront queries infer the child from **whole phrase** matches in product name / fit. This is a display fallback, not an automatic database update.
- Importing the *same exact Excel file* that previously completed under a **direct parent category** into a matching child category allows an audited parent-to-child product move. Already stocked branch variants do **not** receive the same quantity again. Brand/product/fit must match the child name. If another branch holds the product, reclassification is blocked.
- An all-failed import job can be retried by uploading the same file again to the same category after this backend is deployed. Completed or partly successful jobs are not automatically retried.
- The Admin Import page displays FAILED row errors and success/error totals.

## Evidence for the user-provided jobs
- Completed job 128: 17 rows in Women > Leggings, source: TWINBIRDS ... ANKLE.xlsx.
- Completed job 129: 14 rows in Women > Leggings, source: ... CHUDI.xlsx.
- Failed job 130: all 17 rows in Ankle (39).
- Failed job 131: all 14 rows in Chudidar (40).
- A HTTP 200 with processed:0 does **not** mean the rows uploaded; it can mean a terminal job.

## Deploy and retry
1. Back up the production PostgreSQL database; use staging first.
2. Deploy this backend project with your existing Vercel environment variables (do not replace them). The private `.env` was intentionally excluded.
3. Deploy `tara-admin` and `tara-website` frontends to their original Vercel projects. Keep their API base pointing to this backend.
4. Log in as branch admin, Import > select **Women > Leggings > Ankle**, and upload the **same exact Excel file** from completed job 128. The failed job 130 should be reset and reprocessed. For Chudidar, do the same with the file from job 129 and category Women > Leggings > Chudidar.
5. Check Recent Imports: expected status COMPLETE, 17/17 and 14/14 respectively, only if no other database validation fails; otherwise use View errors to inspect exact failures.
6. Verify that on-hand stock for the original variants has NOT increased merely due to reclassification and that the website shows Ankle/Chudidar as child tiles. Test each tile returns only the intended products.
7. Verify that a truly *new* Excel import into an active category still adds stock normally, and that a partial import does not repeat successful rows.

## Important limitations
- No live database, staging deployment, or full end-to-end browser test was available here. These updates are un-deployed source code, not a confirmation that the live application now works.
- The exact prior Excel file must have an import_job `file_hash` on its completed parent job; otherwise the backend will not use the safe reclassification mode. In that case, inspect View errors and perform a supervised category migration, not a duplicate stock receipt.
- The storefront fallback classifies from a child category's name in product name/fit. Products whose names/fit do not contain their category name require explicit classification in the database.
- Existing successful imports (jobs 128/129) should not be deleted or reprocessed merely to rename a category.

## Checks done here
- Node syntax checks of backend files.
- Nine local unit tests passed, including no duplicate stock for reclassification and no cross-branch category changes.
- Full DB-backed suite could not run without the database test dependencies; live integration remains necessary.
