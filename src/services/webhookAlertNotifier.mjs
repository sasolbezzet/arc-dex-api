// Notifikasi eksternal saat event webhook Circle gagal.
//
// Tujuan: kegagalan (KYC ditolak, challenge gagal, transfer reverted) sampai ke
// operator tanpa harus membuka halaman Info. Semua bersifat best-effort:
//
// - Tidak pernah melempar error — jalur webhook harus tetap balas 200.
// - Tidak pernah menulis kredensial ke log.
// - Di-throttle per (family, subject) supaya retry Circle tidak membanjiri chat.
//
// Target dibaca dari environment:
//   TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID  → kirim pesan Telegram
//   WEBHOOK_ALERT_URL                      → POST JSON generik (Slack/Discord/n8n)
// Tidak ada target yang dikonfigurasi ⇒ notifier no-op.

const THROTTLE_WINDOW_MS = 10 * 60 * 1000
const REQUEST_TIMEOUT_MS = 8_000
const sent = new Map() // dedupeKey -> timestamp kirim terakhir

/** Reset throttle in-memory (dipakai test). */
export function resetWebhookAlertThrottle() {
  sent.clear()
}

export function webhookAlertDedupeKey(alert = {}) {
  return `${alert.family || 'unknown'}:${alert.subjectId || alert.eventType || 'unknown'}`
}

export function shouldThrottleWebhookAlert(key, now = Date.now(), windowMs = THROTTLE_WINDOW_MS) {
  const last = sent.get(key)
  if (last !== undefined && now - last < windowMs) return true
  sent.set(key, now)
  return false
}

export function buildWebhookFailureMessage(alert = {}) {
  return [
    '⚠️ ARCOX webhook failure',
    `Event   : ${alert.eventType || 'unknown'}`,
    `Family  : ${alert.family || 'unknown'}`,
    `Status  : ${alert.status || 'unknown'}`,
    `Subject : ${alert.subjectId || '-'}`,
    `Wallet  : ${alert.walletAddress || '-'}`,
    `Time    : ${alert.createdAt || new Date().toISOString()}`,
    ...(alert.simulated ? ['Note    : simulated event'] : []),
  ].join('\n')
}

/** Target notifikasi yang aktif untuk environment ini. */
export function resolveWebhookAlertTargets(env = process.env) {
  const targets = []
  const token = String(env.TELEGRAM_BOT_TOKEN || '').trim()
  const chatId = String(env.TELEGRAM_CHAT_ID || '').trim()
  if (token && chatId) {
    targets.push({ kind: 'telegram', url: `https://api.telegram.org/bot${token}/sendMessage`, chatId })
  }
  const generic = String(env.WEBHOOK_ALERT_URL || '').trim()
  if (generic) targets.push({ kind: 'webhook', url: generic })
  return targets
}

/**
 * Kirim ringkasan kegagalan. Selalu resolve; `sent` menyatakan berapa target
 * yang menerima 2xx.
 */
export async function notifyWebhookFailure(alert = {}, options = {}) {
  const env = options.env || process.env
  const fetchImpl = options.fetchImpl || globalThis.fetch
  const now = options.now ?? Date.now()
  const windowMs = options.windowMs ?? THROTTLE_WINDOW_MS
  const dedupeKey = webhookAlertDedupeKey(alert)

  if (shouldThrottleWebhookAlert(dedupeKey, now, windowMs)) return { sent: 0, skipped: 'throttled', dedupeKey }
  const targets = resolveWebhookAlertTargets(env)
  if (!targets.length) return { sent: 0, skipped: 'not_configured', dedupeKey }

  const text = buildWebhookFailureMessage(alert)
  let count = 0
  for (const target of targets) {
    try {
      const response = await fetchImpl(target.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(target.kind === 'telegram' ? { chat_id: target.chatId, text, disable_web_page_preview: true } : { text, alert }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (response?.ok) count += 1
    } catch {
      // Best-effort: kegagalan notifikasi tidak boleh memengaruhi pemrosesan webhook.
    }
  }
  return { sent: count, skipped: count ? null : 'delivery_failed', dedupeKey }
}
