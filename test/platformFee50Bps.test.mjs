import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { readFileSync } from 'node:fs'

// Kebijakan fee platform ARCOX adalah 50 bps (0,5%). Test ini mengunci
// DEFAULT-nya — nilai yang dipakai saat env tidak disetel — bukan sekadar nilai
// saat env diisi. Kalau fallback di service, endpoint treasury, atau server
// berubah tanpa sengaja, test ini gagal.
process.env.ARC_NETWORK = 'mainnet'
process.env.SUPABASE_PERSISTENCE_MODE = 'off'

const FEE_ENV = [
  'X402_PLATFORM_FEE_BPS',
  'ARCOX_ROUTER_FEE_BPS_MAINNET',
  'ARCOX_ROUTER_FEE_BPS',
  'ARCOX_FEE_BPS',
]

async function withoutFeeEnv(fn) {
  const saved = Object.fromEntries(FEE_ENV.map((name) => [name, process.env[name]]))
  for (const name of FEE_ENV) delete process.env[name]
  try {
    return await fn()
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

const { applyPlatformFee, platformFeeBps, publicPlatformFee } = await import('../src/services/platformFee.mjs')
const { default: treasuryRoutes } = await import('../src/routes/treasuryRoutes.mjs')

test('service fee platform default 50 bps = 0,5% saat env tidak disetel', async () => {
  await withoutFeeEnv(() => {
    assert.equal(platformFeeBps(), 50)
    const split = applyPlatformFee('1')
    assert.equal(split.feeAmount, '0.005000')
    assert.equal(split.totalAmount, '1.005000')
    const policy = publicPlatformFee()
    assert.equal(policy.bps, 50)
    assert.equal(policy.percent, 0.5)
  })
})

test('env tetap bisa menimpa default dan kembali ke 50 saat dihapus', async () => {
  await withoutFeeEnv(() => {
    process.env.X402_PLATFORM_FEE_BPS = '500'
    assert.equal(platformFeeBps(), 500)
    assert.equal(applyPlatformFee('1').feeAmount, '0.050000')
    delete process.env.X402_PLATFORM_FEE_BPS
    assert.equal(platformFeeBps(), 50)
  })
})

test('endpoint /api/treasury/status default 50 bps dan menghormati env', async () => {
  const app = express()
  app.use(express.json())
  app.use('/api/treasury', treasuryRoutes)
  const listener = await new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server))
    server.on('error', reject)
  })
  try {
    const base = `http://127.0.0.1:${listener.address().port}`
    await withoutFeeEnv(async () => {
      const response = await fetch(`${base}/api/treasury/status`)
      const body = await response.json()
      assert.equal(response.status, 200)
      assert.equal(body.feeBps, 50)
      assert.equal(body.maxFeeBps, 1_000)
    })
    process.env.ARCOX_ROUTER_FEE_BPS_MAINNET = '125'
    const overridden = await (await fetch(`${base}/api/treasury/status`)).json()
    assert.equal(overridden.feeBps, 125)
  } finally {
    await new Promise((resolve) => listener.close(resolve))
  }
})

test('sumber server dan treasury memakai fallback 50 bps, bukan 500', () => {
  const server = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
  const treasury = readFileSync(new URL('../src/routes/treasuryRoutes.mjs', import.meta.url), 'utf8')
  const fallback = /process\.env\.ARCOX_FEE_BPS \|\|\s*\n\s*50,/
  assert.match(server, fallback, 'server.mjs PLATFORM_FEE_BPS harus fallback ke 50')
  assert.match(treasury, fallback, 'treasuryRoutes.mjs feeBps harus fallback ke 50')
  assert.doesNotMatch(server, /process\.env\.ARCOX_FEE_BPS \|\|\s*\n\s*500,/)
  assert.doesNotMatch(treasury, /process\.env\.ARCOX_FEE_BPS \|\|\s*\n\s*500,/)
})
