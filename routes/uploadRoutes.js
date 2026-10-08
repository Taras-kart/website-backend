const router=require('express').Router()
const multer=require('multer')
const crypto=require('crypto')
const {put}=require('@vercel/blob')
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:10*1024*1024}})
router.post('/',upload.single('image'),async(req,res,next)=>{
  try{
    const file=req.file
    if(!file)return res.status(400).json({message:'Select an image'})
    const bytes=file.buffer
    const ext=bytes[0]===255&&bytes[1]===216?'jpg':bytes.subarray(1,4).toString()==='PNG'?'png':bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP'?'webp':null
    if(!ext)return res.status(400).json({message:'Use a JPEG, PNG or WebP image'})
    const mime=ext==='jpg'?'image/jpeg':`image/${ext}`
    const cloud=process.env.CLOUDINARY_CLOUD_NAME,key=process.env.CLOUDINARY_API_KEY,secret=process.env.CLOUDINARY_API_SECRET
    if(cloud&&key&&secret){
      const timestamp=String(Math.floor(Date.now()/1000)),publicId=`products/${crypto.randomUUID()}`
      const signature=crypto.createHash('sha1').update(`public_id=${publicId}&timestamp=${timestamp}${secret}`).digest('hex')
      const form=new FormData();form.set('file',new Blob([bytes],{type:mime}),`${crypto.randomUUID()}.${ext}`);form.set('api_key',key);form.set('timestamp',timestamp);form.set('public_id',publicId);form.set('signature',signature)
      const response=await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cloud)}/image/upload`,{method:'POST',body:form,signal:AbortSignal.timeout(30000)})
      const data=await response.json();if(!response.ok)throw new Error('Image storage rejected the upload')
      return res.json({imageUrl:data.secure_url,secure_url:data.secure_url,public_id:data.public_id})
    }
    const token=process.env.BLOB_READ_WRITE_TOKEN||process.env.VERCEL_BLOB_READ_WRITE_TOKEN||process.env.VERCEL_BLOB_RW_TOKEN
    if(!token)return res.status(503).json({message:'Configure Cloudinary or Blob image storage on the server'})
    const result=await put(`products/${crypto.randomUUID()}.${ext}`,bytes,{access:'public',contentType:mime,token})
    res.json({imageUrl:result.url,secure_url:result.url})
  }catch(e){next(e)}
})
module.exports=router
