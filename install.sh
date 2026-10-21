#!/usr/bin/env bash
# Sync the TV's apps, package the launcher and install it on an LG TV in Developer Mode.
#   TV_HOST=192.168.1.50 ./install.sh
# One-time setup (Developer Mode app open on the TV, Key Server on):
#   ares-setup-device -a lgtv -i "{'host':'$TV_HOST','port':'9922','username':'prisoner'}"
#   ares-novacom --device lgtv --getkey          # enter the passphrase shown on the TV
#   ares-setup-device -m lgtv -i "{'privatekey':'lgtv_webos','passphrase':'<passphrase>'}"
set -euo pipefail
cd "$(dirname "$0")"
: "${TV_HOST:?set TV_HOST to the TV IP address, e.g. TV_HOST=192.168.1.50 $0}"
DEVICE="${DEVICE:-lgtv}"
APP_ID=com.gathin.tvhome

# LG's webOS CLI: use it from PATH, otherwise fetch it with npx.
ares() {
  if command -v "ares-$1" >/dev/null; then "ares-$1" "${@:2}"
  else npx -y -p @webos-tools/cli "ares-$1" "${@:2}"; fi
}

PY="${PY:-python3}"
[ -x venv/bin/python ] && PY=venv/bin/python
"$PY" sync-apps.py "$TV_HOST"

if [ ! -f app/icon.png ]; then
  # The webOS app list wants PNG icons: 80px and 130px.
  sips -s format png -z 80 80 assets/icon.jpg --out app/icon.png >/dev/null
  sips -s format png -z 130 130 assets/icon.jpg --out app/largeIcon.png >/dev/null
fi

# The Home watcher (service/) runs on the TV beside the app; its one dependency is bundled in.
(cd service && npm install --omit=dev --no-audit --no-fund --silent)
# It reuses this computer's pairing (from sync-apps.py), so the TV doesn't ask again on every install.
"$PY" -c "import json, sys; print(json.load(open('.lgtv-key.json'))[sys.argv[1]])" "$TV_HOST" > service/.ssap-key \
  2>/dev/null || rm -f service/.ssap-key
rm -rf build && mkdir build
ares package app service -o build
ares install -d "$DEVICE" build/${APP_ID}_*.ipk
ares launch -d "$DEVICE" "$APP_ID"
echo "Installed. If the TV asks to allow a device, accept: that is the Home watcher."
echo "Hold a number key on the remote while the launcher is open to make it a one-press shortcut."
