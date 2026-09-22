#!/usr/bin/env node
// Diagnostik konektor MCP per agent (Grok, Claude, ChatGPT, Hermes).
//
// Menjawab pertanyaan: "agent sudah tampak terhubung, kenapa tidak bisa
// mendeteksi/membaca tool ARCOX?" — skrip ini mencocokkan klien OAuth yang
// terdaftar dengan access token yang benar-benar diterbitkan, lalu melakukan
// handshake MCP nyata memakai token itu.
//
// Pemakaian:
//   node scripts/diag-mcp-connector.mjs                 # semua agent
//   node scripts/diag-mcp-connector.mjs --agent grok    # filter nama agent
//   node scripts/diag-mcp-connector.mjs --base https://arcoxdex.vercel.app
//
// Nilai token tidak pernah dicetak.

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const dataDir = join(here, '..', 'data')

function arg(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? String(process.argv[index + 1] || '') : fallback
}

const agentFilter = arg('agent', '').toLowerCase()
const base = (arg('base', process.env.SERVER_URL || 'https://arcoxdex.vercel.app')).replace(/\/$/, '')

const clients = readStore('oauth-clients.json', 'clients')
const tokens = readStore('oauth-tokens.json', 'tokens')

function readStore(file, key) {
  try {
    const raw = JSON.parse(fs.readFileSync(join(dataDir, file), 'utf8'))
    return raw[key] || {}
  } catch {
    return {}
  }
}

const now = Date.now()
const rows = Object.entries(clients)
  .map(([clientId, client]) => {
    const name = String(client.clientName || '(tanpa nama)')
    const issued = Object.entries(tokens)
      .map(([token, row]) => ({ token, ...row }))
      .filter(row => row.clientId === clientId)
      .sort((a, b) => b.expires - a.expires)
    return { clientId, client, name, newest: issued[0] || null, tokenCount: issued.length }
  })
  .filter(row => !agentFilter || row.name.toLowerCase().includes(agentFilter))

if (!rows.length) {
  console.log(`Tidak ada klien OAuth yang cocok dengan filter "${agentFilter || '(semua)'}".`)
  process.exit(0)
}

console.log(`Target MCP : ${base}/mcp`)
console.log(`Klien OAuth: ${rows.length} baris${agentFilter ? ` (filter: ${agentFilter})` : ''}\n`)

let withoutToken = 0
for (const row of rows.slice(-40)) {
  const bindings = Object.values(row.client.tokenBindings || {})
  const hasToken = row.newest && row.newest.expires > now
  if (!hasToken) withoutToken++
  console.log(`• ${row.name}  [${row.clientId}]`)
  console.log(`   redirect   : ${(row.client.redirectUris || []).join(', ') || '-'}`)
  if (!row.newest) {
    console.log('   status     : ❌ belum ada access token — approval OAuth di halaman Plugin belum selesai.')
    console.log('                Selama token belum terbit, agent TIDAK bisa memanggil tools/list.')
  } else if (!hasToken) {
    console.log(`   status     : ⚠️ token kedaluwarsa (${new Date(row.newest.expires).toISOString()}) — agent harus reconnect.`)
  } else {
    console.log(`   status     : ✅ token aktif sampai ${new Date(row.newest.expires).toISOString()}`)
    console.log(`   MSCA       : ${row.newest.mscaWalletAddress || '-'}`)
    if (row.newest.resource && row.newest.resource !== `${base}/mcp`) {
      console.log(`   ⚠️ resource token (${row.newest.resource}) berbeda dari target di atas.`)
    }
  }
  if (bindings.length) console.log(`   binding    : ${bindings.join(', ')}`)
}

const withToken = rows.filter(row => row.newest && row.newest.expires > now).sort((a, b) => b.newest.expires - a.newest.expires)
if (!withToken.length) {
  console.log('\nTidak ada token aktif untuk diuji handshake-nya.')
  console.log('Selesaikan approval OAuth di halaman Plugin ARCOX (passkey + Setujui), lalu jalankan ulang skrip ini.')
  process.exit(withoutToken ? 1 : 0)
}

const pick = withToken[0]
console.log(`\n── Handshake MCP memakai token terbaru: ${pick.name} [${pick.clientId}]`)

async function handshake(token, accept, label) {
  const headers = { 'content-type': 'application/json', accept, authorization: `Bearer ${token}` }
  const init = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'arcox-diag', version: '1.0.0' } },
    }),
  })
  const sessionId = init.headers.get('mcp-session-id')
  await init.text()
  if (!init.ok) return console.log(`   ${label}: ❌ initialize HTTP ${init.status}`)

  const next = { ...headers, ...(sessionId ? { 'mcp-session-id': sessionId } : {}) }
  const list = await fetch(`${base}/mcp`, {
    method: 'POST', headers: next,
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
  })
  const raw = await list.text()
  const json = JSON.parse(raw.replace(/^event: message\ndata: /, '').trim())
  const tools = json.result?.tools || []
  const payloadBytes = Buffer.byteLength(raw)
  console.log(`   ${label}: HTTP ${list.status} · ${list.headers.get('content-type')} · ${tools.length} tool · ${payloadBytes} byte`)
  console.log(`      field non-standar "execution": ${raw.includes('"execution"') ? '❌ masih ada' : '✅ tidak ada'}`)

  if (tools.length) {
    const call = await fetch(`${base}/mcp`, {
      method: 'POST', headers: next,
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'arcox_session_status', arguments: {} } }),
    })
    const callRaw = await call.text()
    const text = callRaw.match(/"text":"(.*?)"\}/s)?.[1] || ''
    console.log(`      arcox_session_status: HTTP ${call.status}${text ? ` · ${text.slice(0, 120).replace(/\\"/g, '"')}` : ''}`)
  }
  return tools.length
}

const jsonOnly = await handshake(pick.newest.token, 'application/json', 'klien JSON-only')
const sse = await handshake(pick.newest.token, 'application/json, text/event-stream', 'klien SSE (Claude/ChatGPT)')

console.log('\nRingkasan')
console.log(`  klien tanpa token aktif : ${withoutToken}`)
console.log(`  tools JSON-only         : ${jsonOnly}`)
console.log(`  tools SSE               : ${sse}`)
if (withoutToken) {
  console.log('\nKesimpulan: ada klien yang sudah terdaftar tetapi belum pernah menukar kode OAuth')
  console.log('menjadi access token. Agent seperti itu akan tampil "terhubung" di sisi penyedia,')
  console.log('tetapi tools/list-nya tidak pernah berhasil. Ulangi connect lalu SELESAIKAN')
  console.log('halaman approval Plugin ARCOX (passkey → Setujui) sampai redirect balik ke agent.')
}
