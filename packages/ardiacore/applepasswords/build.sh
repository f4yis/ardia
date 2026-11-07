#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
name="ardia-apple-passwords"
helpers="$TARGET_BUILD_DIR/$CONTENTS_FOLDER_PATH/Helpers"
work="${DERIVED_FILE_DIR:-$here/build}/applepasswords"
identity="${EXPANDED_CODE_SIGN_IDENTITY:--}"
[ -z "$identity" ] && identity="-"
min_os="${MACOSX_DEPLOYMENT_TARGET:-14.0}"
source="$here/ApplePasswordsRelay.swift"
binary="$work/$name"
mkdir -p "$work" "$helpers"

if [ ! -f "$binary" ] || [ "$source" -nt "$binary" ] || [ "$0" -nt "$binary" ]; then
  echo "Building $name"
  slices=()
  for arch in ${ARCHS:-$(uname -m)}; do
    xcrun swiftc -O -module-name ApplePasswordsRelay -target "$arch-apple-macos$min_os" \
      -sdk "$(xcrun --sdk macosx --show-sdk-path)" -o "$work/$name-$arch" "$source"
    slices+=("$work/$name-$arch")
  done
  xcrun lipo -create "${slices[@]}" -output "$binary"
fi

cp "$binary" "$helpers/$name"
case "${EXPANDED_CODE_SIGN_IDENTITY_NAME:-}" in
  "Developer ID"*) timestamp=--timestamp ;;
  *) timestamp=--timestamp=none ;;
esac
codesign --force --sign "$identity" "$timestamp" --options runtime "$helpers/$name"

extensions="$TARGET_BUILD_DIR/$UNLOCALIZED_RESOURCES_FOLDER_PATH/Extensions"
mkdir -p "$extensions"
rsync -a --delete "$here/../extensions/apple-passwords-relay/" "$extensions/apple-passwords-relay/"
