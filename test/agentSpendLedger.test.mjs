import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// L0: per-agent daily spend ledger.
//  - recordSpend accumulates per agentKey and resets on UTC day change.
//  - getDailySpend is isolated per agent.
//  - wouldExceedDailyLimit gates only when a positive limit is configured.

async function withLedger(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'arcox-spend-ledger-'))
  const previous = process.env.AGENT_SPEND_PATH
  process.env.AGENT_SPEND_PATH = join(dir, 'agent-spend.json')
  try {
    const mod = await import('../src/services/agentSpendLedger.mjs?ledger-' + Date.now() + '-' + Math.random())
    return await fn(mod)
  } finally {
    if (previous === undefined) delete process.env.AGENT_SPEND_PATH
    else process.env.AGENT_SPEND_PATH = previous
    await rm(dir, { recursive: true, force: true })
  }
}

test('recordSpend accumulates per agent and stays isolated between agents', async () => {
  await withLedger(async ({ recordSpend, getDailySpend }) => {
    assert.equal(recordSpend('agent_a|0x1111', '0.5'), 0.5)
    assert.equal(recordSpend('agent_a|0x1111', '0.25'), 0.75)
    assert.equal(recordSpend('agent_b|0x1111', '2'), 2)
    assert.equal(getDailySpend('agent_a|0x1111'), 0.75)
    assert.equal(getDailySpend('agent_b|0x1111'), 2)
    assert.equal(getDailySpend('agent_c|0x1111'), 0)
  })
})

test('wouldExceedDailyLimit only gates when a positive limit is configured', async () => {
  await withLedger(async ({ recordSpend, wouldExceedDailyLimit }) => {
    recordSpend('agent_a|0x1111', '8')
    // Limit 10 → 8 + 1.5 = 9.5 ok; 8 + 3 = 11 exceeds.
    assert.equal(wouldExceedDailyLimit('agent_a|0x1111', '1.5', 10), false)
    assert.equal(wouldExceedDailyLimit('agent_a|0x1111', '3', 10), true)
    // Limit 0 / unset → never blocks.
    assert.equal(wouldExceedDailyLimit('agent_a|0x1111', '999', 0), false)
    assert.equal(wouldExceedDailyLimit('agent_a|0x1111', '999', NaN), false)
  })
})

test('ledger resets on UTC day change', async () => {
  await withLedger(async ({ recordSpend, getDailySpend }) => {
    recordSpend('agent_a|0x1111', '5')
    assert.equal(getDailySpend('agent_a|0x1111'), 5)
    // Simulate a new UTC day by writing a stale day key directly.
    const { writeFileSync } = await import('node:fs')
    const { readFileSync } = await import('node:fs')
    const path = process.env.AGENT_SPEND_PATH
    const ledger = JSON.parse(readFileSync(path, 'utf8'))
    ledger.day = '2000-01-01'
    writeFileSync(path, JSON.stringify(ledger))
    assert.equal(getDailySpend('agent_a|0x1111'), 0, 'old day totals are discarded')
  })
})