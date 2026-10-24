<!-- Markdown with HTML -->
<div align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://refref.ai/github-readme-header-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="https://refref.ai/github-readme-header-light.png">
  <img alt="RefRef" src="https://refref.ai/github-readme-header-light.png">
</picture>
</div>

<p align="center">
  <a href='http://makeapullrequest.com'>
    <img alt='PRs Welcome' src='https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=shields'/>
  </a>
  <a href="https://opensource.org/license/agpl-v3/">
    <img src="https://img.shields.io/github/license/refrefhq/refref?logo=opensourceinitiative&logoColor=white&label=License&color=8A2BE2" alt="license">
  </a>
  <br>
  <a href="https://refref.ai/community">
    <img src="https://img.shields.io/badge/discord-7289da.svg?style=flat-square&logo=discord" alt="discord" style="height: 20px;">
  </a>
</p>

<p align="center">
  <a href="https://refref.ai">Website</a> - <a href="https://refref.ai/docs">Docs</a> - <a href="https://refref.ai/community">Community</a> - <a href="https://github.com/refrefhq/refref/issues/new?assignees=&labels=bug&template=bug_report.md">Bug reports</a>
</p>

## Table of Contents

- [🔮 Overview](#-overview)
- [🚀 Getting Started](#-getting-started)
- [✨ Features](#-features)
- [🔰 Tech Stack](#-tech-stack)
- [🤗 Contributing](#-contributing)
- [🎗 License](#-license)

> [!CAUTION]
> RefRef is still in alpha, expect bugs and breaking changes.

## 🔮 Overview

Build powerful referral programs for your products with RefRef's open source referral management platform.

## 🚀 Getting Started

### Isolated development deployment

This checkout is a locally hardened fork of `sixmo-team/refref`, not an unchanged upstream release. Keep it as the sibling `/home/main_user/dev/refref` project with its own `refref-dev` Compose lifecycle. It does not mount, migrate or authenticate against the three existing projects.

Requirements: Docker with Compose/Buildx and host Node.js for the control script. Package installation, compilation and tests use a digest-pinned Node.js 24 container. Do not install global proxies or run an unrestricted monorepo build on the shared server.

```bash
cd /home/main_user/dev/refref
node scripts/dev.mjs init
node scripts/dev.mjs build
node scripts/dev.mjs up
node scripts/dev.mjs bootstrap
node scripts/dev.mjs status
```

`init` creates private `.local/dev.env`, `.local/test.env` and `.local/credentials.txt`, preserving existing secrets. Do not commit, copy into images or publish these files. The bootstrap command creates one verified local operator; repeated calls do not reset its password.

Open **http://127.0.0.1:4310/auth/sign-in**. Read the generated email/password from `.local/credentials.txt` on the server; they are deliberately not printed in build/startup output. Public signup, OAuth and external email delivery are disabled/unconfigured in this deployment.

For a remote workstation, replace `SERVER` with your SSH host:

```bash
ssh -N -L 4310:127.0.0.1:4310 main_user@SERVER
```

Then use the same loopback URL locally. Do not publish the port or change the origin without reviewing TLS, trusted origins, compiled public URLs and network policy.

| Local route  | Service                                               |
| ------------ | ----------------------------------------------------- |
| `/`          | Web application and Better Auth                       |
| `/tracking/` | Tracking API; for example `/tracking/v1/track/signup` |
| `/r/`        | Referral redirects                                    |
| `/assets/`   | Locally built attribution/widget scripts              |
| `/healthz`   | Gateway readiness                                     |

```bash
node scripts/dev.mjs logs
node scripts/dev.mjs down
node scripts/dev.mjs up
```

`down` stops only this Compose project and **preserves its database volume**. Migration and operator bootstrap are separate restricted one-shot jobs, not privileges given to the running web/API services.

### Configured containment

| Running service        | RAM limit, no swap | CPU limit |
| ---------------------- | -----------------: | --------: |
| Web application        |            640 MiB |      0.75 |
| Tracking API           |            192 MiB |      0.50 |
| Referral service       |            128 MiB |      0.25 |
| PostgreSQL             |            256 MiB |      0.50 |
| Gateway                |             64 MiB |      0.25 |
| **Steady-state total** |      **1,280 MiB** |  **2.25** |

Migration/bootstrap each use another 256 MiB / 0.5 CPU and run sequentially. Limits are ceilings, not measured consumption or reserved capacity.

- Runtime containers are non-root, read-only, capability-dropped and `no-new-privileges`; no Docker socket or host directory is mounted. Writable temporary directories are bounded tmpfs mounts.
- Each service has a PID limit (96; gateway 32), no core dumps, bounded file descriptors and rotated local logs (10 MiB × 3).
- Only the gateway publishes `127.0.0.1:4310`. Application/database traffic uses a dedicated internal, isolated bridge; no existing project network or volume is attached. The gateway has a separate ingress bridge.
- The gateway bounds request bodies to 256 KiB, requests to 10/second with a 40-request burst, and concurrent connections to 20 per IP. Organization API keys are independently limited to 120 requests/minute.
- PostgreSQL has separate admin, migration and DML-only application roles, constrained pools/connections, query/lock/idle-transaction timeouts, small buffers and temporary-file/WAL limits.
- A database guard stops **only this PostgreSQL** when its data directory reaches the configured 1 GiB ceiling or filesystem free space drops below 8 GiB. Its 15-second sampling is a **soft guard, not a filesystem quota**; transient overshoot remains possible.
- PostHog and the external ingestion proxy are removed. Next/Turbo/Better Auth telemetry is disabled; fonts/scripts are local. Authentication cookies use the `refref.*` namespace instead of another application's default Better Auth cookies.
- Referral links carry only an opaque `refcode`; application diagnostics redact raw SQL/errors and request query values. Invitations remain explicit failures without a configured mail provider rather than pretending delivery succeeded.

Builds require at least 3 GiB available host RAM and 8 GiB free space; startup requires 2 GiB available RAM. The dedicated serial BuildKit controller is limited to 2 GiB / 1 CPU / 384 PIDs and is stopped after success, failure or interruption. The inherited V8 heap is capped at 1,024 MiB and Next's native Webpack memory optimization is enabled. Package lifecycle scripts are disabled; compilation/deployment have no network and consume the frozen package store retained in an immutable builder layer, not a disposable cache mount.

**Build limitation:** this host disallows the unprivileged user namespaces needed by rootless BuildKit. Only the dedicated, digest-pinned build controller is privileged while building; no runtime service is privileged and no host security setting is weakened. This is not a sandbox for arbitrary hostile source code. The 4 GiB BuildKit cache GC target is not a hard disk quota; images, cache and the shared Docker daemon still need disk/headroom monitoring.

Per-container ceilings and a higher RefRef OOM score reduce interference; they cannot guarantee that unrelated services, Docker/kernel failures or a full shared filesystem will never affect the host.

### Observed verification — 2026-10-19

These are observations on this server, not capacity promises. Runtime numbers are Docker working-set samples, not reserved RAM or total host memory.

| Scenario                                | Observed result                                                                                      |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Five services idle after startup        | 186.3 MiB combined                                                                                   |
| Entire interactive verification         | 229.3 MiB combined sampled peak                                                                      |
| Real signup/purchase workload           | 80 requests, two workers, 22.20 seconds; 80 HTTP 200                                                 |
| Workload latency                        | p50 37.06 ms; p95 130.77 ms; maximum 303.98 ms                                                       |
| Workload resource samples               | 214.8 MiB combined peak; 0.402 combined CPU cores; seven complete samples                            |
| Unauthenticated burst                   | 60 requests/two workers: 40 HTTP 401, 20 HTTP 429                                                    |
| Runtime after workload                  | All five healthy; zero restarts and no OOMKilled containers                                          |
| Final successful build                  | 2,038.8 MiB sampled peak, 92.9% average of one CPU core, 126 sampled PIDs; builder stopped afterward |
| PostgreSQL data directory after cleanup | 47.9 MiB                                                                                             |

An earlier build with a 1,408 MiB V8 heap exhausted its own 2 GiB cgroup and was killed; the existing frontend/backend still returned HTTP 200. Lowering the heap and retaining the required offline package store in the builder layer produced successful complete builds without increasing the controller budget. Larger future builds can still fail inside that ceiling; move them to a separate builder/CI rather than silently removing host protections.

Actual checks covered browser sign-in/product creation/program activation, local script delivery, widget JWT enrollment, an opaque referral redirect preserving duplicate query values/fragments, signup, purchase and an identical purchase retry producing one ledger event/reward. Cross-product access was rejected; analytics accepted exactly 365 inclusive dates and rejected 366. Anonymous RPC returns 401 and an authenticated session without a selected organization returns 403.

The deployed application role successfully performed DML but an actual DDL attempt was denied. Web/API/referral containers could not reach a public IP or the host application; no host project directory/socket was visible. Captured browser HTTP requests stayed on the loopback origin. PII/key/password canaries were absent from actual runtime logs. Existing frontend/backend endpoints returned HTTP 200 before and after the bounded workload.

Verification keys were revoked and synthetic products, events and rewards removed afterward. The private operator account and persistent database volume remain; no real-user data was connected.

After removing 19 obsolete image tags created during this deployment and all owned probe directories, the shared filesystem had approximately 47 GiB available and the host reported 7,344 MiB available RAM (no swap). The existing connector remained healthy. These point-in-time headroom figures are not reservations for RefRef.

### Bounded development checks

```bash
# Frozen installation; --update is only for an intentional dependency update.
node scripts/dev.mjs prepare
node scripts/dev.mjs audit --prod
node scripts/dev.mjs audit

# Resets only the disposable refref-test database and applies versioned SQL.
node scripts/dev.mjs testdb
node scripts/dev.mjs run corepack pnpm --filter @refref/webapp exec vitest run --root /workspace --config /workspace/vitest.security.config.ts
node scripts/dev.mjs run corepack pnpm --filter @refref/better-auth test
node scripts/dev.mjs run corepack pnpm --filter @refref/attribution-script test

# Release the disposable test database/network after checks.
docker compose --env-file .local/test.env -f compose.test.yml down
```

The `run` helper has a 1,536 MiB / 1 CPU / 256 PID ceiling, receives only the disposable test credentials and masks the real `.local` directory. It intentionally mounts only this checkout and its own build cache. Do not point tests at the deployed database or use the upstream port-killing E2E cleanup script on this shared server.

The locked production closure currently has no known audit advisory. Full tooling audit still reports unpatched `braces` (high), `vue-template-compiler` and `sprintf-js` (moderate), confined to development/build dependency chains rather than shipped runtime dependencies. A clean audit is not a malware or future-vulnerability guarantee.

### Future integration with the marketing applications

Develop the RefRef fork independently, like a separate source-owned service. Later, include pinned built images in the main deployment if one-command lifecycle management is useful; that does not require merging source trees, databases or credentials.

Integrate through explicit backend-to-backend APIs and organization-scoped service keys. Legacy organization-wide keys retain their existing scope; the financial resolve/purchase contract below requires dedicated product/program-scoped permissions and metadata. Keep credentials out of the mobile/web client, define tenant/external-user mappings and any narrower backend authorization deliberately, and expose only the required gateway route. There is no automatic shared SSO or direct database access. The server is AGPL-3.0; review the license before distributing or externally offering an integrated derivative.

## ✨ Features

- **Referral Attribution**: JS snippet for tracking referrals, enabling accurate attribution of referrals to referrers

- **Customizable Rewards**: Flexible reward system for different referral programs

- **Referrer Portal**: UI components for referrers to refer and track rewards

- **Partner Portal**: Dedicated interface for affiliates

- **Personalized Pages**: Automatic personalization of referral landing pages

- **Nudges**: Automated reminders to boost referral engagement

- **Fraud Monitoring**: Detect and prevent fraudulent referral activity

- **Manual Reward Approval**: Review and approve rewards manually

- **Automatic Reward Approval**: Set rules for automatic reward validation

- **Manual Reward Dispersal**: Control when rewards are sent out

- **Automatic Reward Dispersal**: Schedule automated reward payments

- **Engagement Analytics**: Track referral program performance metrics

- **Testing Environment**: Sandbox for testing referral programs

## 🔰 Tech Stack

- 💻 [Typescript](https://www.typescriptlang.org/)
- 🚀 [React](https://react.dev/)
- ☘️ [Next.js](https://nextjs.org/)
- 🎨 [TailwindCSS](https://tailwindcss.com/)
- 🧑🏼‍🎨 [Shadcn](https://ui.shadcn.com/)
- 🔒 [Better-Auth](https://better-auth.com/)
- 🧘‍♂️ [Zod](https://zod.dev/)
- 🐞 [Vitest](https://vitest.dev/)
- 🗄️ [PostgreSQL](https://www.postgresql.org/)
- 📚 [Fumadocs](https://github.com/fuma-nama/fumadocs)
- 💽 [Drizzle](https://drizzle.dev/)
- 🌀 [Turborepo](https://turbo.build/)

## 🤗 Contributing

Contributions are welcome! Please read the [Contributing Guide][contributing] to get started.

- **💡 [Contributing Guide][contributing]**: Learn about our contribution process and coding standards.
- **🐛 [Report an Issue][issues]**: Found a bug? Let us know!
- **💬 [Start a Discussion][discussions]**: Have ideas or suggestions? We'd love to hear from you.

# 🎗 License

Released under [AGPLv3][license].

<!-- REFERENCE LINKS -->

[contributing]: https://github.com/refrefhq/refref/blob/main/CONTRIBUTING.md
[license]: https://github.com/refrefhq/refref/blob/main/LICENSE
[discussions]: https://discuss.refref.ai
[issues]: https://github.com/refrefhq/refref/issues
[pulls]: https://github.com/refrefhq/refref/pulls "submit a pull request"

## First-referral-payment tracking (activation gated)

The native Single-Sided and Double-Sided templates own their descriptors, validation, form capabilities, mapping and rule specifications in separate modules behind the existing typed static registry. They share native controls, money primitives and one `@refref/coredb` reward engine; there is no plugin loader or rule DSL. Affiliate remains unavailable. RUB is added alongside USD/EUR/GBP; existing reward decimal/currency fields are not migrated or converted. Identical saves retain rule IDs.

`firstPaidOnly` is a programme condition, not a global RefRef restriction. False-policy programmes can reward distinct repeated purchases, including after another programme claimed the participant's first purchase. The current AI-marketer integration remains first-paid-only; its new percentage commissions require `payable_amount`, the actual confirmed payment after discount. Other programmes and already accepted historical bases are preserved.

Discount and commission are independent. A buyer-only programme has an explicit financial currency and `commission: {basis: null, rules: []}`, not a synthetic zero reward. C1 resolution now supplies currency independently of cash rules. A complete empty purchase ACK is valid only for an empty frozen rule set; missing expected cash results still fail. Disabling a side omits it from saved settings.

Reward-only saves retain existing custom widget design and unrelated custom rules. Legacy V1 keeps its original percentage-base behavior: absent or explicit-zero input gives zero at the API boundary and the configured flat fallback at the web boundary. V2 exact minor-unit calculations are separate. Rejected legacy processing marks only a still-pending V1 event failed. V1 unknown customer fields remain ignored rather than mutating profiles; V2 customer updates remain atomic with the protected purchase.

Legacy rule currencies use a supported explicitly configured currency, otherwise the former USD default; purchase metadata cannot introduce an invalid currency into a reward. This fallback is only legacy compatibility: malformed V2 currencies are rejected by the strict financial contract, not guessed.

Protected gateway operations are `POST /tracking/v1/referrals/resolve` and the existing `POST /tracking/v1/track/purchase`. The maintained contract is served at `/tracking/openapi` from `apps/api/openapi.yaml` (OpenAPI 3.0.3). Resolve is a read-only business lookup. V1 purchase keeps `orderAmount` in major units for unrelated legacy programs; V2 uses explicit `orderAmountMinor`, customer name/email and the full accepted snapshot. V2 atomically records participant/profile, exact code attribution, first-purchase claim, event and complete frozen commission results. Its ACK includes actual native `codeId`, `customerExternalId`, linked IDs and rule/config results; processed is not approved or paid out. Customer profile changes do not change purchase replay identity. No-code purchases and renewals are not an all-sales report in Activity.

Create a dedicated integration key in organization settings with an explicitly authorized product/program. Its native permissions are `referrals: ["resolve", "purchase"]` and metadata `referralScope: {productId,programId}` in addition to verified organization ownership. It cannot access other operations. No widget token or browser session authorizes a confirmed sale. The extended SDK source is not a newly published artifact: inspect/build/package a version before adopting it in another repository; the backend may use its independently validated bounded client.

### Business and ownership approval

First-paid, Double-Sided and opted-in server-tracking programs require explicit activation approval. Ordinary Single-Sided V1 programs retain their original automatic activation after setup; existing approval/inactive/archived states are not bypassed. Configure actual rates, currencies, commission basis and any dates/minimums; none is supplied as an approved business default. Calculation version 1 uses exact nonnegative decimal/rational arithmetic and rounds half-up once at the final minor boundary. Fixed native amounts have at most two decimals; percentages at most six. Review examples before approval: `1 minor × 50% = 1`, `3 × 50% = 2`, `101 × 2.5% = 3`. Changed saved terms invalidate financial approval. The backend separately proves lifetime first-payment eligibility, including purchases without codes; a RefRef participant is not proof of paid or never-paid.

An organization administrator must independently verify that the native participant belongs to an email-verified, non-service **RefRef person**, and separately verify transfer recipient details, recording a bounded evidence reference through the native Payouts screen. A referrer needs no AI-marketer backend account or subscription; invited buyers are backend customers, not a required identity for their referrer. Email similarity, signup/widget tokens and client-supplied participant IDs are not ownership proof. Linking ownership grants no organization membership. Existing verified ownership cannot be reassigned through this API. Actual G1 values/edge approval and G3 ownership evidence remain required before real activation; the current marketing programme's net-paid percentage basis G2 is settled above.

### Own earnings and manual payouts

`/participant-portal` is the session-authenticated own-participant portal, outside the organization-onboarding gate. `/payouts` is the administrator interface with an explicit authorized product selection. The available balance is approved cash earnings minus completed payouts and requested/processing reservations, separately per product/participant/currency. Pending/rejected/discount and legacy disbursed earnings are not withdrawable. Partial withdrawal does not mark a whole reward disbursed.

Legacy `pending_disbursal` cash still requires the existing administrator **Approve Reward** action before it becomes withdrawable; verified ownership does not remove that action. Four-currency balances use two native grouped queries, without a balance cache. Successful own payout requests invalidate native administrative list keys for their originating product as well as own summary/history, so returning to a fresh cached list shows the new request without a reload.

Ownership-linked cash uses the payout workflow, but approved legacy noncash discounts retain their existing **Mark as Disbursed** action. Completing such a discount does not consume, reserve or disburse the participant's approved cash balance.

Programs, Activity, Rewards and Payouts use an explicit authorized product; record reads verify the current user/organization and the record's actual product. Only the unchanged, no-input analytics program list retains its legacy first-product behavior. Native Better Auth membership gates privileged cached content. Financial query ownership is released on scope departure, and a denied related read remains hidden until all required reads positively recover; an unrelated success or transient error cannot revive cached private data.

Editor/setup/table keys contain stable identity and product/program scope, not a transient membership-loading/role flag. Loading the native active member must not discard an unsaved reward draft; native positive-admin and denied-read barriers still hide privileged data when authority is uncertain.

Configure `PAYOUT_MANUAL_EXECUTION_NAMESPACE` on the webapp before claiming a payout. This is the verified executing-account namespace for external-reference uniqueness, not a fabricated bank account or a client-selectable provider. One operator claims a request; one full manual execution may be confirmed with the exact amount/currency/reference/time. Confirmation only records a transfer already executed outside RefRef: it never sends money. Before transfer, verify actual originating payment and absence of a refund/dispute in the backend/bank. Unknown transfer outcomes stay processing without expiry, retransmission or reserve release. No refund adjustment, outbox, delivery worker, automatic retry or online payout-provider framework is added.

Native Turbo `globalPassThroughEnv` forwards `PAYOUT_MANUAL_EXECUTION_NAMESPACE` to strict-mode tasks without embedding its runtime value in the build cache. A configured host environment value must not silently disappear when starting the webapp through Turbo.

Migration `0004_first_payment_and_payout` extends the native Drizzle history with scoped financial FKs, immutable snapshots/claims/ownership and the native payout table. Ambiguous legacy financial links cause an explicit migration failure requiring reviewed remediation, never deletion or fabricated attribution. Financial history is retained; rollback must not erase accepted facts.

That unapplied cutover also narrowly canonicalizes the actual old template producer's V1 `percentage` unit to `fixed`, preserving the former engines' flat economic meaning, not converting it to a percentage or rewriting rewards. Purchase participant serialization uses native `FOR NO KEY UPDATE`, retaining first-purchase exclusion while allowing reciprocal-referrer foreign-key checks.

The optional `docker-compose.referrals.yml` links only the existing gateway to an operator-created **internal** external network named `refref-billing`, alias `refref-gateway`. The backend uses `http://refref-gateway:8080/tracking`. Databases, roles, mounts and stacks remain independent; existing resource, read-only/non-root and loopback-port restrictions remain. Including the override is opt-in, not a requirement for ordinary checkout or RefRef startup.

### Acceptance without resetting existing services

Run checks sequentially through the bounded `scripts/dev.mjs run` helper. **Do not run `testdb` while retaining an existing test stack: that command resets the disposable stack.** Instead, start/preserve `compose.test.yml`, create a new uniquely named database in `refref-test-db`, select that database in both `DATABASE_URL` and `TEST_DATABASE_URL`, and apply `pnpm --filter @refref/coredb db:migrate`. Never point these checks at the deployed database or print/copy `.local` secrets.

`NEXT_PUBLIC_*` values, including the Better Auth client origin, must be supplied when building the webapp. A different runtime-only value cannot replace a compiled public URL; rebuild for the intended verification/deployment origin.

The latest code-first regression audit executed the native security/finance suite (111 tests), API suite (22), SDK suite (21), ID behavior suite (28), all 20 root typecheck tasks and all 14 production build tasks. Use `--maxWorkers=1` for RefRef Vitest. Separate disposable databases exercised native migrations and authenticated HTTP/UI paths.

Fresh native Next/Better Auth/tRPC/PostgreSQL smoke recorded synthetic verified ownership, completed an approved legacy discount through its real row action, retained the approved cash balance and refused an unauthorized product selection without fallback. Earlier role-loading draft, setup/Activity, C1 and payout-cache UI series remain identified separately in the report; they were not all rerun in this audit. No bank transfer, real identity verification or user-stack deployment was performed.

The SDK was built, packed and exercised outside the workspace through public ESM/CJS imports, real read-only resolve and 21 served OpenAPI/SDK contract cases. It was not published. An additional `skipLibCheck=false` external consumer still reports two upstream Better Auth SQLite declaration errors; the normal SDK/root checks above are distinct. Full E2E TypeScript additionally reports four unchanged unused parameters in preexisting unimplemented ACME page helpers; the full ACME browser journey is not claimed.

Detailed coordinated evidence, independent source-review attribution and A01–A28 boundaries are recorded in the sibling `ai-backend-marketing-agent/docs/superpowers/reports/2026-10-21-referral-first-payment.md`. Android and iOS Hermes JavaScript exports passed separately; native device interaction, live bank, deployed OpenBao/network and representative historical-money migration gates remain unverified. Root lint is not green: some packages lack their ESLint executable/configuration; available webapp/source lint completes with warnings, without disabling rules. Disposable smoke scaffolds and credentials are not production files or permanent acceptance commands.
