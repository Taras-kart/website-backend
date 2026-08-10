// test_fit_end_to_end.js
// Simulates the exact GOKUL RN/RNS scenario using fully isolated TEST data.
// Creates a temporary test brand "___TESTBRAND___" so it can never collide
// with real products, runs the full import → variant → image flow, verifies
// each step, then deletes everything it created. Your real data is never
// touched.
//
//   node test_fit_end_to_end.js

require('dotenv').config()
const { Pool } = require('pg')
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
})

const TEST_BRAND = '___TESTBRAND___'
const TEST_PRODUCT = 'TEST VEST'
const TEST_PATTERN = 'TESTPATTERN'

let pass = 0
let fail = 0
function check(label, condition) {
  if (condition) {
    console.log(`  ✅ ${label}`)
    pass += 1
  } else {
    console.log(`  ❌ ${label}`)
    fail += 1
  }
}

async function cleanup(client) {
  // Delete in dependency order — products cascade to variants, but
  // barcodes/product_colour_images/product_images need explicit cleanup
  // since they don't all cascade from products.
  const prodRows = await client.query(
    `SELECT id FROM products WHERE brand_name = $1`,
    [TEST_BRAND]
  )
  const productIds = prodRows.rows.map(r => r.id)

  if (productIds.length) {
    await client.query(
      `DELETE FROM product_colour_images WHERE product_id = ANY($1::int[])`,
      [productIds]
    )
    await client.query(
      `DELETE FROM barcodes WHERE variant_id IN (
         SELECT id FROM product_variants WHERE product_id = ANY($1::int[])
       )`,
      [productIds]
    )
    await client.query(
      `DELETE FROM product_images WHERE ean_code LIKE '999TEST%'`
    )
    await client.query(
      `DELETE FROM branch_variant_stock WHERE variant_id IN (
         SELECT id FROM product_variants WHERE product_id = ANY($1::int[])
       )`,
      [productIds]
    )
    await client.query(`DELETE FROM products WHERE brand_name = $1`, [TEST_BRAND])
  }
}

async function run() {
  const client = await pool.connect()
  try {
    console.log('=== Cleaning any leftover test data from previous runs ===')
    await cleanup(client)
    console.log('✓ Clean slate\n')

    console.log('=== STEP 1: Simulate import — create product + two variants (RN and RNS) ===')
    await client.query('BEGIN')

    // Product creation (same pattern as branchInventoryRoutes.js import)
    const pRes = await client.query(
      `INSERT INTO products (name, brand_name, pattern_code, fit_type, mark_code, gender)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (name, brand_name, pattern_code, gender)
       DO UPDATE SET fit_type = EXCLUDED.fit_type, mark_code = EXCLUDED.mark_code
       RETURNING id`,
      [TEST_PRODUCT, TEST_BRAND, TEST_PATTERN, 'RN', null, 'WOMEN']
    )
    const productId = pRes.rows[0].id
    check('Product created', !!productId)

    // Variant 1: size 100, white, RN (mirrors GOKUL's real row)
    const v1 = await client.query(
      `INSERT INTO product_variants (product_id, size, colour, fit, is_active, mrp, sale_price, cost_price, b2c_discount_pct, b2b_discount_pct)
       VALUES ($1, '100', 'WHITE', 'RN', TRUE, 139, NULL, 0, 10, 0)
       ON CONFLICT (product_id, size, colour, fit)
       DO UPDATE SET mrp = EXCLUDED.mrp
       RETURNING id`,
      [productId]
    )
    const variant1Id = v1.rows[0].id

    // Variant 2: SAME size and colour, but RNS fit — this is the exact
    // collision case that was broken before this fix
    const v2 = await client.query(
      `INSERT INTO product_variants (product_id, size, colour, fit, is_active, mrp, sale_price, cost_price, b2c_discount_pct, b2b_discount_pct)
       VALUES ($1, '100', 'WHITE', 'RNS', TRUE, 173, NULL, 0, 10, 0)
       ON CONFLICT (product_id, size, colour, fit)
       DO UPDATE SET mrp = EXCLUDED.mrp
       RETURNING id`,
      [productId]
    )
    const variant2Id = v2.rows[0].id

    check('Two SEPARATE variants created for same size+colour, different fit', variant1Id !== variant2Id)

    // Barcodes for each
    await client.query(
      `INSERT INTO barcodes (variant_id, ean_code) VALUES ($1, '999TEST0001')
       ON CONFLICT (ean_code) DO UPDATE SET variant_id = EXCLUDED.variant_id`,
      [variant1Id]
    )
    await client.query(
      `INSERT INTO barcodes (variant_id, ean_code) VALUES ($1, '999TEST0002')
       ON CONFLICT (ean_code) DO UPDATE SET variant_id = EXCLUDED.variant_id`,
      [variant2Id]
    )
    check('Barcodes assigned to each variant', true)

    await client.query('COMMIT')

    console.log('\n=== STEP 2: Verify variant prices did NOT collide ===')
    const priceCheck = await client.query(
      `SELECT id, fit, mrp FROM product_variants WHERE id IN ($1, $2) ORDER BY fit`,
      [variant1Id, variant2Id]
    )
    const rnRow = priceCheck.rows.find(r => r.fit === 'RN')
    const rnsRow = priceCheck.rows.find(r => r.fit === 'RNS')
    check('RN variant kept its own price (139)', Number(rnRow?.mrp) === 139)
    check('RNS variant kept its own price (173) — NOT overwritten by RN', Number(rnsRow?.mrp) === 173)

    console.log('\n=== STEP 3: Simulate shared image upload for RN only ===')
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO product_colour_images (product_id, colour, fit, image_url, cloudinary_public_id, created_at, updated_at)
       VALUES ($1, 'WHITE', 'RN', 'https://example.com/test-rn-image.jpg', 'test_rn', NOW(), NOW())
       ON CONFLICT (product_id, (LOWER(BTRIM(colour))), (LOWER(BTRIM(COALESCE(fit, '')))))
       DO UPDATE SET image_url = EXCLUDED.image_url`,
      [productId]
    )
    await client.query(
      `UPDATE product_variants
       SET image_url = $4
       WHERE product_id = $1
         AND LOWER(BTRIM(colour)) = LOWER(BTRIM($2))
         AND LOWER(BTRIM(COALESCE(fit, ''))) = LOWER(BTRIM($3))`,
      [productId, 'WHITE', 'RN', 'https://example.com/test-rn-image.jpg']
    )
    await client.query('COMMIT')
    check('RN shared image uploaded', true)

    console.log('\n=== STEP 4: Verify RN variant shows the image, RNS does NOT ===')
    const barcodeCheck1 = await client.query(
      `SELECT
         pv.fit,
         pci.image_url AS shared_image_url
       FROM barcodes b
       JOIN product_variants pv ON pv.id = b.variant_id
       LEFT JOIN product_colour_images pci
         ON pci.product_id = pv.product_id
        AND LOWER(BTRIM(pci.colour)) = LOWER(BTRIM(pv.colour))
        AND LOWER(BTRIM(COALESCE(pci.fit, ''))) = LOWER(BTRIM(COALESCE(pv.fit, '')))
       WHERE b.ean_code = '999TEST0001'`
    )
    const barcodeCheck2 = await client.query(
      `SELECT
         pv.fit,
         pci.image_url AS shared_image_url
       FROM barcodes b
       JOIN product_variants pv ON pv.id = b.variant_id
       LEFT JOIN product_colour_images pci
         ON pci.product_id = pv.product_id
        AND LOWER(BTRIM(pci.colour)) = LOWER(BTRIM(pv.colour))
        AND LOWER(BTRIM(COALESCE(pci.fit, ''))) = LOWER(BTRIM(COALESCE(pv.fit, '')))
       WHERE b.ean_code = '999TEST0002'`
    )

    check(
      'RN barcode (999TEST0001) resolves to the uploaded image',
      barcodeCheck1.rows[0]?.shared_image_url === 'https://example.com/test-rn-image.jpg'
    )
    check(
      'RNS barcode (999TEST0002) does NOT get RN\'s image (correctly isolated)',
      barcodeCheck2.rows[0]?.shared_image_url == null
    )

    console.log('\n=== STEP 5: Now upload a DIFFERENT image for RNS — prove both coexist independently ===')
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO product_colour_images (product_id, colour, fit, image_url, cloudinary_public_id, created_at, updated_at)
       VALUES ($1, 'WHITE', 'RNS', 'https://example.com/test-rns-image.jpg', 'test_rns', NOW(), NOW())
       ON CONFLICT (product_id, (LOWER(BTRIM(colour))), (LOWER(BTRIM(COALESCE(fit, '')))))
       DO UPDATE SET image_url = EXCLUDED.image_url`,
      [productId]
    )
    await client.query('COMMIT')

    const finalCheck = await client.query(
      `SELECT
         pv.fit,
         pci.image_url AS shared_image_url
       FROM product_variants pv
       LEFT JOIN product_colour_images pci
         ON pci.product_id = pv.product_id
        AND LOWER(BTRIM(pci.colour)) = LOWER(BTRIM(pv.colour))
        AND LOWER(BTRIM(COALESCE(pci.fit, ''))) = LOWER(BTRIM(COALESCE(pv.fit, '')))
       WHERE pv.product_id = $1
       ORDER BY pv.fit`,
      [productId]
    )
    console.log('  Final state:')
    finalCheck.rows.forEach(r => console.log(`    fit=${r.fit} -> image=${r.shared_image_url}`))

    const rnFinal = finalCheck.rows.find(r => r.fit === 'RN')
    const rnsFinal = finalCheck.rows.find(r => r.fit === 'RNS')
    check('RN still has its own image (unaffected by RNS upload)', rnFinal?.shared_image_url === 'https://example.com/test-rn-image.jpg')
    check('RNS now has its own distinct image', rnsFinal?.shared_image_url === 'https://example.com/test-rns-image.jpg')

    console.log('\n=== CLEANUP: Removing all test data ===')
    await cleanup(client)
    console.log('✓ Test data fully removed — your real data was never touched\n')

    console.log('════════════════════════════════════')
    console.log(`RESULTS: ${pass} passed, ${fail} failed`)
    console.log('════════════════════════════════════')

    if (fail > 0) {
      console.error('\n❌ SOME TESTS FAILED — do not deploy until fixed.')
      process.exit(1)
    } else {
      console.log('\n✅ ALL TESTS PASSED — safe to deploy.')
    }
  } catch (e) {
    try { await client.query('ROLLBACK') } catch {}
    console.error('\n❌ Test script error:', e.message)
    console.log('\nAttempting cleanup after error...')
    try {
      await cleanup(client)
      console.log('✓ Cleanup succeeded despite error')
    } catch (cleanupErr) {
      console.error('⚠️  Cleanup also failed — you may need to manually check for rows with brand_name = ___TESTBRAND___')
    }
    process.exit(1)
  } finally {
    client.release()
    await pool.end()
  }
}

run()