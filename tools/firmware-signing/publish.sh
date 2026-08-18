#!/usr/bin/env bash
#
# Build → sign → upload → (optionally) install a hub firmware release.
#
# Run this on the DEV MACHINE, never on the droplet: signing needs the private
# key, and the private key must never leave this machine.
#
# Usage:
#   ./publish.sh                          # build, sign, upload
#   ./publish.sh --install <HUB_MAC>      # ...and stage it on that hub
#   ./publish.sh --install all            # ...and stage it on every hub
#   ./publish.sh --no-build               # use the existing firmware.bin
#   ./publish.sh --list                   # just list what is on the server
#
# Config comes from tools/firmware-signing/publish.env (gitignored), or the
# environment. See publish.env.example.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

REPO_ROOT=$(cd ../.. && pwd)
ENV_FILE=${PUBLISH_ENV:-publish.env}
# Source relative paths from this directory, absolute ones as given.
case "$ENV_FILE" in
  /*|./*|../*) [ -f "$ENV_FILE" ] && . "$ENV_FILE" ;;
  *)           [ -f "$ENV_FILE" ] && . "./$ENV_FILE" ;;
esac

API=${API:-}
ADMIN_USER=${ADMIN_USER:-admin}
ADMIN_PASS=${ADMIN_PASS:-}
KEY=${KEY:-fw-signing-key.pem}
PIO_ENV=${PIO_ENV:-xiao_esp32c6_hub}
# PlatformIO is not on PATH in Git Bash by default; fall back to its venv.
PIO=${PIO:-pio}
command -v "$PIO" >/dev/null 2>&1 || PIO="$HOME/.platformio/penv/Scripts/pio.exe"
BIN=${BIN:-$REPO_ROOT/hub/.pio/build/$PIO_ENV/firmware.bin}
SRC=${SRC:-$REPO_ROOT/hub/src/main.cpp}

die() { echo "error: $*" >&2; exit 1; }
note() { echo "==> $*"; }

DO_BUILD=1
INSTALL_ON=""
LIST_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --no-build) DO_BUILD=0 ;;
    --install)  shift; INSTALL_ON=${1:-} ; [ -n "$INSTALL_ON" ] || die "--install needs a MAC or 'all'" ;;
    --list)     LIST_ONLY=1 ;;
    -h|--help)  sed -n '2,20p' "$0"; exit 0 ;;
    *)          die "unknown option: $1" ;;
  esac
  shift
done

[ -n "$API" ]        || die "API is not set (create publish.env from publish.env.example)"
[ -n "$ADMIN_PASS" ] || die "ADMIN_PASS is not set"

# --- helpers ---------------------------------------------------------------

# Base64 contains +, / and =. A raw + in a query string decodes to a space,
# which silently corrupts the signature — the hub downloads the whole image and
# only then reports "signature invalid". Always encode.
urlencode() {
  python -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$1"
}

# Tolerates non-JSON (curl errors, HTML error pages) by returning nothing, so
# callers report a clean message instead of a Python traceback.
jsonfield() {
  python -c "
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
print(d.get(sys.argv[1], '') if isinstance(d, dict) else '')
" "$1"
}

login() {
  local body
  body=$(printf '{"username":"%s","password":"%s"}' "$ADMIN_USER" "$ADMIN_PASS")
  TOKEN=$(curl -fsS -X POST "$API/api/auth/login" \
            -H 'Content-Type: application/json' -d "$body" | jsonfield accessToken)
  [ -n "$TOKEN" ] || die "login failed"
}

# --- list only -------------------------------------------------------------

if [ "$LIST_ONLY" = 1 ]; then
  login
  curl -fsS "$API/api/firmware" -H "Authorization: Bearer $TOKEN" \
    | python -c "
import sys, json
rows = json.load(sys.stdin)
if not rows:
    print('(no firmware uploaded)')
for r in rows:
    print(f\"{r['id']:>4}  {r['version']:<8} {r['size']:>9} B  {r['sha256'][:12]}…  {r.get('notes') or ''}\")
"
  exit 0
fi

# --- version, from the source of truth -------------------------------------

read_ver() { grep -E "^#define FW_$1 " "$SRC" | awk '{print $3}'; }
VER="$(read_ver MAJOR).$(read_ver MINOR).$(read_ver PATCH)"
[ -n "$VER" ] && [ "$VER" != ".." ] || die "could not read FW_VERSION from $SRC"
note "version $VER (from $SRC)"

# --- build -----------------------------------------------------------------

if [ "$DO_BUILD" = 1 ]; then
  note "building $PIO_ENV"
  ( cd "$REPO_ROOT/hub" && "$PIO" run -e "$PIO_ENV" >/dev/null ) \
    || die "build failed — run '$PIO run -e $PIO_ENV' to see why"
fi
[ -f "$BIN" ] || die "no firmware at $BIN (drop --no-build?)"

# The signature covers the exact bytes, so a stale binary would upload a valid
# signature for the wrong image and fail on the device.
if [ "$DO_BUILD" = 0 ] && [ "$SRC" -nt "$BIN" ]; then
  echo "warning: $SRC is newer than the binary — you may be publishing a stale build" >&2
fi

# --- sign ------------------------------------------------------------------

[ -f "$KEY" ] || die "signing key not found at $KEY"
note "signing"
SIG=$(node sign.js sign "$KEY" "$BIN" | awk '/^signature:/{print $2}')
[ -n "$SIG" ] || die "signing produced no signature"

# --- upload ----------------------------------------------------------------

login
note "uploading $(wc -c < "$BIN") bytes"
RESP=$(curl -fsS -X POST \
  "$API/api/firmware?version=$VER&signature=$(urlencode "$SIG")&kind=hub&notes=$(urlencode "${NOTES:-published by publish.sh}")" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/octet-stream' \
  --data-binary @"$BIN")

FW_ID=$(printf '%s' "$RESP" | jsonfield id)
[ -n "$FW_ID" ] || die "upload failed: $RESP"

VERIFIED=$(printf '%s' "$RESP" | jsonfield signature_verified)
case "$VERIFIED" in
  True)  note "uploaded as id $FW_ID — signature verified server-side" ;;
  False) die  "server rejected the signature for this image" ;;
  *)     note "uploaded as id $FW_ID (set FW_PUBLIC_KEY_PEM on the server to verify at upload)" ;;
esac

# --- install ---------------------------------------------------------------

[ -n "$INSTALL_ON" ] || { note "not installing (pass --install <MAC|all>)"; exit 0; }

if [ "$INSTALL_ON" = all ]; then
  MACS=$(curl -fsS "$API/api/devices" -H "Authorization: Bearer $TOKEN" \
         | python -c "import sys,json;print(' '.join(d['mac'] for d in json.load(sys.stdin)))")
else
  MACS=$INSTALL_ON
fi

for mac in $MACS; do
  note "installing $VER on $mac"
  curl -fsS -X POST "$API/api/firmware/$FW_ID/stage" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d "$(printf '{"hub_mac":"%s"}' "$mac")" >/dev/null \
    && echo "    staged" || echo "    FAILED (hub offline, or already on $VER)"
done

note "watch progress on the Firmware page, or:"
echo "    curl -s \"\$API/api/devices\" -H \"Authorization: Bearer \$TOKEN\""
