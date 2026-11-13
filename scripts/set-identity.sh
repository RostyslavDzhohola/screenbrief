#!/bin/sh
# Point the project at your own Apple developer team and bundle id prefix, so you can build the
# iPhone app with your account.
#
#   scripts/set-identity.sh <bundle-prefix> <team-id>
#   scripts/set-identity.sh com.example ABCDE12345
#
# It replaces the original prefix everywhere it appears (project settings, entitlements, the
# Swift sources and the Mac tool), sets the team, and switches signing from named provisioning
# profiles to Xcode's automatic signing. Then it regenerates the Xcode project if `xcodegen`
# is installed (brew install xcodegen).
set -eu

if [ $# -ne 2 ]; then
  sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
fi
PREFIX=$1
TEAM=$2
if ! printf '%s' "$PREFIX" | grep -Eq '^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$'; then
  echo "bundle prefix must look like com.example (lowercase letters, digits, dashes, at least one dot)" >&2
  exit 1
fi
if ! printf '%s' "$TEAM" | grep -Eq '^[A-Z0-9]{10}$'; then
  echo "team id must be the 10-character id from developer.apple.com/account (Membership details)" >&2
  exit 1
fi

cd "$(dirname "$0")/.."
OLD=$(sed -n 's/^  bundleIdPrefix: *//p' ios/project.yml)
[ -n "$OLD" ] || { echo "could not read bundleIdPrefix from ios/project.yml" >&2; exit 1; }
OLD_RE=$(printf '%s' "$OLD" | sed 's/\./\\./g')

FILES=$(grep -rlE "$OLD_RE" ios mac --include='*.yml' --include='*.swift' --include='*.mjs' --include='*.entitlements' --include='*.plist' | grep -v '^ios/build/' || true)
for f in $FILES; do
  OLD_RE="$OLD_RE" PREFIX="$PREFIX" perl -pi -e 's/$ENV{OLD_RE}/$ENV{PREFIX}/g' "$f"
done

TEAM="$TEAM" perl -ni -e '
  next if /CODE_SIGN_IDENTITY\[sdk=iphoneos\*\]/;
  next if /PROVISIONING_PROFILE_SPECIFIER/;
  s/^(\s*DEVELOPMENT_TEAM:).*/$1 $ENV{TEAM}/;
  s/^(\s*CODE_SIGN_STYLE:).*/$1 Automatic/;
  print;
' ios/project.yml

echo "bundle prefix: $OLD -> $PREFIX"
echo "team: $TEAM, automatic signing"
if command -v xcodegen >/dev/null 2>&1; then
  (cd ios && xcodegen generate)
else
  echo "now run: brew install xcodegen && (cd ios && xcodegen generate)"
fi
echo "Open ios/ScreenBrief.xcodeproj, pick your iPhone, and Run. Xcode creates the profiles on first build."
