const fail = (message, status = 409) => {
  throw Object.assign(new Error(message), { status });
};

const positiveId = (value, label) => {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) fail(`Invalid ${label}`, 400);
  return id;
};

async function deleteProductPermanently(db, { variantId = null, productId = null, user, branchId = null }) {
  if (!user || !['SUPER_ADMIN', 'ADMIN'].includes(user.role) && !/^BRANCH\d+$/.test(user.role || '')) fail('Administrator access required', 403);
  if ((variantId === null) === (productId === null)) fail('Select a variant or entire product', 400);

  const requestedVariant = variantId === null ? null : positiveId(variantId, 'variant');
  const requestedProduct = productId === null ? null : positiveId(productId, 'product');
  const parentId = requestedProduct || (await db.query('SELECT product_id FROM product_variants WHERE id=$1', [requestedVariant])).rows[0]?.product_id;
  if (!parentId) fail('Product not found', 404);

  const product = (await db.query('SELECT id, name, brand_name FROM products WHERE id=$1 FOR UPDATE', [parentId])).rows[0];
  if (!product) fail('Product not found', 404);
  const variants = (await db.query('SELECT id FROM product_variants WHERE product_id=$1 ORDER BY id FOR UPDATE', [product.id])).rows;
  const ids = variants.filter(row => requestedVariant === null || Number(row.id) === requestedVariant).map(row => Number(row.id));
  if (requestedVariant !== null && !ids.length) fail('Variant not found', 404);
  if (!ids.length && requestedProduct === null) fail('No variants found', 404);

  const stocks = ids.length ? (await db.query('SELECT branch_id,variant_id,on_hand,reserved FROM branch_variant_stock WHERE variant_id=ANY($1::bigint[]) ORDER BY branch_id,variant_id FOR UPDATE', [ids])).rows : [];
  const branch = branchId === null ? Number(user.branch_id) : Number(branchId);
  if (user.role !== 'SUPER_ADMIN') {
    if (!Number.isSafeInteger(branch) || branch < 1 || branch !== Number(user.branch_id)) fail('Cannot delete products from another branch', 403);
    if (!ids.length || ids.some(id => !stocks.some(row => Number(row.variant_id) === id && Number(row.branch_id) === branch))) fail('Product is not stocked in your branch', 403);
    if (stocks.some(row => Number(row.branch_id) !== branch)) fail('Product belongs to multiple branches; ask Super Admin', 403);
  }
  if (stocks.some(row => Number(row.reserved || 0) !== 0)) fail('Product has stock reservations. Cancel or fulfill the open orders first.');

  const otherReferences = (await db.query(`
    SELECT conrelid::regclass::text AS child_table
    FROM pg_constraint
    WHERE contype='f' AND confrelid IN ('products'::regclass,'product_variants'::regclass)
      AND conrelid NOT IN (
        'product_variants'::regclass, 'barcodes'::regclass,
        'branch_variant_stock'::regclass, 'sale_items'::regclass,
        'product_colour_images'::regclass
      )
  `)).rows;
  const allowedAdditional = new Set(['tarascart', 'public.tarascart', 'taraswishlist', 'public.taraswishlist']);
  const unknown = otherReferences.filter(row => !allowedAdditional.has(row.child_table));
  if (unknown.length) fail(`Deletion requires review of other database references: ${unknown.map(row => row.child_table).join(', ')}`);

  const codes = ids.length ? (await db.query('SELECT ean_code FROM barcodes WHERE variant_id=ANY($1::bigint[]) ORDER BY id FOR UPDATE', [ids])).rows.map(row => row.ean_code).filter(Boolean) : [];
  if (ids.length) {
    const historicSales = await db.query(`
      SELECT 1 FROM sale_items
      WHERE variant_id=ANY($1::bigint[])
         OR (ean_code IS NOT NULL AND ean_code=ANY($2::text[]))
      LIMIT 1
    `, [ids, codes]);
    if (historicSales.rows.length) fail('This product is linked to historical sales. Permanent deletion is blocked to protect order history.');
  }

  const history = ids.length ? (await db.query(`
    SELECT COALESCE(jsonb_agg(to_jsonb(m) ORDER BY m.id), '[]'::jsonb) AS movements
    FROM tara_stock_movements m WHERE variant_id=ANY($1::bigint[])
  `, [ids])).rows[0].movements : [];
  const stockSnapshot = stocks.map(row => ({ branch_id: row.branch_id, variant_id: row.variant_id, on_hand: row.on_hand, reserved: row.reserved }));
  const deletesParent = requestedProduct !== null || variants.length === ids.length;

  if (ids.length) {
    await db.query('DELETE FROM barcodes WHERE variant_id=ANY($1::bigint[])', [ids]);
    await db.query('DELETE FROM branch_variant_stock WHERE variant_id=ANY($1::bigint[])', [ids]);
    await db.query('DELETE FROM tara_stock_movements WHERE variant_id=ANY($1::bigint[])', [ids]);
    await db.query('DELETE FROM product_variants WHERE id=ANY($1::bigint[])', [ids]);
  }
  if (codes.length) {
    await db.query(`DELETE FROM product_images pi WHERE pi.ean_code=ANY($1::text[])
      AND NOT EXISTS(SELECT 1 FROM barcodes b WHERE b.ean_code=pi.ean_code)`, [codes]);
  }
  if (deletesParent) {
    await db.query('DELETE FROM tarascart WHERE product_id=$1', [product.id]);
    await db.query('DELETE FROM taraswishlist WHERE product_id=$1', [product.id]);
    await db.query('DELETE FROM product_colour_images WHERE product_id=$1', [product.id]);
    const deleted = await db.query('DELETE FROM products WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM product_variants WHERE product_id=$1) RETURNING id', [product.id]);
    if (deleted.rowCount !== 1) fail('Unable to remove parent product; remaining variants detected');
  }

  const details = JSON.stringify({
    mode: requestedProduct === null ? 'variant' : 'entire_product',
    variant_ids: ids,
    barcode_count: codes.length,
    stock_removed: stockSnapshot,
    archived_stock_movements: history,
    parent_product_deleted: deletesParent
  });
  await db.query(`INSERT INTO tara_audit_log(user_id,branch_id,action,entity_id,details)
    VALUES($1,$2,'PRODUCT_PERMANENTLY_DELETED',$3,$4::jsonb)`, [user.id, user.role === 'SUPER_ADMIN' ? null : branch, String(product.id), details]);

  return {
    deleted: true,
    removal_method: 'permanent_database_delete',
    product_id: Number(product.id),
    deleted_product: deletesParent,
    deleted_variants: ids.length,
    released_barcodes: codes.length,
    archived_movements: Array.isArray(history) ? history.length : 0,
    message: 'Product records permanently deleted. Historical stock movements were preserved in the audit log.'
  };
}

module.exports = { deleteProductPermanently };
