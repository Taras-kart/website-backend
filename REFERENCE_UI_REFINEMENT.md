# Backend refinements (October 2026)

- Branch-admin-only writes to /api/categories: POST /, PUT /:id, PATCH /:id/status. Super admins receive HTTP 403.
- /api/manage/stock accepts q, gender, category_id, stock_state, sort, low, branch_id, limit, offset.
- /api/manage/sales accepts q, status, payment, source, start, end, branch_id, limit, offset.
- /api/manage/movements accepts q, direction, branch_id, limit, offset.
- Transactional barcode release when deleting a product is inherited from earlier update.
- Database schema migrations are unchanged by this UI-only release.
- Run unit/integration tests and validate live roles in staging.

- /api/manage/transactions: customer payment summaries, COD/prepaid type, full search/status/date filters; bank settlements deliberately are not inferred.
- /api/manage/customers: branch-scoped aggregated customer directory from branch order history.
- Existing /api/manage/movements remains available as Stock Movements under More.
- The access gateway allows category mutations to reach the branch-role authorization layer while preserving staff authentication.
