export const AUTO_MINT_MAX_ATTEMPTS = 200
export const AUTO_MINT_RETRY_BASE_DELAY_MS = 60_000
export const AUTO_MINT_RETRY_MAX_DELAY_MS = 15 * 60_000

export function markAutoMintRetryable(job, now = Date.now()) {
  const retryCount = Number(job?.retryCount || 0) + 1
  const delay = Math.min(
    AUTO_MINT_RETRY_MAX_DELAY_MS,
    AUTO_MINT_RETRY_BASE_DELAY_MS * (2 ** Math.min(retryCount - 1, 4)),
  )
  return {
    ...(job || {}),
    status: 'retryable',
    retryable: true,
    retryCount,
    nextRetryAt: now + delay,
    lastAttemptAt: now,
    error: `Attestation masih pending setelah ${AUTO_MINT_MAX_ATTEMPTS} polling attempts; retry aman tanpa burn baru.`,
  }
}

export function autoMintRetryDue(job, now = Date.now()) {
  return job?.status === 'retryable' && Number(job.nextRetryAt || 0) <= now
}

export function autoMintJobIsActive(job) {
  return job?.status === 'polling' || job?.status === 'ready'
}
