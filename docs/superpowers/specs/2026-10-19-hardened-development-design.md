# Hardened RefRef development deployment

## Intent and ownership

The operator approved fixing the reviewed revision and deploying it on the shared development server. There are no real end users, but RefRef must not exhaust resources or expose the other three projects. RefRef will be developed as a separate sibling fork, like Open Connector's source ownership, not installed as a backend/mobile npm dependency. Its lifecycle initially belongs to a separate `refref-dev` Compose project. Backend and mobile business integration, SSO and shared-network access are outside this change; later integration must go through the backend and tenant-scoped RefRef APIs, never mobile-held service secrets or shared database tables.

## Required behavior

- A session or organization API key must never read/write another product's participants, events, programs, referrals, rewards or signing secrets. Validate all supplied related IDs against the authorized product. Keep authenticated read/write capabilities unless privilege is specifically required for invitations, credentials or account administration.
- Analytics accepts valid date-only ranges of at most 365 days inclusive; malformed, reversed or oversized ranges fail before querying/allocating rows.
- Invitation recipients must prove mailbox ownership; only organization owners/admins may list invitation bearer IDs. Do not permit direct email profile updates to retain verification of a different mailbox.
- Upgrade vulnerable dependencies and migrate API-key imports/schema to the maintained Better Auth contract. No ignored high/critical findings in the shipped runtime dependency closure. Report any remaining excluded tools separately rather than calling them clean.
- Purchase retries must not create repeated ledger rewards; attribution must remain product-scoped. Use database-enforced identity for repeated business events where needed, not an in-memory cache.
- Remove application PostHog integration and proxy routes, avoid runtime third-party script/font origins, and keep necessary attribution/widget assets on the local same-origin gateway. Do not send login/invitation URLs or participant PII to logs or public redirects. Referral URLs preserve existing query strings and fragments and carry only the opaque referral code.
- Keep email/OAuth off in this isolated local deployment. Missing mail credentials fail explicitly before network calls. Provide an operator-only local account bootstrap for verified development access; never weaken normal invitation verification or add hardcoded runtime identity.

## Containment

- Build with one worker, at most 1 CPU and 2 GiB RAM, no swap allocation and a bounded PID budget. Do not modify the host daemon limits, global builder selection, other services, sysctls or swap. Block starting a build if current host headroom is inadequate.
- Runtime maximum aggregate memory budget: 1536 MiB. Initial allocation: webapp 640 MiB, API 192 MiB, redirect 128 MiB, PostgreSQL 256 MiB, gateway 64 MiB; total 1280 MiB. One-shot migration/bootstrap tasks run sequentially, not in parallel with builds.
- Separate PostgreSQL instance, database, least-privilege runtime role, migration owner, random credentials and named data volume. No database host port; no automatic demo seeding or schema push at every application startup.
- Web/API/redirect containers run non-root with read-only roots, no capabilities, no-new-privileges, bounded tmpfs/PIDs/CPU/logs, no Docker socket or host-source mounts. The gateway binds only `127.0.0.1:4310` and serves UI, tracking API, redirects and locally built assets. Application/database networks are not shared with the existing stack. Block application internet egress on the runtime internal network.
- Bound SQL connection counts, statement timeouts, temporary files and WAL; apply HTTP request/concurrency limits at the gateway. Limit container log rotation. Ordinary Docker volumes on this host do not provide a hard data-size quota: document that limitation and add disk/headroom guards rather than claiming a fictional quota.
- Secrets are generated into ignored owner-only local files, never printed, committed or passed as build args. No host-wide credentials are mounted into builds or runtime.

## Verification and delivery

First demonstrate failing behavioral regressions against the reviewed source in a bounded isolated test environment, then fix. Heavy installs/builds/tests/typechecks run sequentially. Tests must exercise real query authorization/validation and HTTP-visible outcomes, not source text or mock echoes. Use an isolated test database only.

Acceptance includes successful local sign-in and core product/program flow, working API/redirect/static asset paths, rejection of cross-tenant requests and unsafe ranges, no PII in redirect/query/log flows, resource/security settings observed through Docker inspection, failed outbound-connectivity probes from application containers, and a bounded load run while the existing frontend/API remain available. Compare current health to the pre-existing baseline, including the already-unhealthy OpenBao TLS proxy. Produce commands for build/start/stop/logs/bootstrap and measured idle/load consumption. Do not claim zero risk or production readiness from a development smoke run.
