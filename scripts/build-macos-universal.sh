#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
MT_ARCHS="arm64 x86_64" bash build.sh
APP="build/AI 遥测.app"
xcrun lipo "$APP/Contents/MacOS/AI 遥测" -verify_arch arm64
xcrun lipo "$APP/Contents/MacOS/AI 遥测" -verify_arch x86_64
codesign --verify --deep --strict "$APP"
plutil -lint "$APP/Contents/Info.plist"
VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")
PACKAGE="build/ai-yaoce-$VERSION-macos-universal.zip"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$PACKAGE"
shasum -a 256 "$PACKAGE"
