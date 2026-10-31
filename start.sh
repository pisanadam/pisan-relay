#!/usr/bin/env bash
# Pisan Lig köprüsü — tek komutla kurulum ve çalıştırma:
#   curl -fsSL https://raw.githubusercontent.com/pisanadam/pisan-relay/main/start.sh | bash -s -- <ANAHTAR> [PORT]
# ANAHTAR: Minecraft eklentisinin config.yml dosyasındaki web-relay-key ile aynı olmalı
#          (verilmezse kayıtlı pisan-relay-key.txt kullanılır).
# PORT:    verilmezse 25565.
# Köprü arka planda çalışır (shell kapansa da durmaz); kayıtlar relay.log dosyasında.
set -euo pipefail
REPO="https://github.com/pisanadam/pisan-relay/archive/refs/heads/main.tar.gz"
DIR="${PISAN_RELAY_DIR:-$HOME/pisan-relay}"
mkdir -p "$DIR"
cd "$DIR"
KEY="${1:-${RELAY_KEY:-}}"
PORT="${2:-25565}"
if [ -n "$KEY" ]; then printf '%s\n' "$KEY" > pisan-relay-key.txt; fi
if [ ! -s pisan-relay-key.txt ] && [ -s "$HOME/pisan-relay-key.txt" ]; then mv "$HOME/pisan-relay-key.txt" pisan-relay-key.txt; fi
if [ ! -s pisan-relay-key.txt ]; then
  echo "Anahtar yok. Kullanım: curl -fsSL https://raw.githubusercontent.com/pisanadam/pisan-relay/main/start.sh | bash -s -- <ANAHTAR>" >&2
  exit 1
fi
chmod 600 pisan-relay-key.txt

# Optional default texture pack for every player: PACK_URL=<zip link> before the command downloads it once
# (it stays as pack.zip in this folder across updates; delete pack.zip to go back to the bundled textures).
if [ -n "${PACK_URL:-}" ]; then
  echo "Doku paketi indiriliyor…"
  curl -fL "$PACK_URL" -o pack.zip.tmp && mv pack.zip.tmp pack.zip || { rm -f pack.zip.tmp; echo "Paket indirilemedi." >&2; }
fi

echo "Köprü indiriliyor…"
curl -fsSL "$REPO" -o relay.tar.gz
rm -rf src.tmp && mkdir src.tmp && tar -xzf relay.tar.gz -C src.tmp --strip-components=1 && rm relay.tar.gz
rm -rf web && cp -r src.tmp/web web && cp src.tmp/server.js src.tmp/package.json . && rm -rf src.tmp

# Node.js: the system's if it is 18+, otherwise a portable Node 20 in ./node (nothing installed system-wide).
NODE=""
if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ]; then NODE="$(command -v node)"; NPM="$(command -v npm)"; fi
if [ -z "$NODE" ] && [ -x node/bin/node ]; then NODE="$DIR/node/bin/node"; NPM="$DIR/node/bin/npm"; fi
if [ -z "$NODE" ]; then
  case "$(uname -m)" in
    x86_64|amd64) ARCH=x64 ;;
    aarch64|arm64) ARCH=arm64 ;;
    *) echo "Desteklenmeyen işlemci: $(uname -m)" >&2; exit 1 ;;
  esac
  echo "Node.js yok; taşınabilir Node.js 20 indiriliyor (bir kere)…"
  curl -fsSL "https://nodejs.org/dist/v20.18.0/node-v20.18.0-linux-$ARCH.tar.gz" -o node.tar.gz
  rm -rf node node.tmp
  mkdir node.tmp
  tar -xzf node.tar.gz -C node.tmp --strip-components=1
  mv node.tmp node
  rm -f node.tar.gz
  NODE="$DIR/node/bin/node"; NPM="$DIR/node/bin/npm"
fi
export PATH="$(dirname "$NODE"):$PATH"
echo "Kütüphaneler kuruluyor…"
"$NPM" install --omit=dev --no-audit --no-fund --loglevel=error

# The old Java relay and an earlier copy of this one: stop them.
if [ -f relay.pid ] && kill -0 "$(cat relay.pid)" 2>/dev/null; then echo "Eski köprü durduruluyor…"; kill "$(cat relay.pid)" || true; sleep 1; fi
nohup "$NODE" server.js "$PORT" "$(cat pisan-relay-key.txt)" > relay.log 2>&1 < /dev/null &
echo $! > relay.pid
sleep 2
cat relay.log
if ! kill -0 "$(cat relay.pid)" 2>/dev/null; then echo "Köprü başlatılamadı (yukarıdaki kayda bak)." >&2; exit 1; fi
IP=$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')
echo
echo "Köprü arka planda çalışıyor (pid $(cat relay.pid)). Kayıtlar: $DIR/relay.log"
echo "Adres: http://${IP:-?}:$PORT/"
echo "Durdurmak için: kill \$(cat $DIR/relay.pid)"
