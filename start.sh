#!/usr/bin/env bash
# Pisan Lig köprüsü — tek komutla kurulum ve çalıştırma:
#   curl -fsSL https://raw.githubusercontent.com/pisanadam/pisan-relay/main/start.sh | bash -s -- <ANAHTAR> [PORT]
# ANAHTAR: Minecraft eklentisinin config.yml dosyasındaki web-relay-key ile aynı olmalı.
# PORT verilmezse server.properties içindeki server-port kullanılır (server.pro gibi panellerde otomatik).
set -euo pipefail
REPO="https://raw.githubusercontent.com/pisanadam/pisan-relay/main"
KEY="${1:-${RELAY_KEY:-}}"
PORT="${2:-}"
if [ -n "$KEY" ]; then printf '%s\n' "$KEY" > pisan-relay-key.txt; fi
if [ ! -s pisan-relay-key.txt ]; then
  echo "Anahtar yok. Kullanım: curl -fsSL $REPO/start.sh | bash -s -- <ANAHTAR> [PORT]" >&2
  exit 1
fi
chmod 600 pisan-relay-key.txt
echo "Köprü indiriliyor…"
curl -fsSL "$REPO/PisanRelay.jar" -o PisanRelay.jar.new && mv PisanRelay.jar.new PisanRelay.jar
if ! command -v java >/dev/null 2>&1; then
  echo "Java bulunamadı. Sunucuda Java 11 veya üstü olmalı." >&2
  exit 1
fi
echo "Köprü başlıyor (durdurmak için Ctrl+C)…"
if [ -n "$PORT" ]; then
  exec java -jar PisanRelay.jar "$PORT" "$(cat pisan-relay-key.txt)"
else
  exec java -jar PisanRelay.jar
fi
