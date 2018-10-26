#!/bin/bash -e

cd "$(dirname "$0")/.."

_() {
  echo "$*"
  "$@"
}

_ npx solana-localnet update
_ ./program/build.sh
_ npm run build

echo
echo Ok
exit 0