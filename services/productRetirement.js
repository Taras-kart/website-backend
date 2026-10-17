const { deleteProductPermanently } = require('./productPermanentDelete');

async function retireVariant(db, variantId, { user, branchId = null } = {}) {
  return deleteProductPermanently(db, { variantId, user, branchId });
}

module.exports = { retireVariant };
