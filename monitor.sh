#!/usr/bin/env bash
set -o pipefail

URL="https://43.134.14.43.nip.io/health"
LOG_DIR="/home/ubuntu/arc-dex-api/logs"
LOG_FILE="$LOG_DIR/monitor.log"
STATE_DIR="$LOG_DIR"
LAST_ALERT_FILE="$STATE_DIR/monitor.last-alert"
FAIL_COUNT_FILE="$STATE_DIR/monitor.fail-count"
MAX_LOG_LINES=1000
RESTART_THRESHOLD=3
ALERT_COOLDOWN_SECONDS=3600

mkdir -p "$LOG_DIR"

ALERT_TELEGRAM_BOT_TOKEN=""
ALERT_TELEGRAM_CHAT_ID=""
ALERT_WEBHOOK_URL=""

if [ -f /home/ubuntu/arc-dex-api/.monitor.env ]; then
  source /home/ubuntu/arc-dex-api/.monitor.env
fi

CURL_OUTPUT=$(curl -sS --max-time 10 -w "\n%{http_code}" "$URL" 2>&1)
CURL_EXIT=$?

NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

if [ "$CURL_EXIT" -eq 0 ]; then
  HTTP_CODE=$(echo "$CURL_OUTPUT" | tail -n1)
  RESPONSE=$(echo "$CURL_OUTPUT" | sed '$d')
else
  HTTP_CODE=""
  RESPONSE=""
fi

send_alert() {
  local message="$1"
  if [ -n "$ALERT_TELEGRAM_BOT_TOKEN" ] && [ -n "$ALERT_TELEGRAM_CHAT_ID" ]; then
    {
      curl -sS -X POST "https://api.telegram.org/bot$ALERT_TELEGRAM_BOT_TOKEN/sendMessage" \
        -d "chat_id=$ALERT_TELEGRAM_CHAT_ID" \
        --data-urlencode "text=$message" >/dev/null 2>&1
    } &
  fi
  if [ -n "$ALERT_WEBHOOK_URL" ]; then
    {
      local json_message
      json_message=$(printf '%s' "$message" | sed 's/"/\\"/g')
      curl -sS -X POST -H "Content-Type: application/json" \
        -d "{\"text\":\"$json_message\"}" "$ALERT_WEBHOOK_URL" >/dev/null 2>&1
    } &
  fi
}

is_healthy() {
  [ "$CURL_EXIT" -eq 0 ] && [ "$HTTP_CODE" = "200" ] && [[ "$RESPONSE" == *"\"ok\":true"* ]]
}

FAIL_COUNT=0
if [ -f "$FAIL_COUNT_FILE" ]; then
  FAIL_COUNT=$(cat "$FAIL_COUNT_FILE" 2>/dev/null || echo 0)
fi

if is_healthy; then
  echo "[$NOW] OK: $RESPONSE" >> "$LOG_FILE"
  if [ "$FAIL_COUNT" -gt 0 ]; then
    send_alert "arc-dex-api is back UP after $FAIL_COUNT failed checks."
    rm -f "$FAIL_COUNT_FILE" "$LAST_ALERT_FILE"
  fi
  exit 0
fi

FAIL_COUNT=$((FAIL_COUNT + 1))
echo "$FAIL_COUNT" > "$FAIL_COUNT_FILE"
echo "[$NOW] FAIL: curl_exit=$CURL_EXIT http_code=${HTTP_CODE:-N/A} response=${RESPONSE:0:200}" >> "$LOG_FILE"

LAST_ALERT=0
if [ -f "$LAST_ALERT_FILE" ]; then
  LAST_ALERT=$(cat "$LAST_ALERT_FILE" 2>/dev/null || echo 0)
fi
NOW_EPOCH=$(date +%s)
if [ $((NOW_EPOCH - LAST_ALERT)) -ge "$ALERT_COOLDOWN_SECONDS" ]; then
  send_alert "arc-dex-api appears DOWN: $URL (curl_exit=$CURL_EXIT http_code=${HTTP_CODE:-N/A}, consecutive_failures=$FAIL_COUNT)"
  echo "$NOW_EPOCH" > "$LAST_ALERT_FILE"
fi

if [ "$FAIL_COUNT" -ge "$RESTART_THRESHOLD" ]; then
  if command -v systemctl >/dev/null 2>&1; then
    sudo systemctl restart arc-dex-api >/dev/null 2>&1 || true
  fi
fi

if [ -f "$LOG_FILE" ]; then
  LINES=$(wc -l < "$LOG_FILE" 2>/dev/null || echo 0)
  if [ "$LINES" -gt "$MAX_LOG_LINES" ]; then
    tail -n "$MAX_LOG_LINES" "$LOG_FILE" > "$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
  fi
fi
