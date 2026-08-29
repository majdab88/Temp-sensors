#!/usr/bin/env bash
#
# Build → sign → upload → (optionally) install a firmware release.
#
# Run this on the DEV MACHINE, never on the droplet: signing needs the private
# key, and the private key must never leave this machine.
#
# Hub:
#   ./publish.sh                          # build, sign, upload
#   ./publish.sh --install <HUB_MAC>      # ...and stage it on that hub
#   ./publish.sh --install all            # ...and stage it on every hub
#
# Sensor:
#   ./publish.sh --sensor                 # build, sign, upload
#   ./publish.sh --sensor --env <name>    # ...from a specific PlatformIO env
#
# Staging a sensor image is deliberately not scriptable here: it waits on a
# button press at the node, so it is chosen per sensor from the dashboard.
#
# Either:
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
# PlatformIO is not on PATH in Git Bash by default; fall back to its venv.
PIO=${PIO:-pio}
command -v "$PIO" >/dev/null 2>&1 || PIO="$HOME/.platformio/penv/Scripts/pio.exe"
# PIO_ENV / BIN / SRC are resolved after the arguments are parsed, since which
# project they point at depends on --sensor.

die() { echo "error: $*" >&2; exit 1; }
note() { echo "==> $*"; }

DO_BUILD=1
INSTALL_ON=""
LIST_ONLY=0
KIND=hub
ENV_OVERRIDE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --sensor)   KIND=sensor ;;
    --hub)      KIND=hub ;;
    --env)      shift; ENV_OVERRIDE=${1:-}; [ -n "$ENV_OVERRIDE" ] || die "--env needs a PlatformIO env name" ;;
    --no-build) DO_BUILD=0 ;;
    --install)  shift; INSTALL_ON=${1:-} ; [ -n "$INSTALL_ON" ] || die "--install needs a MAC or 'all'" ;;
    --list)     LIST_ONLY=1 ;;
    -h|--help)  sed -n '2,26p' "$0"; exit 0 ;;
    *)          die "unknown option: $1" ;;
  esac
  shift
done

# Resolve what we are building only once the mode is known. The sensor default
# is the WROOM v2 board -- the only sensor hardware being deployed -- but the
# other envs still build, so --env picks one.
if [ "$KIND" = sensor ]; then
  PROJECT=sensor-ntc
  PIO_ENV=${ENV_OVERRIDE:-wroom_v2_sensor_ntc}
else
  PROJECT=hub
  # An env-file PIO_ENV is a hub setting; it must not leak into a sensor build.
  PIO_ENV=${ENV_OVERRIDE:-${PIO_ENV:-xiao_esp32c6_hub}}
fi
BIN=${BIN:-$REPO_ROOT/$PROJECT/.pio/build/$PIO_ENV/firmware.bin}
SRC=${SRC:-$REPO_ROOT/$PROJECT/src/main.cpp}

# Staging a sensor image waits on a button press at the node, so it is chosen
# per sensor from the dashboard rather than swept across a fleet from here.
if [ "$KIND" = sensor ] && [ -n "$INSTALL_ON" ]; then
  die "--install is hub-only; stage a sensor image from the dashboard"
fi

# The command is retained at the broker, so a hub that is offline now will
# act on it the moment it reconnects.

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
    print(f\"{r['id']:>4}  {r.get('device_kind','hub'):<7} {r['version']:<8} {r['size']:>9} B  {r['sha256'][:12]}…  {r.get('notes') or ''}\")
"
  exit 0
fi

# --- version ---------------------------------------------------------------
# Read from the source only to name the build; the authoritative value comes
# out of the binary afterwards. An env can override FW_PATCH through
# build_flags -- the rollbacktest builds do -- and the source then describes
# something the image is not.

read_ver() { grep -E "^#define FW_$1 " "$SRC" | awk '{print $3}'; }
VER="$(read_ver MAJOR).$(read_ver MINOR).$(read_ver PATCH)"
[ -n "$VER" ] && [ "$VER" != ".." ] || die "could not read FW_VERSION from $SRC"
note "$KIND $VER (from $SRC)"

# --- build -----------------------------------------------------------------

if [ "$DO_BUILD" = 1 ]; then
  note "building $PIO_ENV"
  ( cd "$REPO_ROOT/$PROJECT" && "$PIO" run -e "$PIO_ENV" >/dev/null ) \
    || die "build failed — run '$PIO run -e $PIO_ENV' to see why"
fi
[ -f "$BIN" ] || die "no firmware at $BIN (drop --no-build?)"

# The version tag compiled into the image is what the server checks the upload
# against, so read it back rather than trusting what the source said.
TAG=$([ "$KIND" = sensor ] && echo TEMPSENS_FW || echo TEMPHUB_FW)
BIN_VER=$(LC_ALL=C grep -a -o -m1 "$TAG=[0-9][0-9.]*" "$BIN" | head -1 | cut -d= -f2)
if [ -n "$BIN_VER" ] && [ "$BIN_VER" != "$VER" ]; then
  note "image says $BIN_VER, not $VER - publishing $BIN_VER (build_flags override)"
  VER=$BIN_VER
elif [ -z "$BIN_VER" ]; then
  echo "warning: no $TAG marker in the image; labelling it $VER from source" >&2
fi

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
  "$API/api/firmware?version=$VER&signature=$(urlencode "$SIG")&kind=$KIND&notes=$(urlencode "${NOTES:-published by publish.sh}")" \
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
  DEVICES=$(curl -fsS "$API/api/devices" -H "Authorization: Bearer $TOKEN")
  MACS=$(printf '%s' "$DEVICES" \
         | python -c "import sys,json;print(' '.join(d['mac'] for d in json.load(sys.stdin)))")

  # A hub that has never reported a firmware version predates OTA support and
  # has no receiver. The command is retained, so it will act on it after its
  # one USB flash - but say so rather than let it look like a silent failure.
  NO_FW=$(printf '%s' "$DEVICES" \
          | python -c "import sys,json;print(' '.join(d['mac'] for d in json.load(sys.stdin) if not d.get('fw_version')))")
  if [ -n "$NO_FW" ]; then
    echo "warning: no firmware version reported by: $NO_FW" >&2
    echo "         these predate OTA support and need one USB flash first" >&2
  fi
else
  MACS=$INSTALL_ON
fi

for mac in $MACS; do
  note "installing $VER on $mac"
  curl -fsS -X POST "$API/api/firmware/$FW_ID/stage" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d "$(printf '{"hub_mac":"%s"}' "$mac")" >/dev/null \
    && echo "    staged" || echo "    FAILED - hub not registered, or API error"
done

note "watch progress on the Firmware page, or:"
echo "    curl -s \"\$API/api/devices\" -H \"Authorization: Bearer \$TOKEN\""
