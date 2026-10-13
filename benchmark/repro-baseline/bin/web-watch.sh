#!/bin/bash
# Web watchdog: every 120s curl the dev web app; restart it when down.
# strictPort keeps double-starts harmless (second instance fails to bind and exits).
LOG=/tmp/web-watch.log
while true; do
  code=$(curl -s -m 8 -o /dev/null -w '%{http_code}' http://127.0.0.1:18888/ 2>/dev/null)
  if [ "$code" = "000" ]; then
    if ! pgrep -f 'vite dev --port 18888' >/dev/null 2>&1; then
      echo "$(date -u +%FT%TZ) web down (code=$code), restarting" >> "$LOG"
      setsid /tmp/web-start.sh >> /tmp/web-run.log 2>&1 &
      sleep 90
    fi
  fi
  sleep 120
done
