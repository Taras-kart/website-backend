const crypto = require('crypto')
const {put} = require('@vercel/blob')
const {fail} = require('./catalogueWrite')

async function storeImage(file){
  if(!file||!file.buffer)fail('Select a JPEG, PNG or WebP image')
  const bytes=file.buffer
  const ext=bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff?'jpg':
    bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'png':
    bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP'?'webp':null
  if(!ext)fail('Invalid image content. Use a real JPG, PNG or WebP file')
  const type=ext==='jpg'?'image/jpeg':`image/${ext}`
  const cloud=process.env.CLOUDINARY_CLOUD_NAME,key=process.env.CLOUDINARY_API_KEY,secret=process.env.CLOUDINARY_API_SECRET
  if(cloud&&key&&secret){
    const timestamp=String(Math.floor(Date.now()/1000)),publicId=`tara-reels/${crypto.randomUUID()}`
    const signature=crypto.createHash('sha1').update(`public_id=${publicId}&timestamp=${timestamp}${secret}`).digest('hex')
    const form=new FormData()
    form.set('file',new Blob([bytes],{type}),`${crypto.randomUUID()}.${ext}`)
    form.set('api_key',key);form.set('timestamp',timestamp);form.set('public_id',publicId);form.set('signature',signature)
    const response=await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cloud)}/image/upload`,{method:'POST',body:form,signal:AbortSignal.timeout(45000)})
    const data=await response.json()
    if(!response.ok||!data.secure_url)throw Object.assign(new Error('Cloudinary image upload failed: '+(data.error?.message||response.status)),{status:502})
    return {imageUrl:data.secure_url}
  }
  const token=process.env.BLOB_READ_WRITE_TOKEN||process.env.VERCEL_BLOB_READ_WRITE_TOKEN||process.env.VERCEL_BLOB_RW_TOKEN
  if(!token)throw Object.assign(new Error('Configure Cloudinary or Vercel Blob image storage in backend environment variables'),{status:503})
  const result=await put(`tara-reels/${crypto.randomUUID()}.${ext}`,bytes,{access:'public',contentType:type,token})
  return {imageUrl:result.url}
}
module.exports={storeImage}
