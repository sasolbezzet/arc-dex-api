// bridgeHistory.mjs — Agent Wallet (MSCA) bridge history.
//
// Bridges executed by an agent over MCP are stored as vault approvals
// (`action: 'bridge'`, details carry the MSCA wallet + burn/mint tx hashes).
// Those approvals never reached the browser history (localStorage) or
// /api/tx-history, so a chain balance could change without any visible reason
// for the user. This module normalizes each approval into a TxRecord-shaped row
// that both the web history UI and the MCP tools can read.
import { listApprovals } from './vaultStore.mjs'
import { readAgentApprovals } from './supabasePersistence.mjs'
import { CHAINS } from './chains.mjs'
import { arcCctpChain, arcCctpChains } from '../config/arcNetwork.mjs'

export const BRIDGE_ACTION = 'bridge'
// Same `source` value the history panel filter (`agent`) already expects.
export const BRIDGE_HISTORY_SOURCE = 'agent-mcp'

const CHAIN_LABELS = {
  arc: 'Arc',
  ethereum: 'Ethereum',
  eth: 'Ethereum',
  base: 'Base',
  arbitrum: 'Arbitrum',
  arb: 'Arbitrum',
  hyperevm: 'HyperEVM',
  solana: 'Solana',
}

const PENDING_STATUSES = new Set(['pending', 'approved', 'auto_approved', 'pending_signature', 'pending_confirmation', 'submitted', 'submission_unknown'])
const ERROR_STATUSES = new Set(['error', 'failed', 'denied', 'rejected', 'cancelled', 'canceled'])

/** 'Arc_Testnet' / 'base-mainnet' / 'Arbitrum' → label chain frontend ('Arc', 'Base', ...). */
export function frontendChainLabel(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const normalized = raw.toLowerCase().replace(/[\s_]+/g, '-').replace(/-(mainnet|testnet|sepolia|devnet)$/, '')
  return CHAIN_LABELS[normalized] || raw
}

function parseDetails(details) {
  if (!details) return {}
  if (typeof details === 'object') return details
  try {
    const parsed = JSON.parse(String(details))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function explorerBase(chainName, chainKey) {
  const direct = arcCctpChain(chainName)
  if (direct?.explorer) return direct.explorer
  const chains = Object.values(arcCctpChains())
  const chainId = CHAINS[chainKey]?.id
  if (chainId) {
    const byId = chains.find(cfg => Number(cfg?.chainId) === Number(chainId) && cfg?.explorer)
    if (byId) return byId.explorer
  }
  // Records written on another network (or without a chain key) still resolve
  // to their explorer through the normalized chain label: 'Arc' → 'Arc_Testnet',
  // 'Base' → 'Base_Sepolia', 'Ethereum' → 'Ethereum'.
  const wanted = frontendChainLabel(chainName || chainKey).toLowerCase()
  if (!wanted) return ''
  const byLabel = chains.find(cfg => frontendChainLabel(cfg?.name).toLowerCase().startsWith(wanted) && cfg?.explorer)
  return byLabel?.explorer || ''
}

function explorerUrl(base, hash) {
  const tx = String(hash || '').trim()
  return base && tx ? `${base}${tx}` : ''
}

function filled(value) {
  return value !== undefined && value !== null && value !== ''
}

/**
 * Bridge rows are `pending` while the burn is in flight even when the approval
 * row itself already reports an error (attestation/nonce unknown). A burn that
 * happened must never be presented as a plain failure.
 */
export function bridgeHistoryStatus(approvalStatus, settlementStatus) {
  const approval = String(approvalStatus || '').trim().toLowerCase()
  const settlement = String(settlementStatus || '').trim().toLowerCase()
  if (PENDING_STATUSES.has(approval) || PENDING_STATUSES.has(settlement)) return 'pending'
  if (ERROR_STATUSES.has(approval) || ERROR_STATUSES.has(settlement)) return 'error'
  return 'success'
}

/** Normalize one `action: 'bridge'` approval into a TxRecord-shaped row. */
export function normalizeBridgeApproval(approval) {
  if (!approval || String(approval.action || '').trim().toLowerCase() !== BRIDGE_ACTION) return null
  const details = parseDetails(approval.details)
  const fromChain = String(details.fromChain || '')
  const toChain = String(details.toChain || '')
  const fromChainKey = String(details.sourceChainKey || '')
  const toChainKey = String(details.destinationChainKey || '')
  if (!fromChain && !fromChainKey && !toChain && !toChainKey) return null

  const burnTx = String(details.burnTxHash || '').trim()
  const mintTx = String(details.mintTxHash || '').trim()
  const settlementStatus = String(details.settlementStatus || '').trim()
  const settlementPhase = String(details.settlementPhase || '').trim()
  const status = bridgeHistoryStatus(approval.status, settlementStatus)
  const burnExplorerUrl = explorerUrl(explorerBase(fromChain, fromChainKey), burnTx)
  const mintExplorerUrl = explorerUrl(explorerBase(toChain, toChainKey), mintTx)
  const safeToRetry = details.safeToRetry === true
  const amount = String(approval.amount || details.amount || '')
  const agent = String(approval.agent || '')

  // `phase submission_unknown` on an already-successful row reads like a
  // failure in the UI, so the phase is only narrated while the bridge is still
  // settling; the structured field below always keeps it for auditing.
  const noteParts = ['Bridge Agent Wallet (MSCA)']
  if (agent) noteParts.push(`agent ${agent}`)
  if (settlementPhase && status !== 'success') noteParts.push(`phase ${settlementPhase}`)
  if (status === 'pending' && burnTx && !mintTx) {
    noteParts.push(safeToRetry
      ? 'penerimaan destination belum selesai; aman diretry dengan burnTxHash yang sama'
      : 'penerimaan destination mengikuti worker auto-mint; jangan burn ulang')
  }
  if (status === 'error' && settlementStatus && settlementStatus !== 'error') {
    noteParts.push(`settlement status ${settlementStatus}`)
  }

  return {
    id: `bridge-${approval.id}`,
    approvalId: String(approval.id || ''),
    ts: Number(approval.createdAt || approval.updatedAt || 0) || Date.now(),
    action: BRIDGE_ACTION,
    source: BRIDGE_HISTORY_SOURCE,
    walletSource: 'circle',
    from: frontendChainLabel(fromChain || fromChainKey),
    to: frontendChainLabel(toChain || toChainKey),
    fromChainKey,
    toChainKey,
    amount,
    token: String(approval.token || 'USDC'),
    status,
    tx: burnTx || mintTx,
    explorer: burnExplorerUrl || mintExplorerUrl,
    burnTx,
    burnExplorerUrl,
    mintTx,
    mintExplorerUrl,
    srcDomain: Number.isFinite(Number(details.srcDomain)) ? Number(details.srcDomain) : undefined,
    dstDomain: Number.isFinite(Number(details.dstDomain)) ? Number(details.dstDomain) : undefined,
    error: String(approval.error || details.reason || (status === 'error' ? 'bridge failed' : '')),
    note: noteParts.join(' · '),
    // Deliberately NOT named `owner`: the browser history merge drops rows
    // whose `owner` differs from the connected wallet, and this record is
    // already owner-scoped by the authenticated endpoint.
    ownerAddress: String(approval.owner || ''),
    agent,
    walletAddress: String(details.walletAddress || ''),
    settlementStatus,
    settlementPhase,
    safeToRetry,
    pendingMint: status === 'pending' && Boolean(burnTx) && !mintTx,
    sourceApprovalUserOpHash: String(details.sourceApprovalUserOpHash || ''),
    destinationUserOpHash: String(details.destinationUserOpHash || ''),
  }
}

/**
 * Two approvals can point at the same burn: an earlier intent that failed to
 * submit and was later healed when the retry finally burned, plus the intent
 * that executed it. They must collapse into one bridge row, otherwise the UI
 * shows the same hop twice with different amounts.
 */
function preferBridgeRecord(candidate, existing) {
  const score = record => (record.mintTx ? 2 : 0) + (record.status === 'success' ? 1 : 0)
  const diff = score(candidate) - score(existing)
  if (diff !== 0) return diff > 0 ? candidate : existing
  return Number(candidate.ts || 0) >= Number(existing.ts || 0) ? candidate : existing
}

/** Normalize + filter (wallet) + dedupe (burn) + sort bridge approvals into history rows. */
export function bridgeRecordsFromApprovals(approvals = [], { walletAddress = '', limit = 50 } = {}) {
  const wallet = String(walletAddress || '').trim().toLowerCase()
  const byKey = new Map()
  for (const approval of Array.isArray(approvals) ? approvals : []) {
    const record = normalizeBridgeApproval(approval)
    if (!record) continue
    const recordWallet = String(record.walletAddress || '').toLowerCase()
    // A wallet filter must only match rows that actually carry that wallet:
    // legacy approvals without a walletAddress cannot be attributed safely.
    if (wallet && recordWallet !== wallet) continue
    const key = record.burnTx ? `burn:${record.burnTx.toLowerCase()}` : `id:${record.id}`
    const existing = byKey.get(key)
    byKey.set(key, existing ? preferBridgeRecord(record, existing) : record)
  }
  const rows = [...byKey.values()].sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0))
  return rows.slice(0, Math.max(1, Math.min(Number(limit) || 50, 200)))
}

/** Read bridge history for a single owner (local vault + Supabase shadow). */
export async function readBridgeHistory(owner, { walletAddress = '', limit = 50 } = {}) {
  const normalizedOwner = String(owner || '').trim()
  if (!normalizedOwner) return { records: [], source: 'none', owners: [] }
  const local = listApprovals(normalizedOwner)
  const read = await readAgentApprovals(normalizedOwner, local)
    .catch(error => ({ approvals: local, source: 'json', error: error?.message || 'approval read failed' }))
  const records = bridgeRecordsFromApprovals(read.approvals || local, { walletAddress, limit })
  return { records, source: read.source, owners: [normalizedOwner], error: read.error || '' }
}

/**
 * Read bridge history across every address in the owner cluster
 * (EOA + linked MSCA), so an agent authenticated as the MSCA still sees the
 * EOA-owned approvals that funded that wallet.
 */
export async function readBridgeHistoryForOwners(owners = [], { walletAddress = '', limit = 50 } = {}) {
  const unique = [...new Set((Array.isArray(owners) ? owners : [owners])
    .map(owner => String(owner || '').trim().toLowerCase())
    .filter(Boolean))]
  const byId = new Map()
  const sources = []
  let error = ''
  for (const owner of unique) {
    const read = await readBridgeHistory(owner, { walletAddress, limit })
    sources.push(read.source)
    if (read.error) error = read.error
    for (const record of read.records) if (!byId.has(record.id)) byId.set(record.id, record)
  }
  const records = [...byId.values()]
    .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0))
    .slice(0, Math.max(1, Math.min(Number(limit) || 50, 200)))
  return { records, sources, owners: unique, error }
}

function preferFilled(primary, fallback) {
  const merged = { ...fallback }
  for (const [key, value] of Object.entries(primary || {})) if (filled(value)) merged[key] = value
  return merged
}

/**
 * Merge bridge rows into an existing history list. Local/browser rows win only
 * for fields the server record does not carry, so a later mint tx hash from the
 * auto-mint worker is always applied.
 */
export function mergeBridgeRecordsIntoHistory(items = [], records = [], limit = 100) {
  const byId = new Map()
  for (const item of Array.isArray(items) ? items : []) {
    if (item?.id) byId.set(String(item.id), item)
  }
  for (const record of Array.isArray(records) ? records : []) {
    if (!record?.id) continue
    const existing = byId.get(String(record.id))
    byId.set(String(record.id), existing ? preferFilled(record, existing) : record)
  }
  return [...byId.values()]
    .sort((a, b) => Number(b?.ts || 0) - Number(a?.ts || 0))
    .slice(0, Math.max(1, Number(limit) || 100))
}

function addDecimalStrings(left, right) {
  const parse = value => {
    const raw = String(value ?? '0').trim()
    const match = /^-?\d+(?:\.\d+)?$/.test(raw) ? raw : '0'
    const negative = match.startsWith('-')
    const [integer, fraction = ''] = (negative ? match.slice(1) : match).split('.')
    return { negative, integer, fraction }
  }
  const a = parse(left)
  const b = parse(right)
  const places = Math.max(a.fraction.length, b.fraction.length)
  const scale = 10n ** BigInt(places)
  const toUnits = value => {
    const padded = (value.fraction || '').padEnd(places, '0') || '0'
    const units = BigInt(value.integer || '0') * scale + BigInt(padded)
    return value.negative ? -units : units
  }
  const total = toUnits(a) + toUnits(b)
  const negative = total < 0n
  const absolute = negative ? -total : total
  if (places === 0) return `${negative ? '-' : ''}${absolute}`
  const fraction = absolute.toString().slice(-places).padStart(places, '0').replace(/0+$/, '')
  return `${negative ? '-' : ''}${absolute / scale}${fraction ? `.${fraction}` : ''}`
}

/** Decimal-string addition shared with the MCP balance/history summaries. */
export const addDecimalAmounts = addDecimalStrings

/** Status/route summary for the MCP bridge-history tool. */
export function summarizeBridgeHistory(records = []) {
  const summary = {
    total: 0,
    pending: 0,
    success: 0,
    error: 0,
    pendingMint: [],
    chains: {},
  }
  for (const record of Array.isArray(records) ? records : []) {
    summary.total++
    if (record.status === 'pending') summary.pending++
    else if (record.status === 'error') summary.error++
    else summary.success++
    if (record.pendingMint) {
      summary.pendingMint.push({
        burnTxHash: record.burnTx || '',
        from: record.from,
        to: record.to,
        amount: record.amount,
        token: record.token,
        safeToRetry: record.safeToRetry === true,
        ts: record.ts,
      })
    }
    const token = String(record.token || 'USDC')
    for (const [chain, direction] of [[record.from, 'out'], [record.to, 'in']]) {
      if (!chain) continue
      const bucket = summary.chains[chain] || (summary.chains[chain] = { in: {}, out: {} })
      bucket[direction][token] = addDecimalStrings(bucket[direction][token], record.amount)
    }
  }
  return summary
}
