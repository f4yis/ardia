#!/bin/sh
set -eu
[ $# -ge 1 ] || { echo "usage: scripts/fork/bundle-plugins.sh <Ardia.app> [plugin ...]  (default: apple-passwords)" >&2; exit 2; }
app="$1"; shift
[ $# -gt 0 ] || set -- apple-passwords
root="$(cd "$(dirname "$0")/../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
python3 -I "$root/scripts/release/official-plugins.py" bundle "$work/plugins"
bundled="$app/Contents/Resources/Plugins"
plist="$app/Contents/Info.plist"
identity="$(codesign -dvv "$app" 2>&1 | sed -n 's/^Authority=//p' | head -1)"
[ -n "$identity" ] || { echo "bundle-plugins: $app isn't signed" >&2; exit 1; }
rm -rf "$bundled"
mkdir -p "$bundled"
/usr/libexec/PlistBuddy -c "Delete :ArdiaBuiltInPlugins" "$plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :ArdiaBuiltInPlugins dict" "$plist"
for name in "$@"; do
  [ -f "$work/plugins/$name/plugin.json" ] || { echo "bundle-plugins: $name isn't pinned in official-plugins.json" >&2; exit 1; }
  ditto --norsrc --noextattr "$work/plugins/$name" "$bundled/$name"
  find "$bundled/$name" -type f -perm -u+x | while IFS= read -r exe; do
    if file -b "$exe" | grep -q '^Mach-O'; then codesign --force --sign "$identity" --options runtime "$exe"; fi
  done
  /usr/libexec/PlistBuddy -c "Add :ArdiaBuiltInPlugins:$name string $("$root/scripts/release/plugin-digest.py" "$bundled/$name")" "$plist"
  echo "bundled $name"
done
codesign --force --sign "$identity" --preserve-metadata=entitlements,requirements,flags,runtime "$app"
codesign --verify --strict "$app"
