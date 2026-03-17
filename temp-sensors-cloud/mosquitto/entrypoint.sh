#!/bin/sh
# ============================================================
# Mosquitto entrypoint — auto-generate passwd file from env vars
# ============================================================
# Runs before the broker starts. Creates /mosquitto/config/passwd
# with the backend and hub users so no manual mosquitto_passwd
# commands are needed.
#
# Expected env vars (set in docker-compose.yml):
#   MQTT_BACKEND_USER / MQTT_BACKEND_PASS — backend service account
#   MQTT_HUB_USER     / MQTT_HUB_PASS     — shared hub device account
# ============================================================

PASSWD_FILE=/mosquitto/config/passwd

# Always regenerate so passwords stay in sync with .env
rm -f "$PASSWD_FILE"

if [ -n "$MQTT_BACKEND_USER" ] && [ -n "$MQTT_BACKEND_PASS" ]; then
  mosquitto_passwd -b -c "$PASSWD_FILE" "$MQTT_BACKEND_USER" "$MQTT_BACKEND_PASS"
  echo "mosquitto-entrypoint: added user '$MQTT_BACKEND_USER'"
else
  echo "mosquitto-entrypoint: WARNING — MQTT_BACKEND_USER/PASS not set"
fi

if [ -n "$MQTT_HUB_USER" ] && [ -n "$MQTT_HUB_PASS" ]; then
  mosquitto_passwd -b "$PASSWD_FILE" "$MQTT_HUB_USER" "$MQTT_HUB_PASS"
  echo "mosquitto-entrypoint: added user '$MQTT_HUB_USER'"
else
  echo "mosquitto-entrypoint: WARNING — MQTT_HUB_USER/PASS not set"
fi

# Hand off to the real Mosquitto process
exec /usr/sbin/mosquitto -c /mosquitto/config/mosquitto.conf
