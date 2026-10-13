/* Safely retire a product variant without destroying financial/order history.
   Barcode mappings alone are physically deleted so an EAN can be assigned again.
   The caller must run this helper inside a database transaction. */
const invalid = (message, status = 400) => {
  throw Object.assign(new Error(message), { status });
};
async function retireVariant(db, variantId, { user, branchId = null } = {}) {
  const id = Number(variantId);
  if (!Number.isSafeInteger(id) || id <= 0) invalid('Invalid product variant', 400);
  if (!user || (user.role !== 'SUPER_ADMIN' && user.role !== 'ADMIN' && !/^BRANCH\d+$/.test(user.role || ''))) invalid('Admin access required', 403);

  const variants = await db.query(`
    SELECT v.id, v.product_id, v.is_active, p.name
    FROM product_variants v
    JOIN products p ON p.id = v.product_id
    WHERE v.id = $1 FOR UPDATE OF v, p
  `, [id]);
  const variant = variants.rows[0];
  if (!variant || !variant.is_active) invalid('Active product not found', 404);

  // Lock each stock row before evaluating reservations. No partial deletion.
  const stocks = await db.query(`
    SELECT branch_id, on_hand, reserved FROM branch_variant_stock
    WHERE variant_id = $1 ORDER BY branch_id FOR UPDATE
  `, [id]);
  if (user.role !== 'SUPER_ADMIN') {
    const branch = Number(branchId || user.branch_id);
    if (!Number.isSafeInteger(branch) || !branch || branch !== Number(user.branch_id)) invalid('This branch is outside your access', 403);
    if (!stocks.rows.some(row => Number(row.branch_id) === branch)) invalid('Product is not stocked in your branch', 404);
    if (stocks.rows.some(row => Number(row.branch_id) !== branch)) invalid('A Super Admin must delete products used by multiple branches', 403);
  }
  if (stocks.rows.some(stock => Number(stock.reserved || 0) > 0)) invalid('Cannot delete this product while it has active stock reservations. Fulfill or cancel open orders first.', 409);

  // Preserve movements and sales foreign keys. Clear available inventory before retiring.
  for (const stock of stocks.rows) {
    const quantity = Number(stock.on_hand || 0);
    if (quantity !== 0) {
      await db.query(`
        INSERT INTO tara_stock_movements(branch_id, variant_id, delta, balance, reason, user_id, reference)
        VALUES($1, $2, $3, 0, 'PRODUCT_DELETED', $4, 'ADMIN_PRODUCT_DELETE')
      `, [stock.branch_id, id, -quantity, user.id]);
    }
  }
  await db.query(`UPDATE branch_variant_stock SET on_hand = 0, is_active = FALSE WHERE variant_id = $1`, [id]);

  // Permanent mapping removal releases the unique ean_code constraint for the next import.
  const barcodes = await db.query('DELETE FROM barcodes WHERE variant_id = $1 RETURNING ean_code', [id]);
  await db.query('UPDATE product_variants SET is_active = FALSE WHERE id = $1', [id]);
  await db.query(`
    UPDATE products SET is_active = FALSE, deleted_at = NOW(), updated_at = NOW()
    WHERE id = $1 AND NOT EXISTS (
      SELECT 1 FROM product_variants WHERE product_id = $1 AND is_active = TRUE
    )
  `, [variant.product_id]);

  return {
    id,
    product_id: variant.product_id,
    name: variant.name,
    released_barcodes: barcodes.rows.length,
    barcodes: barcodes.rows.map(row => row.ean_code),
    message: 'Product retired and barcode mappings released. Order and stock history retained.'
  };
}
module.exports = { retireVariant };
