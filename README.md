# Agentle

A private, self-hosted GitHub coding agent for `Ash42Z/agentle-monorepo`. Only requests authored by `Ash42Z` are queued. Agentle implements work, runs checks and publishes draft PRs; the owner reviews and merges. It never merges or pushes to the default branch.

## Requests and state

Open an issue with the requested change, or comment on an issue/PR. Existing same-repository PR branches are supported. Fork PRs are rejected. Review comments and review bodies are collected too. Polling runs every 30 seconds. SQLite records event identifiers, jobs, publication checkpoints, conversation branches and Codex thread IDs. One job runs at a time; later requests on a conversation wait for earlier jobs. Overlapping poll windows catch updates without duplicating requests. Bot comments are ignored.

Codex uses the dedicated `/root/agentle-data/codex` credentials and session directory, persisted through upgrades. Subscription limits pause work without discarding the workspace or thread. Exhausted quota windows determine the retry time; missing reset information uses bounded exponential backoff. Authentication failures are reported separately. API credentials are never inherited by the worker, and there is no paid API fallback.

The controller runs as root inside the container. Coding runs as UID 10001, which cannot read `/config`, the SQLite database, deployment credentials, or controller git authentication files. Git metadata is controller owned, with a sticky workspace directory. No Docker socket is mounted. Codex itself has unrestricted access within that worker identity and the container; use only for trusted private automation. A worker can read its own subscription credentials. App permissions should be minimized after setup: Contents, Issues, Pull requests and Workflows write; Actions read for host deployment verification. Temporarily granting Administration and Secrets write is useful for setup and can be removed afterward.

## Development

Requires Node 22.13 or newer and Docker.

```sh
npm ci
npm run check
npm test
docker build -t agentle:local .
```

## Host setup

Keep `/root/.config/agentle` root-owned, mode 700, containing `github-app.pem`, `config.json` and `admin-token`, each mode 600. Configuration fields: `githubAppId`, `githubInstallationId`, `repository`, `allowedUser`, `githubAppSlug`.

Create `/root/agentle-data` mode 711 and its `codex` child owned by UID/GID 10001, mode 700. Sign in separately:

```sh
CODEX_HOME=/root/agentle-data/codex codex login --device-auth
chown -R 10001:10001 /root/agentle-data/codex
```

Install `scripts/github_host.py` and `scripts/deploy-entry.sh` in root-owned `/opt/agentle-bot`. Set up user `agentle-deploy` with a restricted SSH authorized key whose forced command is `sudo /opt/agentle-bot/deploy-entry.sh`. Grant that exact executable through sudo and preserve `SSH_ORIGINAL_COMMAND`. The entry point only accepts `deploy <40-character SHA>` and independently verifies that SHA is current main with a successful CI `test` job. Do not allow interactive SSH or port forwarding for this key.

Repository Actions secrets: `AGENTLE_DEPLOY_KEY`, `AGENTLE_DEPLOY_HOST`, `AGENTLE_KNOWN_HOSTS` (pin the actual SSH host public key). The production environment uses these repository secrets. CI builds and tests the exact merge commit before deployment.

Host releases live at `/opt/agentle-bot/releases/<SHA>`. Deployment acquires a lock, builds before draining, waits up to six hours for active work, backs up SQLite and recreates the Compose services. Both the controller and web images are built and the Caddyfile validated before draining. Deployment checks the controller and the Caddy release probe; rollback restores both images and removes services absent from the prior release. A new release starts drained until deployment verifies readiness and explicitly resumes it. Activation is persisted so ordinary restarts resume processing. Readiness checks GitHub polling and ChatGPT authentication. Failed startup restores the previous release; additive schema changes must remain compatible with that version. State lives outside releases. The previous release and database backups are retained. Docker starts at boot; Compose uses `restart: unless-stopped`.

The localhost admin API requires `Authorization: Bearer <admin-token>`: `POST /admin/drain`, `POST /admin/resume`, `GET /admin/status`, `GET /ready`. Port 8080 is published only to host loopback. SIGTERM stops collecting new jobs and waits for the current job to finish; an unclean restart preserves workspace state and resumes the durable job.

## Branch protection

Protect `main`: require a PR, dismiss stale approvals, require the GitHub Actions `test` check, require the branch to be current, resolve review conversations, block force pushes and deletion, and enforce restrictions for administrators. Give the App no bypass entry. The owner controls merging. The approval count is zero so the sole owner can also merge their own PRs; bot PRs should still be reviewed manually. Protection may require a GitHub plan supporting private repository rules.

## Operational limitations

Quota and authentication recovery are tested with protocol fixtures; an actual quota exhaustion cannot be forced safely. Automatic retries preserve changes, but repeated failures can require owner intervention. Only one repository and one coding job are supported. Deployment cannot complete until the initial implementation is merged and successful main CI exists. No public webhook endpoint, custom bot systemd service, zero-downtime upgrade, or automatic paid API fallback is used.

## Public HTTP services

The root `Caddyfile` is the master entry point for `agentle.cc`. Caddy serves `web/index.html`, automatically obtains and renews public certificates, and redirects HTTP to HTTPS. The web image includes its configuration and content, so each merge to `main` deploys an exact, self-contained release through the existing CI deployment workflow. Named Compose volumes retain certificates and Caddy state across releases; do not remove them with `docker compose down -v`.

Before the first deployment, point the domain's A record (and any AAAA record) at this VPS and allow inbound TCP 80/443 and optionally UDP 443 for HTTP/3. Those host ports must be available. Certificate issuance requires working public DNS and inbound access; the internal readiness probe checks the running release, not public DNS or certificate issuance. The probe and Caddy admin API are not exposed publicly, and the controller's authenticated admin API remains on host loopback.

For another service, add it to `compose.yaml` without a host port and add a `handle_path /example/* { reverse_proxy example:3000 }` route before the fallback `handle` in `Caddyfile` (see the commented example). This strips the prefix; use `handle /example/*` if the application expects it. Alternatively, add a new hostname block with `reverse_proxy service:3000` and point that hostname's DNS to the VPS. Include any new service image builds in CI and the pre-drain deployment build phase, plus appropriate readiness checks. Keep private controller endpoints out of public routes.

Local image/configuration checks:

```sh
docker build -t agentle-web:local -f web/Dockerfile .
docker run --rm -e AGENTLE_RELEASE=local agentle-web:local caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
AGENTLE_IMAGE=agentle:local AGENTLE_WEB_IMAGE=agentle-web:local AGENTLE_RELEASE=local docker compose config --quiet
```
