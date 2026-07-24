const fs = require('fs')
const dbPath = '/home/ubuntu/arc-dex-api/x402-invoices-db.json'
let db = []
try { db = JSON.parse(fs.readFileSync(dbPath, 'utf8')) } catch(e) { console.log(e) }

db.push({
  "invoiceId": "mock_invoice_123",
  "paymentId": "mock_payment_123",
  "status": "paid",
  "settlementStatus": "paid",
  "service": "arcox_intel",
  "resource": "/api/intel/address/0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  "txHash": "0xmocktxhash",
  "createdAt": new Date().toISOString(),
  "paidAt": new Date().toISOString()
})

fs.writeFileSync(dbPath, JSON.stringify(db, null, 2))
console.log("Mock paid invoice injected for balances resource.")
