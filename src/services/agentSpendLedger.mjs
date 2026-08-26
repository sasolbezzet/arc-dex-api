// agentSpendLedger.mjs — per-agent daily spend ledger (Fase 3).
//
// Tracks how much one agent (agentKey = "<clientId>|<userId>") has spent in
// the current UTC day, so a per-agent dailyLimit can be enforced without
// affecting other agents or the owner's own vault limits.
//
// File: data/agent-spend.json (path overridable via AGENT_SPEND_PATH, e.g. the
// staging unit uses ./data-staging/agent-spend.json).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { atomicWriteJsonFile } from './jsonFileStore.mjs'

const DEFAULT_PATH = process.env.AGENT_SPEND_PATH || 'data/agent-spend.json'

function utcDayKey(now = Date.now()) {
  const d = new Date(now)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

function loadLedger() {
  if (!existsSync(DEFAULT_PATH)) return { day: utcDayKey(), agents: {} }
  try {
    const data = JSON.parse(readFileSync(DEFAULT_PATH, 'utf8'))
    if (!data || typeof data !== 'object') return { day: utcDayKey(), agents: {} }
    return data
  } catch {
    return { day: utcDayKey(), agents: {} }
  }
}

function saveLedger(ledger) {
  try {
    mkdirSync(dirname(DEFAULT_PATH), { recursive: true })
    atomicWriteJsonFile(DEFAULT_PATH, ledger)
  } catch (error) {
    // Non-fatal for execution: the daily gate still works in-memory for this
    // process; persistence failure only loses the running tally on restart.
    console.warn('[agentSpendLedger] persist failed:', error?.message || error)
  }
}

/** Record spend for one agent key (human units, e.g. "0.5"). Returns the new
 * running total for the current UTC day. */
export function recordSpend(agentKey, amountHuman) {
  const key = String(agentKey || '').trim().toLowerCase()
  if (!key) return 0
  const amount = Number(amountHuman)
  if (!Number.isFinite(amount) || amount <= 0) return 0
  const ledger = loadLedger()
  const day = utcDayKey()
  if (ledger.day !== day) {
    // New UTC day: reset the daily buckets.
    ledger.day = day
    ledger.agents = {}
  }
  if (!ledger.agents) ledger.agents = {}
  const row = ledger.agents[key] || { total: 0, count: 0 }
  row.total = Math.round((row.total + amount) * 1e6) / 1e6
  row.count += 1
  ledger.agents[key] = row
  saveLedger(ledger)
  return row.total
}

/** Total spent today by one agent key (0 when unknown). */
export function getDailySpend(agentKey) {
  const key = String(agentKey || '').trim().toLowerCase()
  const ledger = loadLedger()
  if (ledger.day !== utcDayKey()) return 0
  return Number(ledger.agents?.[key]?.total || 0)
}

/** Convenience: true when already spent amount + planned would exceed limit. */
export function wouldExceedDailyLimit(agentKey, plannedAmount, dailyLimit) {
  if (!Number.isFinite(Number(dailyLimit)) || Number(dailyLimit) <= 0) return false
  return getDailySpend(agentKey) + Number(plannedAmount || 0) > Number(dailyLimit)
}