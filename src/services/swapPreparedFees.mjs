// Bentuk `fees` pada respons `/v1/stablecoinKits/swap` TIDAK dijamin array:
// skema transaksi Circle hanya menjamin `signature` + `executionParams`,
// sedangkan `fees` sebagai array adalah skema response estimate. Di produksi
// respons swap mengirim objek berkunci tipe fee:
//
//   { provider: [{ amount, token, decimals, … }],
//     swap: [],
//     developer: [{ amount, basis: 'inputAmount', … }] }
//
// Prepare pernah 500 (`(leg.fees || []).find is not a function`) karena kode
// memanggil `.find` pada objek itu. Helper ini membaca amount fee developer
// (base units) hanya ketika bentuknya benar, dan mengembalikan null supaya
// pemanggil memakai split lokal — bukan menebak atau melempar.

/**
 * Amount fee developer (base units) dari satu leg prepare swap Circle.
 *
 * @param {{ fees?: unknown }} leg leg hasil prepare Stablecoin Service.
 * @returns {string|null} base units sebagai string desimal, atau null kalau
 *   tidak ada fee developer yang dilaporkan.
 */
export function developerFeeBaseUnits(leg) {
  const fees = leg?.fees
  if (!fees || typeof fees !== 'object') return null
  // Shape utama: objek berkunci tipe fee. Shape cadangan: array entri fee.
  const entries = Array.isArray(fees) ? fees : Array.isArray(fees.developer) ? fees.developer : []
  const developerFee = entries.find(fee => fee && typeof fee === 'object' && String(fee.type || 'developer') === 'developer')
  const amount = developerFee?.amount
  if (typeof amount !== 'string' || !/^\d+$/.test(amount)) return null
  return amount
}
