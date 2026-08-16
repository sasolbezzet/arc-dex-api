// E2E: full on-chain Agentic Jobs flow via MCP tools (real testnet tx).
// register agent -> create job -> set budget -> fund escrow -> submit -> complete
// All executed by the Agent Wallet MSCA session key through the real tools.
import { createMcpServer } from '../src/services/mcpServer.mjs'

const WALLET = '0xdc0240dfcb438f41a6a4edeee1e4629a14e01769' // active MSCA session
const SELF = WALLET

const server = createMcpServer(WALLET)
const tools = server._registeredTools

async function call(name, params = {}) {
  const res = await tools[name].handler(params)
  const text = res.content?.[0]?.text || ''
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = text }
  console.log(`\n=== ${name} ===`)
  console.log(JSON.stringify(parsed, null, 1).slice(0, 1600))
  return parsed
}

// 0. Read-only checks first (no funds move)
await call('arcox_agentic_get_agent', { agentId: '851870' })
await call('arcox_agentic_ask', { prompt: 'Create a retail payment escrow job for 1 USDC on Arc Testnet and verify the deliverable.' })
await call('arcox_agentic_get_job', { jobId: '1' })

// 1. Register agent identity (mints ERC-8004 SBT) — REAL TX
const reg = await call('arcox_agentic_register_agent', { metadataUri: 'ipfs://bafkreibdi6623n3xpf7ymk62ckb4bo75o3qemwkpfvp5i25j66itxvsoei', confirmed: true, confirmationText: 'yes' })
let agentId = reg.agentId
if (!agentId) {
  console.log('\nRegister did not return agentId. Response above shows why.')
  process.exit(0)
}
console.log('\nAgent identity:', agentId)

// 2. Create job — REAL TX (provider/evaluator default to the session delegate
// EOA because ARC Memo is EOA-only: the commerce contract requires
// msg.sender == provider for setBudget/submit and == evaluator for complete.)
const created = await call('arcox_agentic_create_job', {
  description: 'ARCOX MCP agentic demo job on Arc Testnet',
  expiresInHours: 24,
  agentId,
  confirmed: true,
  confirmationText: 'yes',
})
const jobId = created.jobId
if (!jobId) process.exit(0)
console.log('\nJob id:', jobId)

// 3. Read job after creation
await call('arcox_agentic_get_job', { jobId })

// 4. Set budget — REAL TX
await call('arcox_agentic_set_budget', { jobId, amount: '1', agentId, confirmed: true, confirmationText: 'yes' })

// 5. Fund escrow (approve + fund in one UserOp) — REAL TX moves USDC
await call('arcox_agentic_fund_job', { jobId, amount: '1', agentId, confirmed: true, confirmationText: 'yes' })

// 6. Read job after funding
await call('arcox_agentic_get_job', { jobId })

// 7. Submit deliverable — REAL TX
await call('arcox_agentic_submit_deliverable', { jobId, deliverable: 'deliverable-approved-by-provider', agentId, confirmed: true, confirmationText: 'yes' })

// 8. Complete job (settles escrow back to provider = same wallet) — REAL TX
await call('arcox_agentic_complete_job', { jobId, reason: 'deliverable-approved', agentId, confirmed: true, confirmationText: 'yes' })

// 9. Read job final status
await call('arcox_agentic_get_job', { jobId })

console.log('\nDONE')
