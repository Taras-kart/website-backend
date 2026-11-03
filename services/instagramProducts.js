const {saveVariant,fail}=require('./catalogueWrite')
function codeFor(input){const code=String(input??'').trim().toUpperCase();if(!/^[A-Z0-9][A-Z0-9_-]{2,31}$/.test(code))fail('Reel code must be 3–32 letters, digits, underscores or hyphens (example: 10025 or REEL-25).');return code}
function mediaFor(input){const value=String(input??'').trim();if(!value)return null;if(value.length>1000)fail('Video URL is too long');try{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||!u.hostname)throw Error('invalid');return u.toString()}catch{fail('Video URL must be a public HTTPS link')}}
function captionFor(input){const value=String(input??'').trim();if(value.length>500)fail('Caption cannot exceed 500 characters');return value}
// Spreadsheet readers return either raw numeric cells or formatted currency strings.
// Accept valid Indian/Western grouping, but never silently accept malformed numbers.
function parseMoney(input, label='MRP', optional=false) {
  if (optional && (input===undefined || input===null || String(input).trim()==='')) return '';
  if (typeof input==='number') {
    if (!Number.isFinite(input)) fail(`${label} is invalid`);
    return input;
  }
  const value=String(input??'').trim().replace(/^(?:₹|Rs\.?|INR)\s*/i,'').trim();
  if (!/^(?:\d+(?:\.\d{1,2})?|\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d{1,2}(?:,\d{2})+,\d{3}(?:\.\d{1,2})?)$/.test(value))
    fail(`${label} is invalid: use a number such as 1099 or 1,099 (not ${String(input).slice(0,25)})`);
  return Number(value.replace(/,/g,''));
}
async function insertReel(db,body,branch,user){const code=codeFor(body.code);const existing=await db.query('SELECT 1 FROM instagram_products WHERE code=$1',[code]);if(existing.rows.length)fail(`Code ${code} already exists. Edit that Reel; never re-upload duplicate stock.`);const data=await saveVariant(db,{...body,ean:String(body.ean||`IG-${code}`)},branch,user,{reference:`INSTAGRAM:${code}`});const result=await db.query(`INSERT INTO instagram_products(code,variant_id,branch_id,video_url,caption,is_published,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[code,data.variant_id,branch,mediaFor(body.video_url),captionFor(body.caption),body.is_published!==false&&String(body.is_published??'true').toLowerCase()!=='false',user.id]);return {...result.rows[0],product_id:data.product_id,on_hand:data.on_hand}}
module.exports={codeFor,mediaFor,captionFor,parseMoney,insertReel}
