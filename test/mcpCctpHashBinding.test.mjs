import test from 'node:test'
import assert from 'node:assert/strict'

const MSCA = '0x2222222222222222222222222222222222222222'
const ROUTE = {
  source: {
    tokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
    router: '0xDf800310443BEB589CEf91A09854203Ea36e43a7',
    usdc: '0x3600000000000000000000000000000000000000',
  },
  destination: { tokenMessenger: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA' },
}

function messageFor(recipient) {
  const word = value => String(value).replace(/^0x/i, '').padStart(64, '0')
  const uint32 = value => String(value).replace(/^0x/i, '').padStart(8, '0')
  const header = [
    uint32('0x1'), uint32('0x1a'), uint32('0x6'), word('1'),
    word(ROUTE.source.tokenMessenger), word(ROUTE.destination.tokenMessenger), word('0'), uint32('1000'), uint32('1000'),
  ].join('')
  const body = [
    uint32('1'), word(ROUTE.source.usdc), word(recipient), word('0x0f4240'),
    word(ROUTE.source.router), word('0x0a'), word('0x0a'), word('0'),
  ].join('')
  return '0x' + header + body
}

test('bridge status fetches and binds the requested burnTxHash', async () => {
  const { getCctpBridgeStatus } = await import('../src/services/mcpServer.mjs?cctp-hash-' + Date.now() + '-' + Math.random())
  const previousFetch = globalThis.fetch
  const requested = []
  globalThis.fetch = async url => {
    requested.push(String(url))
    const burnHash = new URL(url).searchParams.get('transactionHash')
    const recipient = burnHash === '0x' + 'a'.repeat(64) ? MSCA : '0x3333333333333333333333333333333333333333'
    return new Response(JSON.stringify({ messages: [{ message: messageFor(recipient), attestation: '0xattestation', status: 'complete' }] }), { status: 200 })
  }
  try {
    const first = await getCctpBridgeStatus({ burnTxHash: '0x' + 'a'.repeat(64), sourceDomain: 26, destinationDomain: 6, walletAddress: MSCA, route: ROUTE, expectedBurnAmount: 1_000_000n })
    const second = await getCctpBridgeStatus({ burnTxHash: '0x' + 'b'.repeat(64), sourceDomain: 26, destinationDomain: 6, walletAddress: MSCA, route: ROUTE, expectedBurnAmount: 1_000_000n })
    assert.equal(first.status, 'attestation_ready')
    assert.equal(first.messageBody.mintRecipient, MSCA)
    assert.equal(second.status, 'rejected')
    assert.equal(second.reason, 'cctp_message_route_unverified')
    assert.equal(requested.length, 2)
    assert.match(requested[0], /transactionHash=0x[a]+$/)
    assert.match(requested[1], /transactionHash=0x[b]+$/)
  } finally {
    globalThis.fetch = previousFetch
  }
})
