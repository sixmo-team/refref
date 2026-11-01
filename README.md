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
- The gateway bounds request bodies to 256 KiB and concurrent connections to 20 per IP. Dynamic/authenticated/API routes retain 10 requests/second with a 40-request burst. Next static files and published `/assets/` bundles use a separate 10/second, 120-request-burst zone (one additional 1 MiB zone), so cold loading cannot consume the sign-in/API budget. Organization API keys are independently limited to 120 requests/minute.
- PostgreSQL has separate admin, migration and DML-only application roles, constrained pools/connections, query/lock/idle-transaction timeouts, small buffers and temporary-file/WAL limits.
- A database guard stops **only this PostgreSQL** when its data directory reaches the configured 1 GiB ceiling or filesystem free space drops below 8 GiB. Its 15-second sampling is a **soft guard, not a filesystem quota**; transient overshoot remains possible.
- PostHog and the external ingestion proxy are removed. Next/Turbo/Better Auth telemetry is disabled; fonts/scripts are local. Authentication cookies use the `refref.*` namespace instead of another application's default Better Auth cookies.
- Referral links carry only an opaque `refcode`; application diagnostics redact raw SQL/errors and request query values. Invalid or foreign invitations remain errors. Native auth-mail responses acknowledge requests, not confirmed delivery; configuration/provider failures are handled with redacted diagnostics.

Builds require at least 3 GiB available host RAM and 8 GiB free space; startup requires 2 GiB available RAM. The dedicated serial BuildKit controller is limited to 2 GiB / 1 CPU / 384 PIDs and is stopped after success, failure or interruption. The builder V8 old-space allowance is 1,024 MiB; the current dependency graph exhausted the 2 GiB cgroup with 1,408 MiB. Repeated full-root builds with 1,024 MiB completed, including fresh webapp compilation, TypeScript and tracing; they still reached the cgroup ceiling, so this is not a memory-headroom or capacity guarantee. The installer helper and runtime heaps/limits are unchanged. Next's native Webpack memory optimization and full type checking remain enabled. Package lifecycle scripts are disabled; compilation/deployment have no network and consume the frozen package store retained in an immutable builder layer, not a disposable cache mount.

**Build limitation:** this host disallows the unprivileged user namespaces needed by rootless BuildKit. Only the dedicated, digest-pinned build controller is privileged while building; no runtime service is privileged and no host security setting is weakened. This is not a sandbox for arbitrary hostile source code. The 4 GiB BuildKit cache GC target is not a hard disk quota; images, cache and the shared Docker daemon still need disk/headroom monitoring.

Per-container ceilings and a higher RefRef OOM score reduce interference; they cannot guarantee that unrelated services, Docker/kernel failures or a full shared filesystem will never affect the host.

### Independent RefRef authentication mail (opt-in only)

Authentication mail now uses RefRef's own `@aws-sdk/client-sesv2` transport directly at `https://postbox.cloud.yandex.net`, region `ru-central1`. Verification, password reset, optional magic-link and organization invitation emails use their native Better Auth callbacks and purpose-specific templates. No AI/backend mailer, credentials, database or identity is shared.

Set server-only `REFREF_POSTBOX_FROM` to RefRef's approved, Postbox-verified sender. Supply **both** `REFREF_POSTBOX_ACCESS_KEY_ID` and `REFREF_POSTBOX_SECRET_ACCESS_KEY` (optional `REFREF_POSTBOX_SESSION_TOKEN`), or leave all three absent and deliberately provision the official Node credential chain for this workload. Partial explicit credentials fail closed; there is no default sender or debug delivery. Never put secrets in `NEXT_PUBLIC_*`, images, source control or another service's configuration. The `.env.example` files contain blank names only, not credentials.

The default hardened deployment remains unchanged: signup stays disabled and web/API have no outbound connectivity. `docker-compose.mail.yml` is an explicit, separate operator opt-in layered over `docker-compose.yml`; the control script does **not** load it automatically. It requires Docker Compose support for `!reset`, attaches only webapp/API to `mail-egress`, restores their normal DNS resolution and preserves the internal database network, non-root users, read-only filesystems and all resource/security limits. It publishes no ports and does not connect to the backend. This is a service-level egress boundary, **not** a destination firewall: apply host/network policy permitting required DNS and HTTPS to Postbox before production use. If using workload credential-chain credentials instead of explicit keys, separately provide that workload's authorized credential source; the overlay does not mount host credential files or borrow another application's environment.

Partner entry uses `/participant-portal/join/[programId]` and native `/auth/sign-up?redirectTo=<encoded internal entry>` or `/auth/sign-in?redirectTo=…`. The same-origin return is preserved through verification/resend and native password reset; it carries programme context only, never AI credentials or an authorization grant. `/auth/email-verification` provides native email-link resend (not OTP). General merchant login and `/accept-invitation/[id]` remain separate supported destinations. Email verification can establish the native RefRef session, but it never accepts programme rules or creates membership.

Delivery is **not** confirmed by an HTTP 200, a captured SDK command or a provider message ID alone. Public link callbacks and native background dispatch separate request completion from delivery; failures produce redacted diagnostics. UI messages describe requests, not receipt. Production activation needs separately authorized RefRef sender/domain, send permissions/credentials, public HTTPS origin/trusted-origin review, explicit egress and signup decisions, and received verification/reset/invitation email evidence. No such activation or external delivery is performed by this source change.

The complete verification/reset/magic-link rendering-and-transport Promise is submitted to one shared native-shaped Better Auth background handler, including the SDK's direct anonymous-resend path. A slow/failing mail provider must not distinguish a known unverified recipient from an absent one through request completion or failure. This removes provider-completion dependence, not every possible timing difference. Tasks are best-effort within the existing long-lived Node process; there is no durable queue or shutdown-survival guarantee. A serverless host would need its platform `waitUntil` lifecycle integration. Native origin/session/token/expiry/rate-limit checks and protected invitation validation remain intact.

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

On 25 October 2026, fresh **full and production** locked-closure audits both reported **zero advisories** after native `fast-uri` corrections and compatible tooling fixes. The installed compiler/Ajv first reproduced encoded-scheme promotion to live `javascript:`, then rejected it with 3.1.9/4.2.3 in their existing major branches; no custom URI filter was added. Earlier `braces`, `vue-template-compiler` and `sprintf-js` tooling findings are historical, not silently ignored. An audit is neither a malware nor a future-vulnerability guarantee. Sibling Backend/Mobile findings and their distinct remediation status remain in the coordinated report.

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

V1 reward transport is explicit in the shared engine. API discount rewards retain no coupon metadata; web discounts retain the original 30-calendar-day validity and, for percentage discounts only, minimum purchase 50. Legacy configured `validityDays`/`minPurchaseAmount` are not silently reinterpreted by this cutover; changing that historical coupon policy needs a separate explicit migration. V2 checkout discounts independently honor their configured minimum and validity through the approved snapshot contract.

Signed V1 cash calculations retain the former PostgreSQL decimal behavior, including negative legacy earnings and half-up rounding away from zero at a tie. Signed legacy balances are displayed rather than clamped into a fake zero. A negative balance cannot fund a positive withdrawal; approval cannot underfund requested/processing reservations or completed payouts. These are compatibility corrections, not a new refund/debt workflow. V2 purchase amounts, commission calculations and payout requests retain their nonnegative/positive boundaries.

Legacy rule currencies use a supported explicitly configured currency, otherwise the former USD default; purchase metadata cannot introduce an invalid currency into a reward. This fallback is only legacy compatibility: malformed V2 currencies are rejected by the strict financial contract, not guessed.

Protected gateway operations are `POST /tracking/v1/referrals/resolve` and the existing `POST /tracking/v1/track/purchase`. The maintained contract is served at `/tracking/openapi` from `apps/api/openapi.yaml` (OpenAPI 3.0.3). Resolve is a read-only business lookup. V1 purchase keeps `orderAmount` in major units for unrelated legacy programs; V2 uses explicit `orderAmountMinor`, customer name/email and the full accepted snapshot. V2 atomically records participant/profile, exact code attribution, first-purchase claim, event and complete frozen commission results. Its ACK includes actual native `codeId`, `customerExternalId`, linked IDs and rule/config results; processed is not approved or paid out. Customer profile changes do not change purchase replay identity. No-code purchases and renewals are not an all-sales report in Activity.

Create a dedicated integration key in organization settings with an explicitly authorized product/program. Its native permissions are `referrals: ["resolve", "purchase"]` and metadata `referralScope: {productId,programId}` in addition to verified organization ownership. It cannot access other operations. No widget token or browser session authorizes a confirmed sale. The extended SDK source is not a newly published artifact: inspect/build/package a version before adopting it in another repository; the backend may use its independently validated bounded client.

API key names follow the installed Better Auth SDK's 32-character limit. The existing two-year expiry option is supported through native `keyExpiration.maxExpiresIn: 730`; the existing never-expire option remains explicit. Native SDK parameter errors remain client errors through tRPC, and settings notifications display failures without an uncaught mutation rejection. The one-time key screen distinguishes the submitted dedicated scope from an organization-wide key; it does not infer permissions from later form edits.

### Business and ownership approval

First-paid, Double-Sided and opted-in server-tracking programs require explicit activation approval. Ordinary Single-Sided V1 programs retain their original automatic activation after setup; existing approval/inactive/archived states are not bypassed. Configure actual rates, currencies, commission basis and any dates/minimums; none is supplied as an approved business default. Calculation version 1 uses exact nonnegative decimal/rational arithmetic and rounds half-up once at the final minor boundary. Fixed native amounts have at most two decimals; percentages at most six. Review examples before approval: `1 minor × 50% = 1`, `3 × 50% = 2`, `101 × 2.5% = 3`. Changed saved terms invalidate financial approval. The backend separately proves lifetime first-payment eligibility, including purchases without codes; a RefRef participant is not proof of paid or never-paid.

Activation acknowledgement is bound to the exact saved financial fingerprint, saved start/end period and proposed dates. The native approval RPC requires `reviewedPeriod`; under the programme row lock it rejects a concurrently changed saved period with `CONFLICT` before writing anything. Leaving a proposed date blank still retains its saved value. Re-reading changed terms/dates clears the checkbox rather than reusing a prior boolean approval.

Converting a programme also validates every active referrer/purchase/cash rule against the existing frozen financial schema and the selected first-paid/currency/basis policy, under the programme lock. Incompatible custom rules fail save/approval transactionally instead of producing an active programme that cannot resolve. Compatible custom rules/history and ordinary V1 programmes remain intact.

A verified RefRef session proves the referrer's own login identity without bank details or an AI-marketer account. For an explicitly enabled active programme, the person joins independently after accepting its exact published rules. Administrative ownership verification remains available for assisted enrollment and existing external participants; it requires bounded independent identity evidence, not matching email or possession of a participant ID. Neither path grants organization membership or permits reassignment of verified ownership.

New financial code resolutions also recheck the owner's current verified, non-banned personal account. Later code deactivation or owner restriction does not retroactively discard an already accepted purchase snapshot or duplicate its existing reward on replay.

RefRef-only referrers do not complete product onboarding. `/participant-portal/join/[programId]` retains the selected programme through native registration/login/email verification and opens the protected join form. In **Payouts**, an authorized administrator can still select the product and enroll a verified RefRef account or verify an existing participant. Both paths use the same product/owner transaction and globally unique code constraints. New participant identity derives from the RefRef account ID; existing linked participants keep their external IDs/history. Retries reuse the same first code, including its disabled state, rather than silently creating another.

Enrollment does not copy the global RefRef name/email into the product or merge identities by email. Product-specific customer profiles supplied through trusted purchase tracking remain separate. Recipient name/details are explicitly provided by the owner for a payout request; they are not account-ownership proof or bank verification. An account ID is an identifier, not permission to read that person's global profile.

### Partner rules, codes and reports

In a configured active programme, open **Партнёры**, review the actual approved economic conditions, enter the complete organizer/rules text, explicitly confirm review and publish an immutable version. Then enable admission separately. The legal draft under `docs/superpowers/specs` is not automatically published or a substitute for real organizer data and reviewed lawful recipient/payment conditions. Publication freezes the actual effective commission rules, discount and period; a financial or published-rules change needs a current version and explicit partner acceptance. An admission toggle never approves rewards or transfers money.

The first code is a non-persisted editable suggestion until join succeeds. New code input accepts 3–32 ASCII letters/digits, trims surrounding whitespace and normalizes case; `health` and prohibited texts are rejected. Availability is checked for the current user/programme/input and again on insert. A collision preserves the chosen text and reports it; no random substitute is created. Additional codes are explicit. Text/history are not overwritten; deactivate codes no longer being distributed. Existing direct/vanity/widget facilities are retained but no buyer promo links or click/install attribution are added to the AI mobile flow.

The own portal reports each code's confirmed purchases, actual paid amount and pending/approved/rejected/disbursed commissions, grouped by currency over a bounded `[from,to)` period. Multiple cash rules cannot multiply the paid amount. This report exposes no customer identity and does not pretend that participant-level manual payouts have been allocated to individual codes. Closing admission blocks new partners; existing owners retain access to their code/history management and any required updated-rules acceptance.

The mobile account Card and native information route require the **current billing scope's** `referralEligibility === 'already_paid'`; trial, unknown history and bank return are not payment proof. Configure the mobile build's `EXPO_PUBLIC_REFREF_APP_ORIGIN` (HTTPS origin only) and `EXPO_PUBLIC_REFREF_PROGRAM_ID` for the same approved programme as the backend integration. The ordinary system-browser destination contains only that programme context, never AI identity, tokens or SSO. Sender/egress/signup/programme activation and public deployment remain explicit operator steps, not defaults enabled by this feature.

Forward Drizzle migrations `0005`–`0007` introduce immutable rules/acceptance/effective-commission snapshots and separate recipient details from immutable ownership. They were verified only on an owned disposable PostgreSQL database; this implementation does not migrate a running environment.

### Own earnings and manual payouts

`/participant-portal` is the session-authenticated own-participant portal, outside the organization-onboarding gate. `/payouts` is the administrator interface with an explicit authorized product selection. The available balance is approved cash earnings minus completed payouts and requested/processing reservations, separately per product/participant/currency. Pending/rejected/discount and legacy disbursed earnings are not withdrawable. Partial withdrawal does not mark a whole reward disbursed.

Legacy `pending_disbursal` cash still requires the existing administrator **Approve Reward** action before it becomes withdrawable; verified ownership does not remove that action. Four-currency balances use two native grouped queries, without a balance cache. Successful own payout requests invalidate native administrative list keys for their originating product as well as own summary/history, so returning to a fresh cached list shows the new request without a reload.

Ownership-linked cash uses the payout workflow, but approved legacy noncash discounts retain their existing **Mark as Disbursed** action. Completing such a discount does not consume, reserve or disburse the participant's approved cash balance.

Programs, Activity, Rewards and Payouts use an explicit authorized product; record reads verify the current user/organization and the record's actual product. Only the unchanged, no-input analytics program list retains its legacy first-product behavior. Native Better Auth membership gates privileged cached content. Financial query ownership is released on scope departure, and a denied related read remains hidden until all required reads positively recover; an unrelated success or transient error cannot revive cached private data.

Editor/setup/table keys contain stable identity and product/program scope, not a transient membership-loading/role flag. Loading the native active member must not discard an unsaved reward or partner-rules draft; native positive-admin and denied-read barriers still hide privileged data when authority is uncertain. The partner-rules draft lives inside its user/organization/program key and is discarded on any of those scope changes. A remounted rules editor requires a fresh administrative publication confirmation.

The browser QueryClient is also owned by the verified session user and active organization, including an anonymous/logout boundary. Changing that identity remounts the query-provider subtree before any old rows render; late requests remain attached to the departed client. One scoped browser client is retained for initial Suspense retries. Ordinary same-session refresh and membership loading do not rotate that client or discard dirty forms. This covers legacy identity-free list/search keys as well as the explicitly scoped financial reads.

Configure `PAYOUT_MANUAL_EXECUTION_NAMESPACE` on the webapp before claiming a payout. This is the verified executing-account namespace for external-reference uniqueness, not a fabricated bank account or a client-selectable provider. One operator claims a request; one full manual execution may be confirmed with the exact amount/currency/reference/time. Confirmation only records a transfer already executed outside RefRef: it never sends money. Before transfer, verify actual originating payment and absence of a refund/dispute in the backend/bank. Unknown transfer outcomes stay processing without expiry, retransmission or reserve release. No refund adjustment, outbox, delivery worker, automatic retry or online payout-provider framework is added.

Native Turbo `globalPassThroughEnv` forwards `PAYOUT_MANUAL_EXECUTION_NAMESPACE` to strict-mode tasks without embedding its runtime value in the build cache. A configured host environment value must not silently disappear when starting the webapp through Turbo.

Migration `0004_first_payment_and_payout` extends the native Drizzle history with scoped financial FKs, immutable snapshots/claims/ownership and the native payout table. Ambiguous legacy financial links cause an explicit migration failure requiring reviewed remediation, never deletion or fabricated attribution. Financial history is retained; rollback must not erase accepted facts.

That unapplied cutover also narrowly canonicalizes the actual old template producer's V1 `percentage` unit to `fixed`, preserving the former engines' flat economic meaning, not converting it to a percentage or rewriting rewards. Purchase participant serialization uses native `FOR NO KEY UPDATE`, retaining first-purchase exclusion while allowing reciprocal-referrer foreign-key checks.

The optional `docker-compose.referrals.yml` links only the existing gateway to an operator-created **internal** external network named `refref-billing`, alias `refref-gateway`. The backend uses `http://refref-gateway:8080/tracking`. Databases, roles, mounts and stacks remain independent; existing resource, read-only/non-root and loopback-port restrictions remain. Including the override is opt-in, not a requirement for ordinary checkout or RefRef startup.

### Acceptance without resetting existing services

Run checks sequentially through the bounded `scripts/dev.mjs run` helper. **Do not run `testdb` while retaining an existing test stack: that command resets the disposable stack.** Instead, start/preserve `compose.test.yml`, create a new uniquely named database in `refref-test-db`, select that database in both `DATABASE_URL` and `TEST_DATABASE_URL`, and apply `pnpm --filter @refref/coredb db:migrate`. Never point these checks at the deployed database or print/copy `.local` secrets.

When the native suite uses a DML-only runtime role, set optional `TEST_DDL_DATABASE_URL` to the **same host and dedicated test database** with its test migrator credentials. Only the reciprocal-purchase test's temporary synchronization function/trigger use that connection; business operations still use `TEST_DATABASE_URL`. Do not grant runtime schema creation or table ownership merely to run this fixture, and never use deployed migrator credentials.

`node --test scripts/gateway.integration.test.mjs` exercises the actual NGINX quota boundary with controlled upstream data. It requires Docker and a locally cached pinned NGINX image; `TEST_NGINX_IMAGE` may select an already-built gateway image. It verifies cold static loading, a usable following protected request and retained protected-route throttling, not authentication by the controlled upstream.

`NEXT_PUBLIC_*` values, including the Better Auth client origin, must be supplied when building the webapp. A different runtime-only value cannot replace a compiled public URL; rebuild for the intended verification/deployment origin.

The initial 24–25 October 2026 audit ran 139 native finance/security/redirect tests, API22, SDK21, ID28, attribution23 and five actual tooling checks. The subsequent gate-hardening run passed **150 webapp tests/9 files**, **refer10/2 files**, **utils44**, widget6, actual Chromium shared-UI3, all **20 root type tasks**, all **14 production build tasks**, separately named SDK `typecheck`, and whole-source **zero-warning ESLint**. Native migrations and money/user/product boundaries use owned disposable PostgreSQL and restricted runtime roles. Use `--maxWorkers=1` for RefRef Vitest; these results are not a blanket claim that every ACME or deployed integration gate passed.

The earlier same-origin production UI/HTTP/PostgreSQL smoke created and approved an actual RUB programme through the native wizard, enrolled a RefRef-only account through Payouts, displayed its owned code without product/AI-account onboarding, rejected foreign owner/product reads and refused pending withdrawals. Three synthetic first-paid buyers produced 3 × RUB 179.10 net-paid commissions; native Approve Reward made RUB 537.30 available. Double submission created one RUB 50 request; the reserve reduced availability to RUB 487.30 and blocked an over-reservation. A **synthetic manual confirmation record** moved RUB 50 from reserved to completed without moving money. Dedicated-key non-C1 access returned 403; cold sign-in and recoverable key-form errors were also observed. Bank transport and human proof were explicit test fixtures: no real charge, transfer, identity verification, commercial programme activation or user-stack deployment occurred.

Freshly packed SDK public imports now pass external **Node22.23.2 and Node24.22.0**, TypeScript5.9.3, **`skipLibCheck:false`** and valid npm peer graphs. Both ESM and CommonJS execute real BetterAuth memory signup, HTTP V1/C1 and cookie/schema paths; upstream `bun-types/sqlite` supplies the real SQLite declaration without unnecessary Bun globals or ambient shims. Original unbuild/artifact formats are retained; the package was not published. Both pure-JS consumer graphs were installed with host npm: the separate Alpine npm optional-peer resolution failure is not claimed as a passing Node24 install. Previously unimplemented ACME page helpers now have native implementations and pass full E2E TypeScript; browser journey results are recorded separately.

The actual ACME development-server/Chromium journey now passes **all five existing cases**, including signup/logout/login, invalid credentials, duplicate signup and the native page-object purchase path. The helper rejects unavailable price29.991 before selecting the real29.99 demo plan. This verifies the formerly unimplemented helpers against the real UI, not bank settlement or a RefRef purchase-event acknowledgement. Framework-generated declaration changes were restored to their protected original bytes afterward.

Detailed coordinated evidence, independent source-review attribution and A01–A28 boundaries are recorded in the sibling `ai-backend-marketing-agent/docs/superpowers/reports/2026-10-21-referral-first-payment.md`. Root compiler/build/lint gates are now green without downgrading ESLint errors or deleting behavioral checks. Android/iOS device interaction, live bank, deployed OpenBao/network and representative historical-money migration remain distinct unverified gates; JavaScript exports do not prove them. Disposable smoke scaffolds and credentials are not production files or permanent acceptance commands.

### Partner self-service verification — 2026-10-31

This source-only increment starts at RefRef `a03308f4de8426fc55213039e7c61980e169f207`, backend `c2b3109ab686fdf22160250de82eb2acd657ee2e`, and mobile `13064b68f8b51be24d7617512cd403c408d3637f`, including their already-dirty working trees. The original file/status baseline was captured before implementation; no original file was deleted. Existing unrelated edits and generated-declaration originals were preserved. No staging, commits, deployment, production migration or activation was performed.

- RefRef: complete webapp suite **205/205, 14 files**, including real PostgreSQL finance/security/self-service, native authentication, client-scope and actual React form regressions; package suites **112** (API22, SDK21, attribution23, widget6, utils40); **20/20** root type tasks, separately named SDK `typecheck`, and whole-source zero-warning ESLint. Forward migrations `0005`–`0007` ran on the owned disposable database only.
- The final bounded **`pnpm build`** completed **14/14** tasks, **10 cached**, with fresh Next16.4.2 webapp compile, TypeScript, 31 pages and standalone tracing. Hard limit **2 GiB / 1 CPU / no swap**, V8 old-space1024; measured peak2GiB, `oom=0`, `oom_kill=0`. Earlier 1024 runs also passed14/14. These are root-workspace build observations, not certification of Docker/BuildKit overhead or future workloads.
- Packaged Node24 smokes used only the standalone tree, static files and real public SDK assets, with **640 MiB / heap384**, non-root/read-only controls and the disposable database. Independent native sessions recovered only their own one/two codes; both forged-owner directions returned **HTTP403**. Existing RUB90-minor approved/reserved funds remained reserved and unavailable; no transfer was made. At390px the document stayed390px wide. The final auth artifact also completed actual browser signup with `emailVerified=false`, refused unverified login with403, retained the selected programme, and acknowledged known/absent resend requests while mail was deliberately unconfigured; this was not a delivery test.
- The preceding UI/HTTP/database journey exercised protected programme return, independent verified RefRef identities, required exact-rules consent, explicit code collision, multiple codes and activation, synthetic confirmed900-minor purchase/replay producing one purchase and90-minor commission, native **Approve Reward**, and one withdrawal with a frozen owner-provided recipient. Immutable rule publication/retry and cross-owner denial were exercised, not inferred from compilation.
- Backend: full suite **1681 passed / 227 skipped**, types and ESLint passed. Mobile: **657/82 files**, types and ESLint passed; final Android/iOS Hermes and Web exports passed. Existing Chromium billing **51/51** and final390px dark recruitment/CTA Chromium+Firefox **6/6** passed. Web and JavaScript exports are **not** Android/iOS device or bank evidence.
- Review corrections include effective custom-rule consent snapshots, fresh verified-person guards, preserved invitation return, removal of global-profile copying into a product, removal of cash restrictions that the engine does not enforce, preservation of the scoped unpublished rules draft through revalidation/read failure, and provider-independent public reset/resend completion. Each corrected behavioral path has a failing-before/passing-after regression; existing buyer restrictions, first-paid policy, payment confirmation and manual payout accounting remain intact. Final independent mail/security and scoped-draft reviews found no demonstrated remaining material defect within their stated source scope; they did not rerun checks.
- Official compatible renderer **2.2.0** (html-to-text10/deepmerge-ts) and Vite **6.4.5** replaced vulnerable runtime closures. The actual **production audit has0 advisories**. The full unfiltered audit still reports **4 dev-tooling advisories (1 low,3 moderate)** through bunchee/ESLint/react-email tooling; none is suppressed or disguised by a package alias, fake version or untested major override. Global formatting still flags77 unrelated backend files and unchanged mobile `tests/e2e/creatives.spec.ts`; task-owned files are formatted.

The SESv2 Node dependency is present in the final auth route trace. The configured email-workspace opt-out is not claimed as an independently measured memory optimization; this build bundles its code. Native auth callbacks and real template rendering were exercised locally, not real external delivery. Received Postbox messages, live bank settlement/transfers, Android/iOS device execution, approved real legal/organizer data and public production activation remain separate prerequisites.

Technical references: [Better Auth native email/verification callbacks](https://www.better-auth.com/docs/authentication/email-password), [Next build memory](https://nextjs.org/docs/app/guides/memory-usage), [native server-package opt-outs](https://nextjs.org/docs/app/api-reference/config/next-config-js/serverExternalPackages), [React Native0.86 Linking on Android/iOS](https://reactnative.dev/docs/0.86/linking), and [Yandex Postbox AWS SDK delivery](https://yandex.cloud/ru/docs/postbox/operations/send-email). Version-pinned installed Better Auth1.7.11, SESv2 3.1109.0 and renderer2.2.0 source/types supplement these public instructions.

### Independent cumulative audit — 2026-11-01

The earlier dated results above are historical. The [full independent report](docs/superpowers/reports/2026-11-01-full-referral-audit.md) compares all 15 thematic/3 merge commits, the real pre-work bases and the initially dirty trees in all three repositories. Original files and staged objects/modes/paths/flags are preserved; no staging, deployment, existing-database migration or EAS operation was performed.

Seven reproduced defects were corrected: fresh referrer-owner eligibility; exact reviewed programme period/approval CAS; successive-checkout recovery; historical inline-file MIME including import order; exact commission-amount ACK; incompatible npm OpenTelemetry peer selection; missing public SDK cache outputs. `apps/assets/turbo.json` now declares only the two bundles actually generated by that package, retaining the root dependency graph and other packages' static source inputs. Actual cache-only runs failed before and restored both exact SHA-256 bundles afterward.

Current RefRef proof: forced root build14/14 with0 cached, root types20/20, separately named SDK typecheck, zero-warning ESLint,247 root tests plus118 package tests and3 real shared-UI Chromium checks. A subsequent fresh webapp build/types/lint/215 tests passed after removing the ineffective email-workspace opt-out; SES externalization remains. Two bounded fresh builds reached the2GiB ceiling without OOM: these are successful observations, not guaranteed headroom.

Actual standalone BetterAuth/tRPC/PostgreSQL verified independent self-service/foreign403/stale-period rejection. Synthetic confirmed900minor purchases produced225minor commission each; native approval, one concurrent100minor reservation, frozen recipient and one synthetic manual completion left125minor available and refused over-withdrawal. No bank transfer occurred. Backend full1909 tests passed with five optional cases then exercised separately on owned PostgreSQL/Redis/full SaaS services; strict clean npm/Docker peer validation also passed.

Current full registry audit is **not zero**: RefRef retains low deepmerge/moderate legacy-minimatch tooling findings; its production-classified closure has0 advisories. Other installers' distinct findings/counts,65 unchanged unrelated backend format violations, native-device/cloud-delivery/bank/legal limits and primary references are explicit in the report. No advisory ignore, fake version, unsupported crypto patch or compatibility-suppressing peer flag was introduced.
