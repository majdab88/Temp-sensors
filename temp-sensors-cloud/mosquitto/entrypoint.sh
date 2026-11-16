#!/bin/sh
# ============================================================
# Mosquitto entrypoint — build the password file and ACL, keep them current
# ============================================================
# Runs before the broker starts, as root. Builds:
#
#   /mosquitto/config/passwd  — the backend account, the transitional shared
#                               hub account if still configured, and one
#                               account per registered hub
#   /mosquitto/config/acl     — /mosquitto/config/acl.base plus one entry per
#                               hub, restricting it to sensors/<its MAC>/#
#
# The per-hub accounts come from $HUBS_FILE, which the backend writes from the
# devices table (backend/src/mqtt-accounts.js): one "user password MAC" line
# per hub. A background loop rebuilds both files when it changes and sends
# mosquitto SIGHUP, which reloads them without dropping connected clients.
#
# Expected env vars (set in docker-compose.yml):
#   MQTT_BACKEND_USER / MQTT_BACKEND_PASS — backend service account
#   MQTT_HUB_USER     / MQTT_HUB_PASS     — the old shared hub account. Only
#       while hubs are moving to their own accounts; leave unset afterwards.
# ============================================================

CONF_DIR=/mosquitto/config
HUBS_FILE=/mosquitto/hubs/hubs

build() {
  pw="$CONF_DIR/passwd.new"
  acl="$CONF_DIR/acl.new"
  rm -f "$pw" "$acl"

  if [ -n "$MQTT_BACKEND_USER" ] && [ -n "$MQTT_BACKEND_PASS" ]; then
    mosquitto_passwd -b -c "$pw" "$MQTT_BACKEND_USER" "$MQTT_BACKEND_PASS"
  else
    echo "mosquitto-entrypoint: WARNING — MQTT_BACKEND_USER/PASS not set"
    : > "$pw"
  fi

  cat "$CONF_DIR/acl.base" > "$acl"

  if [ -n "$MQTT_HUB_USER" ] && [ -n "$MQTT_HUB_PASS" ]; then
    mosquitto_passwd -b "$pw" "$MQTT_HUB_USER" "$MQTT_HUB_PASS"
    printf '\n# Shared hub account (transitional)\nuser %s\ntopic readwrite sensors/#\n' \
      "$MQTT_HUB_USER" >> "$acl"
  fi

  n=0
  if [ -f "$HUBS_FILE" ]; then
    while read -r user pass mac; do
      [ -n "$user" ] && [ -n "$pass" ] && [ -n "$mac" ] || continue
      mosquitto_passwd -b "$pw" "$user" "$pass"
      printf '\nuser %s\ntopic readwrite sensors/%s/#\n' "$user" "$mac" >> "$acl"
      n=$((n + 1))
    done < "$HUBS_FILE"
  fi

  chown mosquitto:mosquitto "$pw" "$acl" 2>/dev/null
  chmod 0600 "$pw" "$acl" 2>/dev/null
  mv "$pw" "$CONF_DIR/passwd"
  mv "$acl" "$CONF_DIR/acl"
  echo "mosquitto-entrypoint: accounts built ($n hub(s)$([ -n "$MQTT_HUB_USER" ] && echo ', plus the shared hub account'))"
}

stamp() { md5sum "$HUBS_FILE" 2>/dev/null; }

build
last=$(stamp)

# Rebuild on change. Polled rather than inotify, which the image does not have;
# a new hub's account is live within one interval of being registered.
(
  while sleep 5; do
    cur=$(stamp)
    if [ "$cur" != "$last" ]; then
      # pidof, not "pkill -x": busybox pkill does not match the exec'd broker.
      build && kill -HUP $(pidof mosquitto)
      last=$cur
    fi
  done
) &

# Hand off to the real Mosquitto process
exec /usr/sbin/mosquitto -c /mosquitto/config/mosquitto.conf
