#!/bin/bash
# launch_rabbitears_with_web.sh
# Launches all web-based channels, then RabbitEars TV core

set -e

########################################
# 0. Environment Setup
########################################

cd <PATH TO RabbitEars> || { echo "Could not cd to RabbitEars TV"; exit 1; }

# Activate Python virtual environment
source env/bin/activate

# Unset DISPLAY so web channels use their own Xvfb
unset DISPLAY
export XAUTHORITY=/home/<USER>/.Xauthority
export XDG_RUNTIME_DIR=/run/user/1000

########################################
# 1. Launch All Web Channels
########################################

CONF_DIR="./confs"
LOG_DIR="./logs"
mkdir -p "$LOG_DIR"

echo "[RabbitEars] Searching for web_* configs in $CONF_DIR..."

for conf in "$CONF_DIR"/web_*.json; do
  [[ -e "$conf" ]] || continue

  CHANNEL_ID=$(basename "$conf" | sed -E 's/^web_(.+)\.json$/\1/')
  CHANNEL_NUM=$(jq -r '.station_conf.channel_number' "$conf")
  PORT=$((8000 + CHANNEL_NUM))
  STREAM_URL="http://localhost:${PORT}/hls/${CHANNEL_ID}/index.m3u8"

  echo "[RabbitEars] Launching web stream: $CHANNEL_ID"
  echo "[RabbitEars] → Stream URL: $STREAM_URL"

  : > "$LOG_DIR/web_${CHANNEL_ID}.log"
./page_stream/start_web_stream.sh "$CHANNEL_ID" > "$LOG_DIR/web_${CHANNEL_ID}.log" 2>&1 &

  sleep 2
done

########################################
# 2. Wait for Streams to Become Available
########################################

echo "[RabbitEars] Waiting for web streams to warm up..."

for conf in "$CONF_DIR"/web_*.json; do
  [[ -e "$conf" ]] || continue
  CHANNEL_ID=$(basename "$conf" | sed -E 's/^web_(.+)\.json$/\1/')
  CHANNEL_NUM=$(jq -r '.station_conf.channel_number' "$conf")
  PORT=$((8000 + CHANNEL_NUM))
  STREAM_URL="http://localhost:${PORT}/hls/${CHANNEL_ID}/index.m3u8"

  until curl -sf "$STREAM_URL" > /dev/null; do
    echo "[WAIT] Waiting for $CHANNEL_ID stream to be ready..."
    sleep 2
  done
  echo "[READY] Stream ready: $STREAM_URL"
done

########################################
# 3. Launch RabbitEars TV Core Components
########################################

# Restore DISPLAY so GUI components run on the real desktop
export DISPLAY=:0

echo "[RabbitEars] Launching FieldPlayer..."
: > "$LOG_DIR/rabbitears_player.log"
python3 rabbitears_player.py > "$LOG_DIR/rabbitears_player.log" 2>&1 &

sleep 3

echo "[RabbitEars] Launching channel changer..."
: > "$LOG_DIR/channel_changer.log"
python3 rabbitears/change_channel.py > "$LOG_DIR/channel_changer.log" 2>&1 &

echo "[RabbitEars] Launching OSD..."
: > "$LOG_DIR/osd.log"
python3 rabbitears/osd/main.py > "$LOG_DIR/osd.log" 2>&1 &

sleep 2
wmctrl -r "RabbitEarsOSD" -b add,above || echo "[OSD] Failed to raise window"
wmctrl -a "RabbitEarsOSD" || echo "[OSD] Failed to focus window"

########################################
# 4. Wait Indefinitely
########################################

echo "[RabbitEars] All systems launched. Waiting to keep session alive..."
wait

