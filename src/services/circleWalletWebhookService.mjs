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

// ── Circle notification catalog ──
// Canonical event list from Circle Docs (Create a notification subscription:
// developers.circle.com/api-reference/contracts/common/create-subscription) and
// the Arc Docs contracts.eventLog payload shape
// (docs.arc.io/arc/tutorials/monitor-contract-events). Keeping the list in one
// place lets the webhook route reject unroutable events and lets the GET probe
// publish exactly what an operator should subscribe to.
export const CIRCLE_NOTIFICATION_CATALOG = Object.freeze({
  transactions: Object.freeze(['transactions.inbound', 'transactions.outbound']),
  challenges: Object.freeze([
    'challenges.accelerateTransaction',
    'challenges.cancelTransaction',
    'challenges.changePin',
    'challenges.contractExecution',
    'challenges.createTransaction',
    'challenges.createWallet',
    'challenges.initialize',
    'challenges.restorePin',
    'challenges.setPin',
    'challenges.setSecurityQuestions',
  ]),
  contracts: Object.freeze(['contracts.eventLog']),
  modularWallet: Object.freeze(['modularWallet.userOperation', 'modularWallet.inboundTransfer', 'modularWallet.outboundTransfer']),
  travelRule: Object.freeze(['travelRule.statusUpdate', 'travelRule.deny', 'travelRule.approve']),
  rampSession: Object.freeze([
    'rampSession.completed',
    'rampSession.depositReceived',
    'rampSession.expired',
    'rampSession.failed',
    'rampSession.kycApproved',
    'rampSession.kycRejected',
    'rampSession.kycSubmitted',
  ]),
})

// Every concrete notification type Circle accepts, in the order the docs list
// them. The route treats the bare family name (for example `challenges`) and the
// family wildcard (`challenges.*`) as aliases for "the whole category", because
// the Console groups the checkboxes that way.
export const CIRCLE_NOTIFICATION_TYPES = Object.freeze(
  Object.values(CIRCLE_NOTIFICATION_CATALOG).flat(),
)

// The subscription payload that receives every notification this endpoint can
// route. Circle expands each `<family>.*` wildcard server-side.
//
// `webhooks.test` is deliberately NOT part of this list: the LIVE
// `POST /v2/notifications/subscriptions` API rejects it with "API parameter
// invalid". The synthetic test event is instead triggered by the subscription's
// own `POST /v2/notifications/subscriptions/{id}/test` operation, so the route
// still accepts it (see `isSupportedCircleNotificationType`).
export const CIRCLE_SUBSCRIPTION_NOTIFICATION_TYPES = Object.freeze(
  Object.keys(CIRCLE_NOTIFICATION_CATALOG).map(family => `${family}.*`),
)

export function circleNotificationFamily(eventType = '') {
  const family = String(eventType || '').trim().split('.')[0]
  if (!family) return 'unknown'
  if (family === 'webhooks') return 'test'
  return Object.prototype.hasOwnProperty.call(CIRCLE_NOTIFICATION_CATALOG, family) ? family : 'unknown'
}

// Accepts the concrete types plus the wildcards and family aliases Circle's own
// subscription API accepts. `webhooks.test` is the synthetic probe Circle fires
// from the Console, so it is always routable.
export function isSupportedCircleNotificationType(eventType = '') {
  const type = String(eventType || '').trim()
  if (!type) return false
  if (type === '*' || type === 'webhooks.test') return true
  if (CIRCLE_NOTIFICATION_TYPES.includes(type)) return true
  const [family, ...rest] = type.split('.')
  if (!Object.prototype.hasOwnProperty.call(CIRCLE_NOTIFICATION_CATALOG, family)) return false
  const suffix = rest.join('.')
  return suffix === '*' || suffix === ''
}

function firstStringValue(objects, keys) {
  for (const object of objects) {
    for (const key of keys) {
      const value = stringValue(object?.[key]).trim()
      if (value) return value
    }
  }
  return null
}

function firstAmount(objects) {
  for (const object of objects) {
    if (Array.isArray(object?.amounts) && object.amounts.length) return String(object.amounts[0])
    const value = stringValue(object?.amount).trim()
    if (value) return value
  }
  return null
}

function notificationBody(payload = {}) {
  const candidate = payload?.notification && typeof payload.notification === 'object'
    ? payload.notification
    : payload?.data && typeof payload.data === 'object'
      ? payload.data
      : payload
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate : {}
}

function ids(objects, keys) {
  for (const object of objects) {
    for (const key of keys) {
      const value = stringValue(object?.[key]).trim()
      if (value) return value
    }
  }
  return null
}

/**
 * Normalize a Circle notification envelope into the fields ARCOX uses for
 * routing and reconciliation. The raw payload is always persisted alongside
 * this summary, so fields Circle adds later stay accessible.
 *
 * Envelope: { subscriptionId, notificationId, notificationType, notification, timestamp, version }
 */
export function normalizeCircleNotification(payload = {}) {
  const eventType = circleWalletEventType(payload)
  const notificationId = circleWalletNotificationId(payload)
  const notification = notificationBody(payload)
  const objects = nestedObjects(payload)
  const family = circleNotificationFamily(eventType)
  const subtype = eventType.split('.').slice(1).join('.')
  const hashes = extractCircleWalletTransaction(payload)
  const common = {
    eventType,
    notificationId,
    subscriptionId: firstStringValue(objects, ['subscriptionId']) || String(payload.subscriptionId || '') || null,
    family,
    subtype: subtype || null,
    status: firstStatus(objects) || null,
    blockchain: firstStringValue(objects, ['blockchain', 'network']) || null,
    txHash: hashes.txHash,
    userOpHash: hashes.userOpHash,
    walletAddress: hashes.walletAddress,
    amount: firstAmount(objects),
    token: firstStringValue(objects, ['token', 'tokenSymbol', 'currency']) || null,
    timestamp: firstStringValue([payload, notification], ['timestamp', 'createDate']) || null,
    version: payload.version === undefined || payload.version === null ? null : payload.version,
  }

  if (family === 'transactions') {
    return {
      ...common,
      walletId: ids(objects, ['walletId']),
      contractAddress: ids(objects, ['contractAddress']),
      sourceAddress: ids(objects, ['sourceAddress', 'fromAddress']),
      destinationAddress: ids(objects, ['destinationAddress', 'toAddress']),
      refId: ids(objects, ['refId', 'reference']),
      errorReason: ids(objects, ['errorReason', 'errorDetails']) || null,
      state: firstStringValue([notification], ['state', 'status']) || null,
    }
  }

  if (family === 'challenges') {
    return {
      ...common,
      challengeId: ids([notification, payload], ['id', 'challengeId']),
      walletId: ids(objects, ['walletId']),
      transactionId: ids(objects, ['transactionId']),
      challengeType: eventType,
    }
  }

  if (family === 'contracts') {
    return {
      ...common,
      contractAddress: ids(objects, ['contractAddress', 'address']),
      eventSignature: ids(objects, ['eventSignature']) || null,
      eventSignatureHash: ids(objects, ['eventSignatureHash']) || null,
      blockHash: ids(objects, ['blockHash']) || null,
      blockHeight: notification.blockHeight ?? null,
      logIndex: notification.logIndex === undefined ? null : notification.logIndex,
      topics: Array.isArray(notification.topics) ? notification.topics : null,
      data: typeof notification.data === 'string' ? notification.data : null,
      firstConfirmDate: firstStringValue([notification], ['firstConfirmDate']) || null,
    }
  }

  if (family === 'modularWallet') {
    return {
      ...common,
      walletId: ids(objects, ['walletId']),
      contractAddress: ids(objects, ['contractAddress']),
      sourceAddress: ids(objects, ['sourceAddress', 'fromAddress']),
      destinationAddress: ids(objects, ['destinationAddress', 'toAddress']),
    }
  }

  if (family === 'rampSession') {
    return {
      ...common,
      sessionId: ids(objects, ['sessionId', 'id', 'rampSessionId']),
      walletId: ids(objects, ['walletId']),
      kycStatus: ids(objects, ['kycStatus']) || null,
      depositAddress: ids(objects, ['depositAddress', 'address']),
      errorReason: ids(objects, ['errorReason', 'errorDetails']) || null,
    }
  }

  if (family === 'travelRule') {
    return {
      ...common,
      transferId: ids(objects, ['transferId', 'id']),
      walletId: ids(objects, ['walletId']),
    }
  }

  return { ...common, notification }
}

// Subtype yang menandakan hasil negatif. Dipakai supaya `rampSession.kycRejected`
// dan `challenges.*` yang gagal tetap terdeteksi walau payload-nya tidak memberi
// `status` eksplisit.
const NEGATIVE_NOTIFICATION_SUBTYPES = Object.freeze(['failed', 'expired', 'rejected', 'denied', 'kycRejected', 'cancelled', 'canceled', 'error', 'reverted'])
const POSITIVE_NOTIFICATION_SUBTYPES = Object.freeze(['completed', 'complete', 'confirmed', 'succeeded', 'success', 'approved', 'kycApproved', 'depositReceived'])

export function isNegativeCircleNotification(eventType = '', status = '') {
  const subtype = String(eventType || '').split('.').slice(1).join('.')
  if (subtype && NEGATIVE_NOTIFICATION_SUBTYPES.includes(subtype)) return true
  return isFailedCircleWalletStatus(status)
}

export function isPositiveCircleNotification(eventType = '', status = '') {
  const subtype = String(eventType || '').split('.').slice(1).join('.')
  if (subtype && POSITIVE_NOTIFICATION_SUBTYPES.includes(subtype)) return true
  return isSuccessfulCircleWalletStatus(status)
}

/** Id subjek yang bisa dilacak statusnya lintas event (challenge / ramp session). */
export function circleNotificationSubjectId(eventType = '', notification = {}) {
  const family = circleNotificationFamily(eventType)
  if (family === 'challenges') return notification?.challengeId ? String(notification.challengeId) : null
  if (family === 'rampSession') return notification?.sessionId ? String(notification.sessionId) : null
  return null
}

/**
 * Ringkas event webhook yang sudah tersimpan menjadi status TERKINI per challenge
 * dan ramp session, plus daftar kegagalan terbaru.
 *
 * Sengaja dihitung dari event yang sudah ada (bukan store baru) supaya tidak ada
 * state kedua yang bisa divergen dari inbox, dan aman dipanggil berkali-kali.
 */
export function summarizeCircleNotificationState(events = [], { failureLimit = 20 } = {}) {
  const latest = new Map()
  const occurrences = new Map()
  const failures = []

  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    const notification = event.notification && typeof event.notification === 'object' ? event.notification : {}
    const eventType = String(event.eventType || notification.eventType || '')
    const family = event.family || circleNotificationFamily(eventType)
    const status = String(event.status || notification.status || '').toLowerCase()
    const createdAt = event.createdAt || null
    const subjectId = circleNotificationSubjectId(eventType, notification)

    if (isNegativeCircleNotification(eventType, status)) {
      failures.push({ eventType, family, status: status || null, subjectId, createdAt })
    }
    if (!subjectId) continue

    const key = `${family}:${subjectId}`
    occurrences.set(key, (occurrences.get(key) || 0) + 1)
    const previous = latest.get(key)
    if (!previous || String(createdAt || '') >= String(previous.createdAt || '')) {
      latest.set(key, { family, subjectId, eventType, status, kycStatus: notification.kycStatus || null, walletId: notification.walletId || null, createdAt })
    }
  }

  const challenges = []
  const rampSessions = []
  for (const entry of latest.values()) {
    const key = `${entry.family}:${entry.subjectId}`
    const summary = {
      status: entry.status || null,
      failed: isNegativeCircleNotification(entry.eventType, entry.status),
      succeeded: isPositiveCircleNotification(entry.eventType, entry.status),
      lastEventType: entry.eventType,
      occurrences: occurrences.get(key) || 1,
      updatedAt: entry.createdAt,
    }
    if (entry.family === 'challenges') challenges.push({ challengeId: entry.subjectId, type: entry.eventType, ...summary })
    else if (entry.family === 'rampSession') rampSessions.push({ sessionId: entry.subjectId, kycStatus: entry.kycStatus, ...summary })
  }

  const byUpdatedAt = (a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
  challenges.sort(byUpdatedAt)
  rampSessions.sort(byUpdatedAt)
  failures.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))

  return { challenges, rampSessions, failures: failures.slice(0, failureLimit) }
}
