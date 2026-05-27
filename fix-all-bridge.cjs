const fs = require('fs');
let s = fs.readFileSync('server.mjs', 'utf-8');

// 1. Tambah endpoint get-attestation sebelum app.listen
s = s.replace(
  "app.listen(PORT",
  `// ── Get Attestation ──
app.post('/api/get-attestation', async (req, res) => {
  try {
    const { txHash, fromChain } = req.body
    if (!txHash || !fromChain) return res.status(400).json({ error: 'Missing params' })
    const domains = { Arc_Testnet:26, Ethereum_Sepolia:0, Base_Sepolia:6, Arbitrum_Sepolia:3, Solana_Devnet:1 }
    const domain = domains[fromChain]
    if (domain === undefined) return res.status(400).json({ error: 'Unknown chain: ' + fromChain })
    console.log('[get-attestation] polling domain', domain, 'tx', txHash)
    const att = await pollAttestation(domain, txHash)
    if (!att) return res.status(400).json({ error: 'Attestation timeout. Tunggu 1-2 menit lalu coba lagi.' })
    res.json({ success: true, attestation: att.attestation, message: att.message, domain })
  } catch(e) { console.error('[get-attestation]', e.message); res.status(500).json({ error: e.message }) }
})

app.listen(PORT`
);

fs.writeFileSync('server.mjs', s);
console.log('get-attestation endpoint added');
