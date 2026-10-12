# PR preview deployment plan

Status: proposal only; no workflows or infrastructure are changed by this plan.

## Recommendation

Start with an automatic, isolated web preview for each same-repository PR targeting
`main`, at `https://pr-<number>.preview.agentle.cc`. Deploy after CI succeeds,
refresh on new commits, and remove on close or merge. Show the URL and tested
commit in a GitHub deployment status. This supports testing Songspot and other
web changes before merging without giving PR code access to the live controller.

Use a separate preview VPS with a trusted reverse proxy and preview-only state.
A shared staging slot would cost less operational effort but concurrent PRs would
overwrite each other. Per-PR previews keep links stable and let multiple changes
be tested independently. Cap concurrent previews and expire inactive instances
to bound resource use; report capacity failures instead of evicting active PRs.

## Fit with this repository

- `.github/workflows/ci.yaml` already runs TypeScript checks, tests, both Docker
  builds, Caddy validation and Compose validation on PRs.
- `scripts/github_host.py` and `scripts/deploy-entry.sh` deliberately accept only
  tested current-main commits. Keep that production gate intact.
- `compose.yaml` uses fixed production ports, credential mounts and durable data
  paths. Do not use it for previews or mount its data into a preview container.
- `web/Dockerfile` embeds the production Caddyfile. That configuration names
  `agentle.cc` and depends on a dashboard backend holding a controller token.
  A preview needs a separate, trusted serving configuration.

## CI and deployment flow

1. Extend the unprivileged PR `test` job to package `web/` as an artifact only
   after all existing checks succeed. Record the workflow run ID, run attempt,
   PR head SHA and tested merge SHA. GitHub's PR checkout tests a merge commit;
   display both SHAs so the owner knows exactly what was tested.
2. Add a default-branch `workflow_run` workflow for completed CI runs. It must
   verify success, the workflow identity, repository, `pull_request` event, open
   PR targeting `main`, and same-repository origin using GitHub API metadata.
   Reject forks initially. Agentle-authored PRs remain eligible: Ash42Z is the
   request authority, but the controller may be the PR author.
3. The privileged workflow uses only trusted default-branch deployment code.
   It does not check out or execute PR code, PR scripts, Dockerfiles, or artifact
   contents. Download the artifact from the verified run and transfer it as data
   with a preview-only restricted credential. Use minimal token permissions:
   contents/actions read and deployments write; add PR write only if posting a
   comment is later desired. Never reuse production deployment secrets.
4. A host-owned preview service independently validates the PR/run association,
   run attempt, artifact identity, SHAs and current PR head. Ignore identity
   claims inside the artifact. Reject absolute paths, traversal, symlinks,
   unexpected file types and oversized archives before extraction. Serve files
   using a pinned trusted web image and host-owned configuration, rather than
   the PR's Dockerfile or Caddyfile.
5. Serialize updates and deletion under a per-PR lock. Build/stage a candidate
   before switching traffic, probe its expected release and routes, then
   atomically change the trusted proxy upstream. Preserve the prior working
   preview on failure. Revalidate the current head immediately before activation
   and publishing success; a late old run must not replace a newer deployment.
6. Publish deployment success with the HTTPS URL and tested SHAs, or failure with
   useful logs. Avoid secrets in logs. A successful CI run with a failed preview
   must remain distinguishable from a successful deployment.
7. A trusted PR-close handler removes the route, container and preview data and
   marks the deployment inactive. It never checks out PR code. A scheduled
   reconciler catches missed close events, stale releases and expired previews;
   re-check PR state under the same lock so a late deployment cannot resurrect a
   closed preview. Reopening triggers a fresh checked deployment.

GitHub warns that `workflow_run` and `pull_request_target` can expose secrets when
they execute untrusted PR content. The split above keeps the privileged workflow
limited to validation and data transfer. See GitHub's
[secure use guidance](https://docs.github.com/en/actions/reference/security/secure-use).

## Preview runtime boundaries

- Configure wildcard DNS for `*.preview.agentle.cc` to the preview host. Use
  wildcard TLS through DNS validation, or individual certificates with issuance
  limits accounted for. Keep DNS credentials in the trusted proxy service.
- Require a separate preview login at the proxy, before serving any PR content;
  the repository is private. Do not share production cookies, passwords or
  tokens. Use host-only cookies and avoid parent-domain cookies. Do not place
  a credential-bearing dashboard backend behind PR JavaScript.
- Each PR gets a separate internal network and disposable content directory;
  the trusted proxy is the only public listener. Set CPU, memory, disk and process
  limits, use a read-only filesystem where possible, and mount no Docker socket,
  controller configuration, subscription session, production database or workspace.
- A trusted preview Caddy configuration serves the artifact and reproduces the
  fixed Deezer routes. Controller routes are unavailable. A fixture-only backend
  supplies synthetic dashboard status and conversation responses so dashboard UI
  changes can be tried; clearly label fixture data in the preview.
- This first phase validates web behavior, not live worker execution, dashboard
  authentication changes, controller readiness or changes to production routing.
  Continue checking the production Caddyfile in CI. Additional services need
  explicit trusted preview templates rather than arbitrary Compose execution.

## Controller testing as a second phase

For controller PRs, use a separate disposable VM and sandbox repository, with a
separate GitHub App installation and subscription-authenticated Codex account.
Never poll the production repository or copy production SQLite/workspaces.
Start drained and enable processing only for sandbox requests from Ash42Z.
Keep thread IDs and workspaces across interruption/quota retries within that
sandbox; clean them only on deliberate teardown after work has stopped.
There is no API-key fallback.

Full controller updates must retain the production deployment guarantees:
build before drain, bounded drain with safe abort/resume, exact-release readiness,
rollback to the prior release after failure, and additive state migrations
compatible with that release. Test migration compatibility using synthetic data.
Prefer one controlled controller staging environment initially; automatic live
controllers for every PR multiply account, job and credential management.

## Implementation and acceptance checks

1. Provision the preview host, DNS/TLS and independent access credentials; move
   production deployment secrets into the production environment so PR workflows
   cannot request them as repository-scoped secrets. Verify environment policies
   against the repository's GitHub plan before enabling automatic deployments.
2. Implement the trusted serving template, fixture backend, host validator and
   archive handling. Test malformed archives, metadata mismatches, fork rejection,
   resource limits and absence of production mounts/credentials.
3. Add artifact publication, deployment reporting and lifecycle workflows.
   Test success, failed CI, failed readiness retaining the old preview, concurrent
   commits arriving out of order, close/deploy races, reopen and missed-event
   reconciliation. Run `npm run check` and `npm test` for controller changes.
4. Smoke-test HTTPS/login, Songspot search/catalog/audio, dashboard fixtures and
   expected release identity on two simultaneous PRs. Confirm production is
   unaffected and closing one PR removes only its own resources.

Infrastructure setup is the prerequisite for implementation. No preview host,
DNS access, environment configuration or subscription sandbox has been verified
as available. Start with web previews; add controller staging when needed.
