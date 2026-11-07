#!/usr/bin/env bash
# Usage: adapt-extension.sh [destination]
# Downloads Apple's iCloud Passwords extension and writes a copy Ardia can load unpacked
# (Settings › Extensions › Load unpacked), with its helper connection pointed at Ardia's relay.
# Default destination: ~/Library/Application Support/Ardia/iCloud Passwords
set -euo pipefail

case "${1:-}" in -h | --help) sed -n '2,5p' "$0" | cut -c3-; exit 0 ;; esac
dest="${1:-$HOME/Library/Application Support/Ardia/iCloud Passwords}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

curl -fsSL -o "$work/extension.crx" \
  "https://clients2.google.com/service/update2/crx?response=redirect&prodversion=157.0.0.0&acceptformat=crx3&x=id%3Dpejdijmoenmkgeppbflobdenhhabjlaj%26uc"
unzip -qo "$work/extension.crx" -d "$work/extension" 2>/dev/null || [ $? -eq 1 ]
rm -rf "$work/extension/_metadata"
sed -i '' 's/connectNative("com\.apple\.passwordmanager")/connectNative("com.ardia.apple_passwords")/' "$work/extension/background.js"
grep -q 'connectNative("com.ardia.apple_passwords")' "$work/extension/background.js"
plutil -remove update_url "$work/extension/manifest.json"
[ "$(plutil -extract key raw "$work/extension/manifest.json" | cut -c1-40)" = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKC" ]

rm -rf "$dest"
mkdir -p "$(dirname "$dest")"
mv "$work/extension" "$dest"
echo "$dest"
