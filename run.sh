#!/usr/bin/env bash
# Run a command inside WSL with the project node on PATH.
# Usage: wsl -d Ubuntu -- bash /home/marko/work/cmdpost/run.sh "npm test"
set -euo pipefail
export PATH="/home/marko/.nvm/versions/node/v24.18.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/usr/lib/wsl/lib"
exec bash -e -c "$1"
