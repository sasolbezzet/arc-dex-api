const HASH_RE = /^0x[0-9a-f]{64}$/i
const ADDRESS_RE = /^0x[0-9a-f]{40}$/i

function stringValue(value) {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

function nestedObjects(payload) {
  const result = []
  const queue = [payload]
  const seen = new Set()
  while (queue.length && result.length < 32) {
    const current = queue.shift()
    if (!current || typeof current !== 'object' || seen.has(current)) continue
    seen.add(current)
    result.push(current)
    for (const key of ['notification', 'data', 'transaction', 'userOperation', 'wallet', 'source', 'destination']) {
      if (current[key] && typeof current[key] === 'object') queue.push(current[key])
    }
  }
  return result
}

function firstHash(objects, keys) {
  for (const object of objects) {
    for (const key of keys) {
      const value = stringValue(object?.[key]).trim()
      if (HASH_RE.test(value)) return value
    }
  }
  return null
}

function firstAddress(objects, keys) {
  for (const object of objects) {
    for (const key of keys) {
      const value = stringValue(object?.[key]).trim()
      if (ADDRESS_RE.test(value)) return value
    }
  }
  return null
}

function firstStatus(objects) {
  for (const object of objects) {
    for (const key of ['status', 'state', 'transactionStatus', 'userOperationStatus']) {
      const value = stringValue(object?.[key]).trim().toLowerCase()
      if (value) return value
    }
  }
  return ''
}

export function circleWalletEventType(payload = {}) {
  return stringValue(payload.notificationType || payload.type || payload.eventType || payload.event || '').trim()
}

export function circleWalletNotificationId(payload = {}) {
  return stringValue(payload.notificationId || payload.id || payload.eventId || payload.notification?.id || '').trim()
}

export function extractCircleWalletTransaction(payload = {}) {
  const objects = nestedObjects(payload)
  const userOpHash = firstHash(objects, ['userOperationHash', 'userOpHash', 'userOperationId', 'operationHash'])
  const txHash = firstHash(objects, ['transactionHash', 'txHash', 'hash', 'onChainTransactionHash'])
  const walletAddress = firstAddress(objects, ['walletAddress', 'address', 'fromAddress', 'sender', 'ownerAddress', 'destinationAddress'])
  return {
    eventType: circleWalletEventType(payload),
    notificationId: circleWalletNotificationId(payload),
    userOpHash,
    txHash,
    walletAddress,
    status: firstStatus(objects),
  }
}

export function isFinalCircleWalletStatus(status) {
  return ['complete', 'completed', 'confirmed', 'success', 'succeeded', 'failed', 'reverted', 'denied', 'rejected', 'cancelled', 'canceled', 'error'].includes(String(status || '').toLowerCase())
}

export function isSuccessfulCircleWalletStatus(status) {
  return ['complete', 'completed', 'confirmed', 'success', 'succeeded'].includes(String(status || '').toLowerCase())
}

export function isFailedCircleWalletStatus(status) {
  return ['failed', 'reverted', 'denied', 'rejected', 'cancelled', 'canceled', 'error'].includes(String(status || '').toLowerCase())
}
