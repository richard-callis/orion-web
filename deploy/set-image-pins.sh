#!/usr/bin/env bash
# Write ORION_WEB/GATEWAY/VECTOR_VERSION lines (stdin) into deploy/.env, replacing
# those variables if already there (others are kept), so a compose command or
# bootstrap.sh run by hand uses the images that were last deployed (or rolled back
# to), not a stale :latest. Values must be registry tags.
set -euo pipefail
ENV_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.env"
pins="" keys=""
while IFS= read -r line || [ -n "$line" ]; do
  [ -n "$line" ] || continue
  if ! [[ "$line" =~ ^(ORION_(WEB|GATEWAY|VECTOR)_VERSION)=[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]]; then
    echo "set-image-pins: not a pin: ${line:0:80}" >&2
    exit 1
  fi
  pins+="$line"$'\n'
  keys+="${keys:+|}${BASH_REMATCH[1]}"
done
[ -n "$pins" ] || { echo "set-image-pins: no pins given" >&2; exit 1; }
tmp=$(mktemp "$ENV_FILE.XXXXXX")
trap 'rm -f "$tmp"' EXIT
# grep exits 1 when it keeps nothing, 2 on a read error: only 1 is fine.
grep -vE "^($keys)=" "$ENV_FILE" > "$tmp" || [ $? = 1 ]
printf '%s' "$pins" >> "$tmp"
chmod --reference="$ENV_FILE" "$tmp"
chown --reference="$ENV_FILE" "$tmp"
mv "$tmp" "$(readlink -f "$ENV_FILE")"
trap - EXIT
