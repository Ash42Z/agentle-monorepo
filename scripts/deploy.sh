#!/usr/bin/env bash
set -euo pipefail
release_sha=${1:?Exact SHA required}
[[ "$release_sha" =~ ^[0-9a-f]{40}$ ]] || exit 2
release_dir=$(cd -- "$(dirname -- "$0")/.." && pwd)
deploy_root=${AGENTLE_DEPLOY_ROOT:-/opt/agentle-bot}
exec 9>"$deploy_root/deploy.lock"
flock -n 9 || { echo 'Deployment already running'; exit 1; }
python3 "$deploy_root/github_host.py" check "$release_sha"
[[ $(git -C "$release_dir" rev-parse HEAD) == "$release_sha" ]] || exit 2
image="agentle:$release_sha"
docker build -t "$image" "$release_dir"
web_image="agentle-web:$release_sha"
docker build -t "$web_image" -f "$release_dir/web/Dockerfile" "$release_dir"
docker run --rm -e AGENTLE_RELEASE="$release_sha" "$web_image" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
admin_token=$(cat "${AGENTLE_ADMIN_TOKEN_FILE:-/root/.config/agentle/admin-token}")
admin_request() { curl --fail --silent --show-error --max-time 10 -H "Authorization: Bearer $admin_token" "${@:2}" "http://127.0.0.1:8080/$1"; }
old_dir=$(readlink -f "$deploy_root/current" 2>/dev/null || true)
old_running=false
if [[ -n "$old_dir" ]] && docker compose --project-name agentle-bot --env-file "$old_dir/release.env" -f "$old_dir/compose.yaml" ps --status running -q | head -c 1 | read -r -n 1; then old_running=true; fi
switched=false
cleanup() {
 result=$?
 if (( result != 0 )); then
  if $switched && [[ -n "$old_dir" ]]; then
   docker compose --project-name agentle-bot --env-file "$old_dir/release.env" -f "$old_dir/compose.yaml" up -d --force-recreate --remove-orphans
   ln -sfn "$old_dir" "$deploy_root/current"
  fi
  if $old_running; then admin_request admin/resume -X POST >/dev/null || true; fi
 fi
 exit "$result"
}
trap cleanup EXIT
if $old_running; then
 admin_request admin/drain -X POST >/dev/null
 deadline=$((SECONDS+${AGENTLE_DRAIN_TIMEOUT:-21600}))
 while [[ $(admin_request admin/status | python3 -c 'import sys,json;print(json.load(sys.stdin)["activeJobs"])') != 0 ]]; do
  (( SECONDS < deadline )) || { echo 'Drain timeout; keeping current release'; exit 1; }
  sleep 5
 done
fi
mkdir -p "$deploy_root/backups"
python3 - "$deploy_root/backups/$release_sha.sqlite" <<'PY'
import sqlite3,sys,os
path='/root/agentle-data/state.sqlite'
if os.path.exists(path):
 with sqlite3.connect(path) as source,sqlite3.connect(sys.argv[1]) as target:source.backup(target)
PY
printf 'AGENTLE_IMAGE=%s\nAGENTLE_RELEASE=%s\nAGENTLE_WEB_IMAGE=%s\n' "$image" "$release_sha" "$web_image" > "$release_dir/release.env"
switched=true
docker compose --project-name agentle-bot --env-file "$release_dir/release.env" -f "$release_dir/compose.yaml" up -d --force-recreate
healthy=false
for attempt in $(seq 1 "${AGENTLE_READY_ATTEMPTS:-60}"); do
 if admin_request ready | python3 -c 'import sys,json;d=json.load(sys.stdin);sys.exit(not d["ready"] or d["release"]!=sys.argv[1])' "$release_sha"; then
  if [[ $(docker compose --project-name agentle-bot --env-file "$release_dir/release.env" -f "$release_dir/compose.yaml" exec -T caddy wget -q -O - http://127.0.0.1:8081/health) == "$release_sha" ]]; then healthy=true;break;fi
 fi
 sleep 2
done
$healthy || { echo 'New release failed readiness; rolling back'; exit 1; }
[[ -z "$old_dir" ]] || ln -sfn "$old_dir" "$deploy_root/previous"
ln -sfn "$release_dir" "$deploy_root/current"
admin_request admin/resume -X POST >/dev/null
echo "Deployed $release_sha"
