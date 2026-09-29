import { getAddress, isAddress } from 'viem'
import { circleNotificationFamily, circleNotificationSubjectId, isNegativeCircleNotification } from './circleWalletWebhookService.mjs'
import { notifyWebhookFailure } from './webhookAlertNotifier.mjs'

/**
 * Aksi nyata saat event Circle bernilai negatif (KYC ditolak, challenge gagal,
 * transfer reverted):
 *
 * 1. Catat alert yang terikat owner di vault (tahan restart, bisa
 *    di-acknowledge dari UI) supaya wallet tidak terlihat "aman-aman saja".
 * 2. Tulis `webhook_failure` ke log aktivitas owner.
 * 3. Kirim notifikasi eksternal (Telegram / WEBHOOK_ALERT_URL) secara
 *    best-effort.
 *
 * Batas tegas: helper ini TIDAK memindahkan dana dan TIDAK membatalkan approval.
 * Rekonsiliasi approval tetap hanya lewat hash tx/userOp yang cocok.
 */
export async function handleCircleNotificationOutcome(normalized = {}, options = {}) {
  const { simulated = false, record = true, notify = true } = options
  const eventType = String(normalized.eventType || '')
  const status = normalized.status || null
  if (!isNegativeCircleNotification(eventType, status)) return null

  const wallet = String(normalized.walletAddress || '')
  const owner = isAddress(wallet) ? getAddress(wallet).toLowerCase() : ''
  const alert = {
    family: normalized.family || circleNotificationFamily(eventType),
    eventType,
    status,
    subjectId: circleNotificationSubjectId(eventType, normalized) || null,
    walletAddress: owner || null,
    createdAt: new Date().toISOString(),
    simulated,
  }

  let stored = null
  if (record && owner) {
    try {
      const { recordWebhookFailure, logActivity } = await import('./vaultStore.mjs')
      stored = recordWebhookFailure(owner, {
        ...alert,
        message: `Circle ${eventType} melaporkan ${status || 'hasil negatif'}`,
      })
      logActivity(owner, 'webhook_failure', { eventType, family: alert.family, subjectId: alert.subjectId, status, simulated })
    } catch (error) {
      console.error('[webhook:alert]', error.message)
    }
  }
  if (notify) notifyWebhookFailure(alert).catch(() => {})
  return stored
}
