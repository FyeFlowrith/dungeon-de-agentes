#!/bin/zsh
# Compila y arma «Dungeon de agentes.app» (universal: Apple Silicon e Intel, macOS 12+).
# Uso: ./armar.sh [carpeta destino]   (por defecto build/)
set -e
SRC=${0:A:h}
OUT=${1:-$SRC/build}
APP="$OUT/Dungeon de agentes.app"
C="$APP/Contents"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

for arch in arm64 x86_64; do
  swiftc -O -swift-version 5 -target "$arch-apple-macos12.0" \
    -framework Cocoa -framework WebKit "$SRC/main.swift" -o "$TMP/dungeon-$arch"
done

rm -rf "$APP"
mkdir -p "$C/MacOS" "$C/Resources"
lipo -create "$TMP/dungeon-arm64" "$TMP/dungeon-x86_64" -output "$C/MacOS/dungeon-de-agentes"
cp -R "$SRC/web" "$C/Resources/web"

# Ícono de la app y el chico de la barra de menú, a partir del de 1024
ICONSET="$TMP/icon.iconset"
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$SRC/icono-1024.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) "$SRC/icono-1024.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$C/Resources/icon.icns"
sips -z 36 36 "$SRC/icono-1024.png" --out "$C/Resources/icono.png" >/dev/null

cat > "$C/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Dungeon de agentes</string>
  <key>CFBundleDisplayName</key><string>Dungeon de agentes</string>
  <key>CFBundleIdentifier</key><string>local.dungeon-de-agentes</string>
  <key>CFBundleExecutable</key><string>dungeon-de-agentes</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>2.0</string>
  <key>CFBundleVersion</key><string>2</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>NSAppleEventsUsageDescription</key>
  <string>Para llevarte a la pestaña de Terminal o iTerm2 donde corre cada agente.</string>
</dict>
</plist>
PLIST

codesign --force --deep -s - "$APP"
echo "$APP"
