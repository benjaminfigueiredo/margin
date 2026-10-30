#!/usr/bin/env bash
# Builds Margin.app (macOS 13+) into mac/dist/, and mac/dist/Margin.zip.
#
#   mac/build-app.sh               for this Mac's architecture
#   mac/build-app.sh --universal   Apple silicon and Intel in one app (what CI builds)
#
# Needs Xcode or the Command Line Tools (swift, codesign, iconutil) and Node/npm (only to install
# Margin's production dependencies into the bundle; the app itself uses the Node installed on
# the Mac that runs it). The app is ad-hoc signed: see README, "Mac app", for Gatekeeper.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
dist="$here/dist"
app="$dist/Margin.app"

arch_args=()
for arg in "$@"; do
  case "$arg" in
    --universal) arch_args=(--arch arm64 --arch x86_64) ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "build-app.sh: unknown option $arg" >&2; exit 2 ;;
  esac
done

if [[ "$(uname -s)" != Darwin ]]; then
  echo "build-app.sh: Margin.app can only be built on macOS" >&2
  exit 1
fi
for tool in swift codesign iconutil ditto plutil node npm; do
  command -v "$tool" >/dev/null || { echo "build-app.sh: $tool not found" >&2; exit 1; }
done

version="$(node -p 'require(process.argv[1]).version' "$repo/package.json")"
echo "==> Margin $version"

echo "==> swift build -c release ${arch_args[*]:-}"
swift build -c release --package-path "$here" ${arch_args[@]+"${arch_args[@]}"}
bin_dir="$(swift build -c release --package-path "$here" ${arch_args[@]+"${arch_args[@]}"} --show-bin-path)"
[[ -x "$bin_dir/Margin" ]] || { echo "build-app.sh: no executable at $bin_dir/Margin" >&2; exit 1; }

echo "==> assembling $app"
rm -rf "$app" "$dist/Margin.zip"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$bin_dir/Margin" "$app/Contents/MacOS/Margin"
cp "$here/Info.plist" "$app/Contents/Info.plist"
plutil -replace CFBundleShortVersionString -string "$version" "$app/Contents/Info.plist"
plutil -replace CFBundleVersion -string "$version" "$app/Contents/Info.plist"
printf 'APPL????' > "$app/Contents/PkgInfo"

# Margin itself: what `npm install margin` would ship (package.json "files"), plus the lockfile.
res="$app/Contents/Resources/margin"
mkdir -p "$res"
for d in bin server public templates; do ditto "$repo/$d" "$res/$d"; done
cp "$repo/package.json" "$repo/package-lock.json" "$repo/README.md" "$res/"
chmod 755 "$res/bin/margin.js"

# Production dependencies only, installed in a staging folder from the lockfile (never the
# developer's node_modules, which holds esbuild, Playwright and the rest). No optional
# dependencies: the only one is fsevents, a native module chokidar can do without, which keeps
# the bundle free of native code (nothing to sign or to be blocked by Gatekeeper inside it).
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
cp "$repo/package.json" "$repo/package-lock.json" "$stage/"
echo "==> npm ci --omit=dev --omit=optional"
(cd "$stage" && npm ci --omit=dev --omit=optional --no-audit --no-fund)
rm -rf "$stage/node_modules/.bin"
ditto "$stage/node_modules" "$res/node_modules"

echo "==> icon"
iconset="$stage/Margin.iconset"
if swift "$here/tools/make-icon.swift" "$iconset" && iconutil -c icns "$iconset" -o "$app/Contents/Resources/Margin.icns"; then
  echo "    Margin.icns"
else
  echo "build-app.sh: WARNING: could not make the icon; the app will have the generic one" >&2
fi

echo "==> signing (ad hoc)"
xattr -cr "$app"
codesign --force --deep --sign - "$app"
codesign --verify --deep --strict "$app"

echo "==> $dist/Margin.zip"
ditto -c -k --sequesterRsrc --keepParent "$app" "$dist/Margin.zip"
echo "Built $app ($(du -sh "$app" | cut -f1)) and $dist/Margin.zip"
