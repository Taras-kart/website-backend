const router=require('express').Router()
const pool=require('../db')
const {requireAuth,scopeBranch}=require('../middleware/auth')
router.post('/scan',requireAuth,async(req,res,next)=>{
  try{const branch=scopeBranch(req),qty=Number(req.body.qty||1);if(!Number.isSafeInteger(qty)||qty<1)return res.status(400).json({message:'Enter a positive whole quantity'});const row=(await pool.query('SELECT b.variant_id,s.on_hand-s.reserved available FROM barcodes b JOIN branch_variant_stock s ON s.variant_id=b.variant_id WHERE b.ean_code=$1 AND s.branch_id=$2 AND s.is_active=TRUE',[req.body.ean_code,branch])).rows[0];if(!row)return res.status(404).json({message:'Product not stocked in this branch'});if(Number(row.available)<qty)return res.status(409).json({message:'Insufficient stock'});res.json({ok:true,variant_id:row.variant_id,available:row.available,reserved:false})}catch(e){next(e)}
})
module.exports=router
