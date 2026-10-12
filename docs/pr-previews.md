# Automatic PR web previews

Merging this implementation installs preview support through the existing main
CI deployment. It uses the current server, domain, GitHub App and dashboard
login. No additional DNS records, SSH commands or credentials are required,
provided the App retains its existing Actions read permission.

## Architecture

1. PR CI runs the existing checks and Docker validations, packages supported
   static files from the checked-out merge commit's `web/` directory into
   `preview.json`, and uploads the `agentle-preview` artifact. Forks are excluded.
2. A separate `previews` Compose service polls GitHub every 30 seconds. It uses
   the existing App configuration and private key, with Actions read in its
   installation token. It only accepts successful `ci.yaml` PR runs associated
   with an open same-repository PR targeting main and its current head SHA.
3. The service downloads the artifact as data, checks its size, identity, paths
   and file types, re-checks the PR head/state, and atomically replaces that PR's
   bundle in a named volume. It never executes PR code, Dockerfiles or scripts.
   Failed CI or artifact validation retains the last working preview.
4. Caddy routes `https://agentle.cc/previews/pr-123/` to the dashboard backend,
   which authenticates using the existing dashboard login and serves the bundle.
   Songspot's relative API URLs are rewritten to the existing fixed Deezer routes.
   The preview dashboard calls the existing live read-only worker API.
5. The service posts a preview link and the packaged merge/head SHAs on the PR.
   Comment failures are retried without downloading the bundle again. Comments
   are deduplicated per head SHA. The merge SHA is reported by the CI package;
   artifact contents are treated as untrusted web content, never executable
   deployment instructions.
6. Each successful complete open-PR listing removes bundles whose PRs have
   closed, merged, changed base or become ineligible. No webhook is required;
   polling naturally retries missed cleanup and survives restarts. A close racing
   with activation is removed on the next reconciliation. GitHub outages retain
   existing previews until reconciliation succeeds. Old PR comments remain as
   history; removed preview URLs return 404 after authentication.

The named volume persists through release updates. A single manager serializes
updates and cleanup. Each bundle has a 20 MB encoded content limit, 500-file
limit, and there are at most 20 active previews. New previews wait for capacity;
existing ones can still update. The manager is capped at 512 MB RAM and half a
CPU. No production database, workspace or subscription session is mounted into
it. The dashboard receives the preview volume read-only.

Deployment continues to build before draining, abort safely on drain timeout,
and roll back on readiness failure. Readiness now also requires a recent
successful preview reconciliation for the exact release. Startup therefore
checks that the App can list PRs; per-PR download failures are retried separately.
No state migration is introduced and controller threads/workspaces are unchanged.

## Scope and shared-origin behavior

This previews static web changes, including the dashboard UI against production
read-only data. It does not deploy PR versions of the controller, dashboard
backend, Caddyfile, Compose services or other server code. Such changes remain
covered by CI until the owner merges them.

Preview and production share browser origin, authentication and local storage,
explicitly accepted by Ash42Z. Preview JavaScript can access the same live worker
API as the production dashboard, and Songspot presets are shared. Controller
bearer tokens and GitHub credentials remain server-side. Only deploy trusted PR
content to this private repository.

Existing Songspot relative asset/API URLs work under the preview prefix. Future
apps should use relative asset URLs and define trusted production API routes;
absolute paths point at the production origin. Supported files are HTML, CSS,
JavaScript modules/scripts, JSON, SVG, common raster images, icons and WOFF fonts.
Bundles require a root index.html and reject symlinks during packaging.

## Verification and operation

Run `npm run check` and `npm test`; CI also validates both Docker images, Caddy
and Compose. Tests exercise invalid artifacts, failed CI, close/head races,
link retry, fork rejection, authenticated serving, removal and deployment
rollback when preview readiness fails.

After merging, new or updated eligible PRs with successful artifact-producing CI
receive a link automatically. Older CI runs without the artifact cannot be
previewed until CI is rerun or a new commit is pushed. Logs from the `previews`
service report PR numbers for failed updates and retry without printing secrets.
Production rollback to a version predating previews removes the service and
routes while retaining the named volume for a later redeployment.
