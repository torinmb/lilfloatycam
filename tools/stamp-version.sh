#!/bin/bash
# Stamps every page with <meta name="site-version" content="YYYY-MM-DD HH:MM UTC">
# so you can tell which deploy is live: View Source, or
#   curl -s https://lilfloatycam.com/ | grep site-version
# Run it right before committing.
set -euo pipefail
cd "$(dirname "$0")/.."
STAMP=$(date -u +"%Y-%m-%d %H:%M UTC")
for f in index.html */index.html; do
  [ -f "$f" ] || continue
  if grep -q '<meta name="site-version"' "$f"; then
    perl -pi -e "s|<meta name=\"site-version\" content=\"[^\"]*\"\s*/?>|<meta name=\"site-version\" content=\"$STAMP\">|" "$f"
  else
    perl -0pi -e "s|(<meta charset=\"utf-8\"\s*/?>)|\$1\n<meta name=\"site-version\" content=\"$STAMP\">|i" "$f"
  fi
done
echo "site-version $STAMP"
