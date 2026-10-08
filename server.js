require('dotenv').config()
const app=require('./app')
const port=Number(process.env.PORT)||5000
const server=app.listen(port,()=>console.log(`Tara API listening on port ${port}`))
process.on('SIGTERM',()=>server.close(()=>process.exit(0)))
