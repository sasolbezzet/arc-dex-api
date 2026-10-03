import test from 'node:test'
import assert from 'node:assert/strict'

import { developerFeeBaseUnits } from '../src/services/swapPreparedFees.mjs'

// Regresi produksi: `(leg.fees || []).find(...)` melempar 500 karena Circle
// mengirim `fees` sebagai objek, bukan array. Prepare harus tetap jalan dan
// jatuh ke split lokal ketika fee developer tidak bisa dibaca.
test('fees berbentuk objek (respons swap Circle nyata) tidak melempar dan mengembalikan amount developer', () => {
  const leg = {
    fees: {
      provider: [{ token: '0x3600', amount: '181', decimals: 6, chain: 'Arc', symbol: 'USDC' }],
      swap: [],
      developer: [{ token: '0x3600', amount: '47500', basis: 'inputAmount', decimals: 6, chain: 'Arc', symbol: 'USDC' }],
    },
  }
  assert.equal(developerFeeBaseUnits(leg), '47500')
})

test('fees array masih didukung (skema estimate) termasuk entri ber-type developer', () => {
  assert.equal(developerFeeBaseUnits({ fees: [{ type: 'provider', amount: '10' }, { type: 'developer', amount: '50000' }] }), '50000')
})

test('bentuk fees yang tidak dikenal dikembalikan null supaya pemanggil memakai split lokal', () => {
  assert.equal(developerFeeBaseUnits({ fees: { developer: [] } }), null)
  assert.equal(developerFeeBaseUnits({ fees: [] }), null)
  assert.equal(developerFeeBaseUnits({ fees: 'n/a' }), null)
  assert.equal(developerFeeBaseUnits({}), null)
  assert.equal(developerFeeBaseUnits(null), null)
  assert.equal(developerFeeBaseUnits(undefined), null)
})

test('amount fee developer non-desimal ditolak agar BigInt pemanggil tidak melempar', () => {
  assert.equal(developerFeeBaseUnits({ fees: { developer: [{ amount: 50000 }] } }), null)
  assert.equal(developerFeeBaseUnits({ fees: { developer: [{ amount: null }] } }), null)
  assert.equal(developerFeeBaseUnits({ fees: { developer: [{ amount: '0x10' }] } }), null)
  assert.equal(developerFeeBaseUnits({ fees: { developer: [{ amount: '' }] } }), null)
})
