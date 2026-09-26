import { ARC_CHAIN_KEY, ARC_EXTERNAL_CHAIN_KEYS } from '../config/arcNetwork.mjs'

/**
 * Agent-scoped readiness is intentionally independent from the OAuth protocol.
 * Hermes uses the connection-token flag while Claude/ChatGPT use OAuth tokens;
 * both can be represented here without changing their authentication flow.
 */

// Chain tujuan inbound bridge (Base/Arbitrum → Arc) yang diperiksa
// kesiapannya, mengikuti jaringan aktif: testnet `base-sepolia`/
// `arbitrum-sepolia`, mainnet `base-mainnet`/`arbitrum-mainnet`.
export const DESTINATION_READINESS_CHAINS = ARC_EXTERNAL_CHAIN_KEYS.filter(key => /^(base|arbitrum)/.test(key))

export function buildAgentReadiness({
  agentKey = '',
  clientId = '',
  agentType = 'custom',
  binding,
  tokenActive = false,
  tokenExpiresAt = null,
  mcpSessionActive = false,
  sessionActive = false,
  chainAuthorizationStatus = {},
} = {}) {
  const revoked = binding?.active === false
  const arcAuthorized = chainAuthorizationStatus[ARC_CHAIN_KEY] === 'authorized'
  const destination = Object.fromEntries(DESTINATION_READINESS_CHAINS.map(chain => [
    chain,
    chainAuthorizationStatus[chain] === 'authorized',
  ]))
  const destinationReady = DESTINATION_READINESS_CHAINS.every(chain => destination[chain])

  return {
    agentKey,
    clientId,
    agentType,
    revoked,
    mcp: {
      // `tokenActive` means the credential is configured and not expired;
      // `mcpSessionActive` means the connector has made a live MCP request.
      configured: tokenActive,
      connected: tokenActive && mcpSessionActive,
      tokenActive,
      tokenExpiresAt,
    },
    execution: {
      ready: !revoked && sessionActive && arcAuthorized && destinationReady,
      sessionActive: !revoked && sessionActive,
      arcAuthorized: !revoked && arcAuthorized,
      destinations: Object.fromEntries(DESTINATION_READINESS_CHAINS.map(chain => [
        chain,
        !revoked && sessionActive && destination[chain],
      ])),
      reason: revoked
        ? 'agent_binding_revoked'
        : !sessionActive
          ? 'session_inactive'
          : !arcAuthorized
            ? 'arc_session_not_authorized'
            : !destinationReady
              ? 'destination_session_not_authorized'
              : null,
    },
  }
}
