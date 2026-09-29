function parsePackImport(row) {
  const text = value => String(value ?? '').trim();
  const integer = value => /^\d+$/.test(text(value)) && Number.isSafeInteger(Number(value)) && Number(value) <= 2147483647;
  const raw = text(row.purchaseqty).replace(/,/g, '');
  const explicit = text(row.packsize);
  const fit = text(row.fitt).match(/^PO\s*(\d+)$/i);
  const boxed = raw.match(/^(\d+)\s*(?:boxes|box|packs|pack)\s*\(\s*pack\s*of\s*(\d+)\s*\)$/i);
  const simple = raw.match(/^(\d+)\s*(?:boxes|box|packs|pack)$/i);
  const sizes = [];
  if (explicit) sizes.push(explicit);
  if (boxed) sizes.push(boxed[2]);
  if (fit) sizes.push(fit[1]);
  if (sizes.some(value => !integer(value) || Number(value) < 1)) return {
    error: 'PACK SIZE must be a positive whole number'
  };
  if (new Set(sizes.map(Number)).size > 1) return {
    error: 'PACK SIZE, FIT and quantity pack description disagree'
  };
  if (simple && !sizes.length) return {
    error: 'Enter PACK SIZE for box or pack quantities'
  };
  const qty = boxed ? boxed[1] : simple ? simple[1] : raw;
  if (!integer(qty)) return {
    error: 'Quantity must be a non-negative whole number of selling units, for example 1 or 1box (pack of3)'
  };
  return {
    quantity: Number(qty),
    packSize: sizes.length ? Number(sizes[0]) : 1
  };
}
module.exports = {
  parsePackImport
};
