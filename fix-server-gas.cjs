const fs = require('fs');
let s = fs.readFileSync('server.mjs', 'utf-8');

// Fix writeContract - tambah gas config per chain
s = s.replace(
  `    const txHash = await wc.writeContract({
      address: dst.messageTransmitter,
      abi: [{ type:'function', name:'receiveMessage', inputs:[{name:'message',type:'bytes'},{name:'attestation',type:'bytes'}], outputs:[{name:'success',type:'bool'}], stateMutability:'nonpayable' }],
      functionName: 'receiveMessage',
      args: [att.message, att.attestation],
    })`,
  `    // Gas config per chain
    const gasConfig = toChain === 'Arbitrum_Sepolia'
      ? { maxFeePerGas: 200000000n, maxPriorityFeePerGas: 100000000n }
      : {}
    const txHash = await wc.writeContract({
      address: dst.messageTransmitter,
      abi: [{ type:'function', name:'receiveMessage', inputs:[{name:'message',type:'bytes'},{name:'attestation',type:'bytes'}], outputs:[{name:'success',type:'bool'}], stateMutability:'nonpayable' }],
      functionName: 'receiveMessage',
      args: [att.message, att.attestation],
      ...gasConfig,
    })`
);

fs.writeFileSync('server.mjs', s);
console.log('Gas config fixed');
