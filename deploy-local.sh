#!/bin/bash
# Build this fork and drop it over the AUR openlinkhub install in place.
# Requires `IgnorePkg = openlinkhub` in /etc/pacman.conf so yay -Syu
# cannot overwrite it with upstream again.
set -euo pipefail

cd "$(dirname "$0")"

CGO_CFLAGS_ALLOW='-fno-strict-overflow' go build .

sudo systemctl stop openlinkhub
sudo install -Dm755 OpenLinkHub /usr/bin/openlinkhub
# database/ merges: shipped definitions are refreshed, user-created files are untouched
sudo cp -r web static api database /var/lib/openlinkhub/
sudo chown -R openlinkhub:openlinkhub /var/lib/openlinkhub
sudo systemctl start openlinkhub

echo "Deployed. WebUI: http://127.0.0.1:27003"

# OpenRGB is a client of the SDK server that just restarted; reconnect it.
[ "${SKIP_OPENRGB:-0}" = 1 ] || ./openrgb-reload.sh
