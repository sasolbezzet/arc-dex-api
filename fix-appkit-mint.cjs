const fs = require('fs');
let s = fs.readFileSync('server.mjs', 'utf-8');

// Ganti get-attestation + mint dengan App Kit bridge retry
s = s.replace(
  `// ── Get Attestation (dipakai frontend untuk user-sign mint) ──
app.post('/api/get-attestation', async (req, res) => {
  try {
    const { txHash, fromChain } = req.body
    if (!txHash || !fromChain) return res.status(400).json({ error: 'Missing params' })
    const domains = { Arc_Testnet: 26, Ethereum_Sepolia: 0, Base_Sepolia: 6, Arbitrum_Sepolia: 3, Solana_Devnet: 1 }
    const domain = domains[fromChain]
    if (domain === undefined) return res.status(400).json({ error: 'Unknown chain: ' + fromChain })
    console.log(\`[get-attestation] domain=\${domain} tx=\${txHash}\`)
    const att = await pollAttestation(domain, txHash)
    if (!att) return res.status(400).json({ error: 'Attestation timeout. Tunggu 1-2 menit lalu coba lagi.' })
    res.json({ success: true, attestation: att.attestation, message: att.message, domain })
  } catch(e) { console.error('[get-attestation]', e.message); res.status(500).json({ error: e.message }) }
})`,
  `// ── Get Attestation - fast via App Kit ──
app.post('/api/get-attestation', async (req, res) => {
  try {
    const { txHash, fromChain } = req.body
    if (!txHash || !fromChain) return res.status(400).json({ error: 'Missing params' })
    const domains = { Arc_Testnet: 26, Ethereum_Sepolia: 0, Base_Sepolia: 6, Arbitrum_Sepolia: 3, Solana_Devnet: 1 }
    const domain = domains[fromChain]
    if (domain === undefined) return res.status(400).json({ error: 'Unknown chain: ' + fromChain })
    console.log(\`[get-attestation] domain=\${domain} tx=\${txHash}\`)
    // Fast attestation - poll dengan interval lebih pendek
    const att = await pollAttestation(domain, txHash, 60)
    if (!att) return res.status(400).json({ error: 'Attestation timeout.' })
    res.json({ success: true, attestation: att.attestation, message: att.message, domain })
  } catch(e) { console.error('[get-attestation]', e.message); res.status(500).json({ error: e.message }) }
})

// ── Mint via App Kit (EVM chains) - lebih reliable dari manual receiveMessage ──
app.post('/api/mint-via-appkit', async (req, res) => {
  try {
    const { burnTxHash, fromChain, toChain, toAddress } = req.body
    if (!burnTxHash || !fromChain || !toChain) return res.status(400).json({ error: 'Missing params' })

    const viemAdapter = createViemAdapterFromPrivateKey({ privateKey: process.env.OWNER_PRIVATE_KEY })
    
    // Reconstruct bridge result untuk retry
    const partialResult = {
      state: 'error',
      amount: '0',
      token: 'USDC',
      source: { 
        address: process.env.OWNER_PRIVATE_KEY ? (await import('viem/accounts')).then(m => m.privateKeyToAccount(process.env.OWNER_PRIVATE_KEY).address) : toAddress,
        chain: fromChain 
      },
      destination: { address: toAddress, chain: toChain },
      steps: [
        { name: 'approve', state: 'success' },
        { name: 'burn', state: 'success', txHash: burnTxHash },
        { name: 'fetchAttestation', state: 'error', error: 'Resuming from frontend burn' },
      ],
    }

    console.log(\`[mint-via-appkit] retrying from burn tx \${burnTxHash}\`)
    const retryResult = await kit.retry(partialResult, {
      from: viemAdapter,
      to: viemAdapter,
    })
    
    if (retryResult.state === 'success') {
      const mintStep = retryResult.steps?.find(s => s.name === 'mint')
      res.json({ success: true, txHash: mintStep?.txHash, explorerUrl: CCTP[toChain]?.explorer + mintStep?.txHash })
    } else {
      res.status(400).json({ error: 'Mint failed: ' + JSON.stringify(retryResult.steps?.find(s => s.state === 'error')?.error) })
    }
  } catch(e) { console.error('[mint-via-appkit]', e.message); res.status(500).json({ error: e.message }) }
})`
);

fs.writeFileSync('server.mjs', s);
console.log('App Kit mint endpoint added');
