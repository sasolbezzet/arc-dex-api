import { SiweMessage } from 'siwe'
import { Wallet } from 'ethers'

const BASE_URL = process.env.BASE_URL || 'https://43.163.98.128.nip.io'
const PATH = process.env.API_PATH || '/api/auth/session'
const API = BASE_URL + PATH

const wallet = new Wallet('0x' + '1'.repeat(64))
const address = wallet.address
console.log('Test address:', address)

async function post(payload) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const text = await res.text()
  let body
  try { body = JSON.parse(text) } catch { body = text }
  return { status: res.status, body }
}

async function testLegacy() {
  const issuedAt = new Date().toISOString()
  const message = [
    'ARCOX DEX login',
    'Only sign this message on the official ARCOX DEX website.',
    `Address: ${address}`,
    `Issued At: ${issuedAt}`,
    'Network: Arc Testnet',
  ].join('\n')
  const signature = await wallet.signMessage(message)
  return post({ address, issuedAt, signature, mode: 'legacy' })
}

async function testSiwe() {
  const issuedAt = new Date().toISOString()
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString()
  const nonce = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join('')
  const siwe = new SiweMessage({
    domain: 'arcoxdex.vercel.app',
    address,
    statement: 'Only sign this message on the official ARCOX DEX website.',
    uri: 'https://arcoxdex.vercel.app/',
    version: '1',
    chainId: 5042002,
    nonce,
    issuedAt,
    expirationTime: expiresAt,
  })
  const message = siwe.prepareMessage()
  const signature = await wallet.signMessage(message)
  return post({ address, issuedAt, expiresAt, nonce, signature, mode: 'siwe', message })
}

async function run() {
  console.log('--- Legacy test ---')
  const legacy = await testLegacy()
  console.log('status:', legacy.status)
  console.log('body:', JSON.stringify(legacy.body, null, 2))

  console.log('--- SIWE test ---')
  const siwe = await testSiwe()
  console.log('status:', siwe.status)
  console.log('body:', JSON.stringify(siwe.body, null, 2))
}

run().catch(console.error)
