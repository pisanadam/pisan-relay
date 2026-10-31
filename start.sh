#!/usr/bin/env bash
# Pisan Lig köprüsü — tek komutla kurulum ve çalıştırma:
#   curl -fsSL https://raw.githubusercontent.com/pisanadam/pisan-relay/main/start.sh | bash -s -- <ANAHTAR> [PORT]
# ANAHTAR: Minecraft eklentisinin config.yml dosyasındaki web-relay-key ile aynı olmalı
#          (verilmezse yandaki pisan-relay-key.txt okunur).
# PORT:    verilmezse server.properties içindeki server-port, o da yoksa 25565.
# Köprü arka planda çalışır (shell kapansa da durmaz); kayıtlar relay.log dosyasında.
# Durdurmak için: kill "$(cat relay.pid)"
set -euo pipefail
REPO="https://raw.githubusercontent.com/pisanadam/pisan-relay/main"
DIR="${PISAN_RELAY_DIR:-$HOME/pisan-relay}"
mkdir -p "$DIR"
cd "$DIR"
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

# Java: the system's if there is one (11+), otherwise a portable Temurin 17 JRE in ./jre (nothing installed system-wide).
JAVA=""
if command -v java >/dev/null 2>&1; then
  v=$(java -version 2>&1 | head -1 | sed -E 's/.*"([0-9]+)(\.([0-9]+))?.*/\1/')
  if [ "${v:-0}" = "1" ] || [ "${v:-0}" -lt 11 ] 2>/dev/null; then JAVA=""; else JAVA="java"; fi
fi
if [ -z "$JAVA" ] && [ -x jre/bin/java ]; then JAVA="$DIR/jre/bin/java"; fi
if [ -z "$JAVA" ]; then
  case "$(uname -m)" in
    x86_64|amd64) ARCH=x64 ;;
    aarch64|arm64) ARCH=aarch64 ;;
    *) echo "Desteklenmeyen işlemci: $(uname -m). Java 11+ kurup tekrar dene." >&2; exit 1 ;;
  esac
  echo "Java yok; taşınabilir Java 17 indiriliyor (yaklaşık 45 MB, bir kere)…"
  curl -fsSL "https://api.adoptium.net/v3/binary/latest/17/ga/linux/$ARCH/jre/hotspot/normal/eclipse" -o jre.tar.gz
  rm -rf jre jre.tmp
  mkdir jre.tmp
  tar -xzf jre.tar.gz -C jre.tmp
  mv jre.tmp/* jre
  rm -rf jre.tmp jre.tar.gz
  JAVA="$DIR/jre/bin/java"
  if [ ! -x "$JAVA" ]; then echo "Java indirilemedi." >&2; exit 1; fi
fi

if [ -f relay.pid ] && kill -0 "$(cat relay.pid)" 2>/dev/null; then
  echo "Eski köprü durduruluyor…"
  kill "$(cat relay.pid)" || true
  sleep 1
fi
if [ -z "$PORT" ] && [ ! -f server.properties ]; then PORT=25565; fi
if [ -n "$PORT" ]; then
  nohup "$JAVA" -jar PisanRelay.jar "$PORT" "$(cat pisan-relay-key.txt)" > relay.log 2>&1 < /dev/null &
else
  nohup "$JAVA" -jar PisanRelay.jar > relay.log 2>&1 < /dev/null &
fi
echo $! > relay.pid
sleep 2
cat relay.log
if ! kill -0 "$(cat relay.pid)" 2>/dev/null; then
  echo "Köprü başlatılamadı (yukarıdaki kayda bak)." >&2
  exit 1
fi
IP=$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')
echo
echo "Köprü arka planda çalışıyor (pid $(cat relay.pid)). Kayıtlar: $DIR/relay.log"
echo "Sunucu IP: ${IP:-?}   Port: ${PORT:-server.properties}"
echo "Durdurmak için: kill \$(cat $DIR/relay.pid)"
