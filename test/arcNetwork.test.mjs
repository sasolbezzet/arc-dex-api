import test from 'node:test'
import assert from 'node:assert/strict'

// arcNetwork.mjs is the single source of truth for the active Arc network.
// Its exported constants are resolved at module load, while its helpers read
// `process.env` at call time — so every case applies the env first, imports a
// fresh module instance (cache-busting query), and runs all assertions inside
// the applied-env window before restoring the previous values.

const ENV_NAMES = ['ARC_NETWORK', 'ARC_CHAIN_ID', 'CIRCLE_GATEWAY_BASE_URL', 'CIRCLE_API_KEY', 'CIRCLE_API_KEY_MAINNET', 'CIRCLE_CLIENT_KEY', 'CIRCLE_CLIENT_KEY_LIVE', 'ARCOX_FEE_ROUTER_ADDRESS', 'ARCOX_FEE_ROUTER_ADDRESS_MAINNET']

async function withRegistry(env, fn) {
  const previous = new Map(ENV_NAMES.map(name => [name, process.env[name]]))
  for (const name of ENV_NAMES) delete process.env[name]
  for (const [name, value] of Object.entries(env)) process.env[name] = value
  try {
    const arc = await import(`../src/config/arcNetwork.mjs?case=${Date.now()}-${Math.random()}`)
    return await fn(arc)
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

test('default network stays testnet without ARC_NETWORK', async () => {
  await withRegistry({}, (arc) => {
    assert.equal(arc.ARC_NETWORK_ID, 'testnet')
    assert.equal(arc.IS_ARC_MAINNET, false)
    assert.equal(arc.ARC_CHAIN_KEY, 'arc-testnet')
    assert.equal(arc.ARC_CHAIN_ID, 5042002)
    assert.equal(arc.ARC_CHAIN_ID_HEX, '0x4cef52')
    assert.equal(arc.ARC_CHAIN_NAME, 'Arc Testnet')
    assert.equal(arc.ARC_TRANSPORT_SLUG, 'arcTestnet')
    assert.equal(arc.ARC_CIRCLE_ENV, 'testnet')
    assert.equal(arc.ARC_EXPLORER_URL, 'https://testnet.arcscan.app')
    assert.equal(arc.ARC_USDC_ADDRESS, '0x3600000000000000000000000000000000000000')
  })
})

test('ARC_NETWORK=mainnet switches chain id, transport slug, explorer, and Gateway naming', async () => {
  await withRegistry({ ARC_NETWORK: 'mainnet' }, (arc) => {
    assert.equal(arc.ARC_NETWORK_ID, 'mainnet')
    assert.equal(arc.IS_ARC_MAINNET, true)
    assert.equal(arc.ARC_CHAIN_KEY, 'arc-mainnet')
    assert.equal(arc.ARC_CHAIN_ID, 5042)
    assert.equal(arc.ARC_CHAIN_ID_HEX, '0x13b2')
    assert.equal(arc.ARC_CHAIN_NAME, 'Arc Mainnet')
    assert.equal(arc.ARC_TRANSPORT_SLUG, 'arc')
    assert.equal(arc.ARC_CIRCLE_ENV, 'live')
    assert.equal(arc.ARC_EXPLORER_URL, 'https://explorer.arc.io')
    // Verified from GET https://gateway-api.circle.com/v1/info → chain "Arc".
    assert.equal(arc.ARC_GATEWAY_CHAIN_NAME, 'Arc')
    assert.equal(arc.ARC_GATEWAY_KEY, 'Arc')
    assert.equal(arc.ARC_GATEWAY_NETWORK_LABEL, 'Mainnet')
    assert.equal(arc.ARC_GATEWAY_WALLET, '0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE')
    assert.equal(arc.ARC_GATEWAY_MINTER, '0x2222222d7164433c4C09B0b0D809a9b52C04C205')
    assert.equal(arc.ARC_CCTP_DOMAIN, 26)
    assert.equal(arc.arcGatewayBaseUrl(), 'https://gateway-api.circle.com')
  })
})

test('ARC_CHAIN_ID=5042 alone is enough to select mainnet', async () => {
  await withRegistry({ ARC_CHAIN_ID: '5042' }, (arc) => {
    assert.equal(arc.ARC_NETWORK_ID, 'mainnet')
    assert.equal(arc.ARC_CHAIN_ID, 5042)
  })
})

test('Circle contracts and tokens follow the active network', async () => {
  await withRegistry({}, (arc) => {
    assert.equal(arc.arcCircleContract('tokenMessenger'), '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA')
    assert.equal(arc.arcTokenAddress('EURC'), '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a')
    assert.equal(arc.arcTokenAddress('cirBTC'), null)
  })
  await withRegistry({ ARC_NETWORK: 'mainnet' }, (arc) => {
    assert.equal(arc.arcCircleContract('tokenMessenger'), '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d')
    assert.equal(arc.arcCircleContract('messageTransmitter'), '0x81D40F21F12A8F0E3252Bccb954D722d4c464B64')
    assert.equal(arc.arcCircleContract('identityRegistry'), '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432')
    assert.equal(arc.arcTokenAddress('EURC'), '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1')
    assert.equal(arc.arcTokenAddress('USYC'), '0x8a5D989Bbb96929F689B0200f435f53dA42bF490')
  })
})

test('arcContractAddress never falls back to a testnet address on mainnet', async () => {
  await withRegistry({ ARCOX_FEE_ROUTER_ADDRESS: '0x1111111111111111111111111111111111111111' }, (arc) => {
    assert.equal(arc.arcContractAddress('ARCOX_FEE_ROUTER_ADDRESS'), '0x1111111111111111111111111111111111111111')
    assert.equal(arc.arcContractAddress('ARCOX_AMM_ROUTER'), null)
  })

  // Mainnet: a testnet env value is ignored, only `<NAME>_MAINNET` counts.
  await withRegistry({
    ARC_NETWORK: 'mainnet',
    ARCOX_FEE_ROUTER_ADDRESS: '0x1111111111111111111111111111111111111111',
  }, (arc) => {
    assert.equal(arc.arcContractAddress('ARCOX_FEE_ROUTER_ADDRESS'), null)
    assert.match(arc.arcContractMissingMessage('ARCOX_FEE_ROUTER_ADDRESS'), /belum di-deploy ke Arc mainnet/)
  })

  await withRegistry({
    ARC_NETWORK: 'mainnet',
    ARCOX_FEE_ROUTER_ADDRESS: '0x1111111111111111111111111111111111111111',
    ARCOX_FEE_ROUTER_ADDRESS_MAINNET: '0x2222222222222222222222222222222222222222',
  }, (arc) => {
    assert.equal(arc.arcContractAddress('ARCOX_FEE_ROUTER_ADDRESS'), '0x2222222222222222222222222222222222222222')
  })
})

test('Circle API and Client keys prefer the live values on mainnet', async () => {
  const bothKeys = { CIRCLE_API_KEY: 'sandbox-key', CIRCLE_API_KEY_MAINNET: 'live-key', CIRCLE_CLIENT_KEY: 'sandbox-client', CIRCLE_CLIENT_KEY_LIVE: 'live-client' }
  await withRegistry(bothKeys, (arc) => {
    assert.equal(arc.arcCircleApiKey(), 'sandbox-key')
    assert.equal(arc.arcCircleClientKey(), 'sandbox-client')
  })
  await withRegistry({ ...bothKeys, ARC_NETWORK: 'mainnet' }, (arc) => {
    assert.equal(arc.arcCircleApiKey(), 'live-key')
    assert.equal(arc.arcCircleClientKey(), 'live-client')
  })
  // No silent sandbox fallback: a missing live key resolves to empty.
  await withRegistry({ ARC_NETWORK: 'mainnet', CIRCLE_API_KEY: 'sandbox-key', CIRCLE_CLIENT_KEY: 'sandbox-client' }, (arc) => {
    assert.equal(arc.arcCircleApiKey(), '')
    assert.equal(arc.arcCircleClientKey(), '')
  })
})

test('Gateway chain list is testnet-wide on testnet and Arc-only on mainnet', async () => {
  await withRegistry({}, (arc) => {
    assert.deepEqual(arc.arcGatewayChains().map(item => item.chain), ['Arc_Testnet', 'Base_Sepolia', 'Ethereum_Sepolia', 'Arbitrum_Sepolia', 'Solana_Devnet'])
  })
  await withRegistry({ ARC_NETWORK: 'mainnet' }, (arc) => {
    assert.deepEqual(arc.arcGatewayChains(), [{ chain: 'Arc', domain: 26, ecosystem: 'evm' }])
  })
})

test('CIRCLE_GATEWAY_BASE_URL override wins on both networks', async () => {
  await withRegistry({ CIRCLE_GATEWAY_BASE_URL: 'https://gateway.example.test/' }, (arc) => {
    assert.equal(arc.arcGatewayBaseUrl(), 'https://gateway.example.test')
  })
  await withRegistry({ ARC_NETWORK: 'mainnet', CIRCLE_GATEWAY_BASE_URL: 'https://gateway.example.test/' }, (arc) => {
    assert.equal(arc.arcGatewayBaseUrl(), 'https://gateway.example.test')
  })
  await withRegistry({}, (arc) => {
    assert.equal(arc.arcGatewayBaseUrl(), 'https://gateway-api-testnet.circle.com')
  })
})

test('chain aliases normalise to the active Arc chain key', async () => {
  await withRegistry({}, (arc) => {
    for (const alias of ['arc', 'arc-testnet', 'arc_testnet', 'Arc_Testnet', 'ARC-TESTNET']) {
      assert.equal(arc.resolveArcChainKey(alias), 'arc-testnet')
    }
    assert.equal(arc.resolveArcChainKey(''), 'arc-testnet')
    assert.equal(arc.isArcChainKey('Arc_Testnet'), true)
    assert.equal(arc.isArcChainKey('base-sepolia'), false)
  })
  await withRegistry({ ARC_NETWORK: 'mainnet' }, (arc) => {
    assert.equal(arc.resolveArcChainKey('arc-testnet'), 'arc-mainnet')
    assert.equal(arc.resolveArcChainKey('Arc'), 'arc-mainnet')
    assert.equal(arc.resolveArcChainKey(''), 'arc-mainnet')
  })
})

test('MSCA chain support is Arc-only on mainnet', async () => {
  await withRegistry({}, (arc) => {
    assert.deepEqual(arc.arcNetwork().mscaChainKeys, ['arc-testnet', 'base-sepolia', 'arbitrum-sepolia'])
  })
  await withRegistry({ ARC_NETWORK: 'mainnet' }, (arc) => {
    assert.deepEqual(arc.arcNetwork().mscaChainKeys, ['arc-mainnet'])
  })
})
