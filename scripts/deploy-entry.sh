#!/usr/bin/env bash
set -euo pipefail
[[ ${SSH_ORIGINAL_COMMAND:-${1:-}} =~ ^deploy\ ([0-9a-f]{40})$ ]] || { echo 'Only deploy <SHA> is permitted'; exit 2; }
release_sha=${BASH_REMATCH[1]}
if (( EUID != 0 )); then exec sudo /opt/agentle/deploy-entry.sh "deploy $release_sha"; fi
python3 /opt/agentle/github_host.py check "$release_sha"
release_dir="/opt/agentle/releases/$release_sha"
if [[ ! -d "$release_dir/.git" ]]; then
 mkdir -p /opt/agentle/releases
 python3 /opt/agentle/github_host.py git /opt/agentle/releases clone https://github.com/Ash42Z/agentle-monorepo.git "$release_dir"
 git -C "$release_dir" checkout --detach "$release_sha"
fi
exec bash "$release_dir/scripts/deploy.sh" "$release_sha"
