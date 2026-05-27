const fs = require('fs');
let s = fs.readFileSync('server.mjs', 'utf-8');

// Ganti endpoint mint-cctp-solana dengan versi yang benar
const oldEndpoint = s.slice(
  s.indexOf("// ── Mint CCTP Solana ──"),
  s.indexOf("// ── Send ──")
);

const newEndpoint = `// ── Get Attestation (generic) ──
app.post('/api/get-attestation', async (req, res) => {
  try {
    const { txHash, fromChain } = req.body
    if (!txHash || !fromChain) return res.status(400).json({ error: 'Missing params' })
    const domains = { Arc_Testnet: 26, Ethereum_Sepolia: 0, Base_Sepolia: 6, Arbitrum_Sepolia: 3, Solana_Devnet: 1 }
    const domain = domains[fromChain]
    if (domain === undefined) return res.status(400).json({ error: 'Unknown chain' })
    const att = await pollAttestation(domain, txHash)
    if (!att) return res.status(400).json({ error: 'Attestation timeout' })
    res.json({ success: true, attestation: att.attestation, message: att.message, domain })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── Mint CCTP Solana (Arc → Solana) ──
// Frontend Solflare yang sign, backend hanya return attestation + instruksi
app.post('/api/mint-cctp-solana', async (req, res) => {
  try {
    const { burnTxHash, toAddress } = req.body
    if (!burnTxHash || !toAddress) return res.status(400).json({ error: 'Missing params: burnTxHash, toAddress' })

    // Poll attestation dari Arc Testnet (domain 26)
    const att = await pollAttestation(26, burnTxHash)
    if (!att) return res.status(400).json({ error: 'Attestation timeout. Coba lagi 1-2 menit.' })

    console.log('[mint-cctp-solana] attestation OK')

    // Return attestation data untuk frontend Solflare sign
    res.json({
      success: true,
      requiresSolanaSign: true,
      attestation: att.attestation,
      message: att.message,
      toAddress,
      solanaConfig: {
        messageTransmitter: SOLANA_CCTP.messageTransmitter,
        usdcMint: SOLANA_CCTP.usdcMint,
        rpc: SOLANA_CCTP.rpc,
      },
      explorerBase: 'https://explorer.solana.com/tx/',
      note: 'Use attestation to call receiveMessage via Solflare',
    })
  } catch(e) { console.error('[mint-cctp-solana]', e.message); res.status(500).json({ error: e.message }) }
})

// ── Mint CCTP dari Solana ke Arc (Solana → Arc) ──
// Setelah user burn di Solana via Solflare, backend mint di Arc
app.post('/api/mint-cctp-from-solana', async (req, res) => {
  try {
    const { burnTxHash, toAddress } = req.body
    if (!burnTxHash || !toAddress) return res.status(400).json({ error: 'Missing params' })

    // Poll attestation dari Solana (domain 1)
    const att = await pollAttestation(SOLANA_CCTP.domain, burnTxHash)
    if (!att) return res.status(400).json({ error: 'Attestation timeout. Coba lagi 1-2 menit.' })

    console.log('[mint-from-solana] attestation OK, minting di Arc Testnet')

    // Mint di Arc Testnet
    const dst = CCTP.Arc_Testnet
    const account = privateKeyToAccount(process.env.OWNER_PRIVATE_KEY)
    const wc = createWalletClient({ account, chain: arcTestnet, transport: http() })
    const pc = createPublicClient({ chain: arcTestnet, transport: http() })

    const txHash = await wc.writeContract({
      address: dst.messageTransmitter,
      abi: [{ type:'function', name:'receiveMessage', inputs:[{name:'message',type:'bytes'},{name:'attestation',type:'bytes'}], outputs:[{name:'success',type:'bool'}], stateMutability:'nonpayable' }],
      functionName: 'receiveMessage',
      args: [att.message, att.attestation],
    })
    await pc.waitForTransactionReceipt({ hash: txHash })
    console.log('[mint-from-solana] success:', txHash)
    res.json({ success: true, txHash, explorerUrl: dst.explorer + txHash })
  } catch(e) { console.error('[mint-from-solana]', e.message); res.status(500).json({ error: e.message }) }
})

// ── Send ──`;

s = s.replace(oldEndpoint, newEndpoint);
fs.writeFileSync('server.mjs', s);
console.log('Server fixed');
