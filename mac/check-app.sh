#!/usr/bin/env bash
# Checks a built Margin.app without running it: Info.plist, signature, executable bits, the
# Margin sources and production-only dependencies in Resources. Prints one line per check.
#
#   mac/check-app.sh [mac/dist/Margin.app]
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app="${1:-$here/dist/Margin.app}"
res="$app/Contents/Resources/margin"
failed=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; failed=1; }
check() { local what="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$what"; else bad "$what"; fi; }

[[ -d "$app" ]] || { echo "FAIL no app at $app"; exit 1; }
plist="$app/Contents/Info.plist"
check "Info.plist is valid" plutil -lint "$plist"
key() { plutil -extract "$1" raw -o - "$plist" 2>/dev/null; }
same() { if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 (found '$2', expected '$3')"; fi; }
same "bundle id" "$(key CFBundleIdentifier)" io.github.benjaminfigueiredo.margin
same "CFBundleExecutable" "$(key CFBundleExecutable)" Margin
same "LSMinimumSystemVersion" "$(key LSMinimumSystemVersion)" 13.0
same "opens folders (CFBundleDocumentTypes)" "$(key CFBundleDocumentTypes.0.LSItemContentTypes.0)" public.folder
same "never the default app for folders (LSHandlerRank)" "$(key CFBundleDocumentTypes.0.LSHandlerRank)" Alternate
check "NSAppleEventsUsageDescription" test -n "$(key NSAppleEventsUsageDescription)"
version="$(node -p 'require(process.argv[1]).version' "$res/package.json" 2>/dev/null || true)"
same "version (as package.json)" "$(key CFBundleShortVersionString)" "${version:-missing}"

check "the executable is executable" test -x "$app/Contents/MacOS/Margin"
echo "     $(file -b "$app/Contents/MacOS/Margin")"
check "signed (ad hoc), signature valid" codesign --verify --deep --strict "$app"
check "icon" test -s "$app/Contents/Resources/Margin.icns"

check "bin/margin.js is executable" test -x "$res/bin/margin.js"
for f in server/hub.js server/app.js public/hub.html public/index.html public/app.js templates package.json; do
  check "Resources/margin/$f" test -e "$res/$f"
done
for dep in express ws chokidar zod @modelcontextprotocol/sdk; do
  check "dependency $dep" test -d "$res/node_modules/$dep"
done
for dev in esbuild @playwright/test playwright codemirror pdfjs-dist fsevents; do
  if [[ -e "$res/node_modules/$dev" ]]; then bad "development or optional dependency $dev is in the bundle"; else ok "no $dev"; fi
done
natives="$(find "$res" -name '*.node' -o -name '*.dylib' | head -5)"
same "no native modules in Resources" "$natives" ""
links="$(find "$app" -type l | head -5)"
if [[ -n "$links" ]]; then echo "note symlinks: $links"; fi
# The server loads with the bundled dependencies alone (no dev dependencies on the path).
check "the bundled server code loads with the bundled dependencies (import server/hub.js)" \
  node --input-type=module -e "import { pathToFileURL } from 'node:url'; await import(pathToFileURL(process.argv[1]).href)" "$res/server/hub.js"
echo "size: $(du -sh "$app" | cut -f1)"

if (( failed )); then echo "check-app.sh: some checks failed"; exit 1; fi
echo "check-app.sh: all checks passed"
