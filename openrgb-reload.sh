#!/bin/bash
# Relaunch OpenRGB as a client of OpenLinkHub's SDK server and load a profile.
# Run as the desktop user (no sudo) so OpenRGB inherits the Wayland session.
#   OPENRGB_PROFILE  profile name to load (default: Default)
#   OPENRGB_SERVER   host:port of the OpenLinkHub SDK server (default: localhost:6743)
set -uo pipefail

OPENRGB_PROFILE="${OPENRGB_PROFILE:-Default}"
OPENRGB_SERVER="${OPENRGB_SERVER:-localhost:6743}"
host="${OPENRGB_SERVER%%:*}"
port="${OPENRGB_SERVER##*:}"
[ "$host" = "localhost" ] && host=127.0.0.1

if ! command -v openrgb >/dev/null; then
  echo "openrgb not found, skipping" >&2
  exit 0
fi

if pkill -x openrgb; then
  echo "Stopped running OpenRGB"
  sleep 1
fi

for _ in $(seq 1 30); do
  if bash -c "exec 3<>/dev/tcp/$host/$port" 2>/dev/null; then
    break
  fi
  sleep 1
done
if ! bash -c "exec 3<>/dev/tcp/$host/$port" 2>/dev/null; then
  echo "OpenLinkHub SDK server on $OPENRGB_SERVER did not come up within 30 s" >&2
  exit 1
fi

setsid -f openrgb --client "$OPENRGB_SERVER" --profile "$OPENRGB_PROFILE" --startminimized >/dev/null 2>&1
echo "OpenRGB started: client $OPENRGB_SERVER, profile $OPENRGB_PROFILE"
