# Hardened RefRef Development Implementation Plan

> Execute in the existing dedicated RefRef checkout on a new local branch. The operator already approved implementation of the five hardening/deployment steps. Do not touch backend/mobile/Open Connector source, discard their changes, commit, push or publish.

**Goal:** Run the developed RefRef fork locally without inheriting access to the other applications or unlimited shared-server resources.

**Architecture:** Independent `refref-dev` Compose project with webapp, API, redirect, isolated PostgreSQL and a same-origin loopback gateway serving the built JS assets. Source ownership stays in the sibling fork; no speculative backend/mobile business integration.

**Tech Stack:** Existing TypeScript/pnpm/Next/Fastify/Drizzle/PostgreSQL. Maintained Better Auth with its maintained API-key plugin, existing Vitest conventions, Docker Compose/Buildx and Nginx.

**Spec:** `../specs/2026-10-19-hardened-development-design.md`.

## Global constraints

- Build: one worker, 1 CPU, 2 GiB hard RAM, no swap, bounded PIDs; run expensive commands sequentially.
- Runtime: aggregate service RAM caps <=1536 MiB; only `127.0.0.1:4310` is published; no existing Docker network, database, volume, socket or project mount.
- No external telemetry/OAuth/mail by default; no hardcoded runtime user identity; secrets are ignored, owner-only and never printed.
- No installation hooks or remote root installer scripts. Current LSP reports no server configured: scoped reference searches are the available fallback.
- Existing unrelated working-tree changes are the operator's and must remain untouched.

## Review focus

1. Mixed product/program/participant/referral IDs must fail before writes even when each ID individually exists.
2. Anonymous sessions, ordinary members, owners and organization API keys must be distinguished correctly; no invitation token or signing-secret exposure to unauthorized actors.
3. Explicit date ranges cannot bypass the days bound; equal endpoints, leap days, malformed and reversed dates have defined bounded behavior.
4. Retry/concurrency must not duplicate purchase ledger effects or attribute an order to another tenant with the same external user ID.
5. Disabled integrations must not break signup or perform network/log/PII side effects; isolation and resource constraints must be inspected at runtime, not inferred from YAML.

## Task 1: Behavioral regression baseline

**Owners/files:** security implementer owns new regression files under `apps/webapp/src/server/api`, `apps/api/test`, `packages/auth`, and directly required test utilities. Privacy implementer owns redirect regression updates under `apps/refer/test` and any privacy-specific tests. Parent owns dependency installation, resource-constrained execution and the isolated test database.

- Write failing authorization/date/invitation/email and redirect-privacy regressions first; report exact commands/files to parent before modifying implementation.
- Parent installs the reviewed lock with scripts disabled in a non-root, resource-limited container with only RefRef source/cache mounted, then runs those selected regressions sequentially against a disposable RefRef-only database.
- Distinguish a genuine failing security assertion from dependency/config errors; resolve setup errors before accepting a red baseline.
- No source-text assertions, duplicate mock echoes or test code that connects to an existing database. Tests use isolated generated identities and multi-product cases.

## Task 2: Authentication, authorization and bounded business operations

**Owner:** security implementer.

**Files:** `packages/auth/src/index.ts`; API-key client/server imports and schema required for the maintained plugin; `packages/coredb/src/schema.ts` and migrations if replay identity requires it; `apps/webapp/src/lib/auth.ts`; relevant webapp routers/context; API authentication/routes/event processing; their regressions.

- Scope participant lists/counts/details and arbitrary-user lookups. Validate event product/program/participant/referral relationships against verified session/product scope before insert/reward processing.
- Scope organization-key program/signup/purchase operations to `request.organization.id`; carry validated product scope into shared event handling. Product-scope referral attribution. Make purchase retries database-idempotent with verified payload identity; do not silently accept conflicting retries.
- Enforce valid inclusive date ranges <=365 days before database operations and array allocation.
- Require verified invitation recipients, restrict bearer invitation lists and signing credentials to administrators, and prevent direct profile email verification bypass. Preserve the normal verified-email change contract.
- Remove auth factory telemetry config/capture and sensitive URL/email logging as coordinated with privacy owner; explicit missing-mail configuration errors precede sending. Do not modify dependency package manifests/lock (parent owns those).
- Adapt Better Auth API-key imports/client/schema to the maintained package rather than adding compatibility shims. Any bootstrap path is operator-only and does not weaken HTTP signup/invitation rules.
- Parent reruns regressions and then existing suites after all edits are integrated.

## Task 3: Privacy and same-origin assets

**Owner:** privacy implementer.

**Files:** `apps/webapp/next.config.ts`, `instrumentation-client.ts`, `src/app/layout.tsx`, PostHog provider/server modules and `src/env.ts`, relevant env example; `apps/refer/src/routes/r.ts` and redirect tests; email-template remote logo references if present.

- Delete unused PostHog integration/proxy routes and migrate every reference. Security owner edits shared auth factory and `src/lib/auth.ts`; message that owner rather than editing those files.
- Configure same-origin `/assets` script loading and locally bundled fonts, with no default visitor-localhost or external CDN. Parent handles asset build URL/gateway and standalone Next deployment settings in the owned config after the privacy edit is delivered.
- Referral redirect URLs retain pre-existing query/fragment and expose only opaque referral code; remove encoded PII/participant IDs.
- No repository-wide marketing-site rewrite or speculative feature removal. Remove stale telemetry env instructions for the deployed webapp.

## Task 4: Dependency remediation and bounded build

**Owner:** parent; all package manifests, lock, workspace/turbo config and deployment artifacts.

- Resolve published maintained stable versions from npm; upgrade Next, Better Auth/API-key, Fastify and vulnerable build tooling deliberately. Re-audit production and full locks and resolve high/critical issues in shipped closures; do not use advisory suppression as a fix.
- Remove Infisical wrapper downloads/fallback scripts from the deployed/build path; use explicit environment inputs.
- Add a dedicated Buildx container builder with memory/CPU options and `worker.oci.max-parallelism=1`; do not change global builder selection. Set a bounded PID limit, log rotation and cache GC, and verify actual container settings before builds.
- Build dependency packages serially. Produce Next standalone and pruned API/refer deployment directories and the gateway's local assets; runtime images have no package-manager startup or dependency installation.
- Use pinned base-image digests and local source revision tags. Stop the dedicated builder after image creation to release its resources.

## Task 5: Isolated local deployment

**Owner:** parent.

**Files:** root Dockerfiles/Compose, `infra` configs/init SQL, `scripts` local build/start/bootstrap helpers, ignored local secret directory, README/changelog.

- Generate random local credentials without output; provision one PostgreSQL instance with separate migration/runtime roles and no existing DB connection. Use explicit one-shot migrations and minimal required event definitions, never demo seed data.
- Deploy non-root restricted webapp/API/refer/gateway containers within the aggregate memory budget, bounded CPU/PIDs/tmpfs/logs. PostgreSQL must use its dedicated non-root image user after volume initialization, with small connection/work/temp/WAL limits.
- Gateway publishes only loopback 4310, serves `/assets`, proxies `/tracking` to API and `/r` to redirect, and enforces body/rate/connection/time limits. No app port or DB port is published directly.
- Provide explicit verified development-account bootstrap with generated credentials saved in an ignored owner-only file. No secrets in images, source, logs or command output.
- Add host headroom/disk guards; document Docker-volume disk-quota limitations instead of changing shared filesystem configuration.

## Task 6: Integrated verification and documentation

- Run selected regressions, existing workspace tests and typechecks serially in the bounded environment; name any failures and fix affected contracts rather than re-pinning incidental wording.
- Run an independent security/quality review of the integrated diff and address actionable findings.
- Launch the actual local UI, sign in with the operator-created dev account, exercise product/program creation and API/redirect/asset paths; inspect real browser output and close the verification tab afterward.
- Inspect actual Docker limits, user, capabilities, mounts, network memberships, restart policy and loopback binding. Probe blocked external access from application containers.
- Run a finite low-concurrency load check, record idle/peak memory and response outcomes, and verify existing frontend/API health before/after. No uncontrolled stress/OOM test on the shared server.
- After smoke proof, update README/changelog with ownership, limitations, commands, credentials-file location and observed resource figures. Remove temporary verification scaffolding and stop only temporary resources created by this task; keep the requested local deployment running if healthy.
