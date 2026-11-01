# Partner Self-Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for the shared database/router work; independent mail and mobile slices may be delegated under the ownership contract below. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A verified independent RefRef account joins an explicitly enabled programme, chooses meaningful codes, sees its own financial results and requests manual payouts; paid AI customers discover the programme from their existing account screen.

**Architecture:** Extend existing Better Auth, Drizzle transactions, participant/refcode/event/reward/payout entities and tRPC/Query UI. Keep AI tenant identities separate from RefRef login identities; reuse existing checkout and native Expo navigation. No new identity service, buyer link attribution, ledger, marketplace, mail proxy or chat changes.

**Tech Stack:** Installed RefRef Next 16.4.2, Better Auth 1.7.11, Drizzle 0.45.4, tRPC, Zod, TanStack Query and shared UI; Expo SDK 57, React Native 0.86.3, React 19.2.3. Only justified addition: official SESv2 SDK inside RefRef for Yandex Postbox.

**Spec:** `../specs/2026-10-29-partner-self-service-design.md`; accompanying Russian rules draft is the source of proposed legal wording, not an approved live offer.

## Global Constraints

- 3–32 латинские буквы или цифры; внешние пробелы удаляются, регистр приводится к lowercase. Reserve `health` for the existing service route; reuse profanity filtering at creation.
- Referrer needs only RefRef, never an AI account. No identity linking or financial ownership by email.
- Existing user edits, staged files, test assertions, generic widget/redirect flows, platform patches and billing recovery remain. Never reset/stash/commit/stage or delete unrelated files.
- Work starts from existing dirty trees, captured in `local://partner-self-service-baseline.json`, on `feat/partner-self-service-20261031`; do not replace these trees with clean HEAD worktrees and omit existing fixes.
- Codes, balances, reports and payouts are owner/product scoped; all admin writes require verified organization/product authorization. No buyer PII in partner reports or availability responses.
- DB constraints, owner identity immutability, accepted purchases and payout snapshots remain authoritative. Forward migration only; do not edit migration 0004 or shared databases.
- One configured AI financial programme; first successful payer-tenant payment only. Existing cash commission, quote revalidation, approved rewards, payout reservations and bank confirmation remain.
- No new promotional links, URL-to-code handling, install/auth attribution, click counters, association files or native payout UI. Ordinary RefRef/auth/rules/bank URLs remain.
- Mobile recruitment appears only in the registered, confirmed-paid account context; trial/unknown/checkout-created/return-from-bank are not paid proof. Use scoped `useBillingSummary` and `referralEligibility === 'already_paid'`.
- No Mastra/assistant-ui/chat changes: this feature does not touch those surfaces. No dependency refresh without a concrete used API/security need.
- Real mail credentials/domains, production activation, deployments, EAS publications and real transfers are separate prerequisites/authorized operations. Never borrow backend keys or call its mail service.
- Run heavy checks serially. Delegated workers do not run builds, tests, linters, formatters or installers; the integration owner performs verification. Tests precede production changes; preserve RED evidence before the owned implementation begins where execution is available.

## Review Focus

1. A stale rules page cannot accept a newly published version; the owner explicitly accepts the exact shown version. Task 3 regression changes the current terms between read and join.
2. A timeout/retry or two concurrent joins cannot create two first codes or acquire another user's participant. Task 3 runs parallel join calls for generated independent identities.
3. Two reward rules cannot double the paid purchase amount, and another owner cannot query it by code ID. Task 5 uses one 1,000-minor purchase with two separate commissions and a foreign owner.
4. Payout retry under the same key cannot change recipient/sum/currency, and changing future defaults cannot mutate an existing request. Task 1 records recipient A, retries with B and observes a conflict and unchanged snapshot.
5. A paid snapshot cached under another tenant or a direct info-route navigation cannot bypass recruitment visibility. Task 6 exercises unknown/trial/paid and account/tenant transition through existing scope-aware billing state.

## Ownership / interfaces

The integration owner edits coredb/types/utils/API SDK, programme and participant routers/pages, migration and integration tests. The mail worker owns `packages/auth`, email templates, auth UI/client/provider consumers, mail environment/Compose wiring and auth tests. The mobile worker owns the mobile repository and backend referral-format contract/tests only. Lockfiles/installations and final formatting/checks belong to the integration owner. Workers must not edit another slice or run nested subagents.

Shared decisions:

```ts
// A fixed programme context, not an authorization token or buyer promo URL.
const partnerEntryPath = (programId: string) =>
  `/participant-portal/join/${encodeURIComponent(programId)}`;
// ProgramConfigV1 gains one optional setting; every config save preserves it.
type SelfServiceConfig = { enabled: boolean; termsId?: string };
// User-provided recipient data is never labelled bank-verified.
type RecipientInput = { name: string; details: string };
type RecipientSnapshot = RecipientInput & { providedBy: string; providedAt: string };
```

The RefRef auth worker preserves this safe internal return path through signup/login, verification/resend and password reset without requiring merchant onboarding. Existing general merchant entry, invitation and optional social/magic-link behaviour remain. Mobile derives the entry from an explicitly configured HTTPS RefRef app origin and programme ID; it passes no AI identity or credentials.

### Task 1: Separate ownership from recipient; preserve manual payout invariants

**Files:** `packages/coredb/src/{schema,payouts,referrals}.ts`, new `packages/coredb/drizzle/0005_partner_self_service.sql` plus native journal/snapshot metadata, `apps/webapp/src/server/api/routers/{participant-portal,payouts}.ts`, current participant/admin payout forms and financial integration tests.

**Interfaces:** `ownParticipant(db,userId,productId)` proves a verified non-service account and immutable owner identity without requiring bank data. `requestParticipantPayout(db,userId,{productId,currency,amountMinor,idempotencyKey,recipient})` validates/stores the exact recipient and updates only the participant's future default. Existing claim/complete/reject APIs remain.

- [x] Add a regression that inserts an authenticated owner without payout details and resolves its code/portal, and a payout test that rejects missing details and recipient drift on retry. Run the relevant security integration test against the dedicated test DB; expected RED is the old ownership CHECK or recipient-dependent access, not a connection error.
- [x] Change the CHECK and immutable-owner trigger in a forward migration: owner verification remains complete/immutable, evidence may be absent for session-derived ownership, payout recipient is optional/updateable. Never fabricate evidence or bank verification. Preserve every other first-purchase/identity branch of the trigger.
- [x] Update `ownParticipant` and referral resolve to require owner verification rather than recipient. Keep verified-account and service-role checks. Require normalized recipient on every new payout request.
- [x] Inside existing payout transaction, compare all accepted input before idempotent return. A repeat with changed recipient is `PAYOUT_CONFLICT`; new requests freeze `{name,details,providedBy,providedAt}`. Existing requests are never rewritten.
- [x] Adapt admin enrollment/verification to the same shared owner/code primitive, without mandatory bank data, preserving its scope and legitimate external-participant verification capability. Remove the obsolete coupled UI/DTO checks, not admin functionality.
- [x] Run the first-payment/ownership/payout regressions; expected result is own access without bank details plus unchanged reserve/approval/manual-transfer behaviour.

### Task 2: Independent Yandex Postbox mail and native auth return

**Files:** `packages/auth/src/index.ts`, a server-only Postbox transport beside it, `packages/auth/package.json`, `packages/email-templates/src`, all actual `getAuth` consumers, `apps/webapp/src/app/auth`, auth provider/client wiring, environment validation and hardened Compose mail egress; lockfile integration follows centrally.

**Interfaces:** replace `resendApiKey` with explicit Postbox transport configuration; use official `SESv2Client`/`SendEmailCommand`, credential chain, endpoint `https://postbox.cloud.yandex.net`, region `ru-central1`, own server-only From. No shared backend mail code/credentials. New callback context is the internal entry path above.

- [x] Add native verification/reset tests at the real Better Auth boundary: captured provider transport only, account remains unverified until its native token is consumed, reset link changes only the intended password, invalid/external return destinations are rejected. Leave generic signup responses and enumeration protection unchanged.
- [x] Preserve native resend/rate-limit/verification mechanisms, add `sendResetPassword`, and render purpose-correct React Email verification/reset/invitation templates. No custom tokens, OTP, queues or fake delivery success. Sanitize provider errors/logs; never log email/token/auth URL.
- [x] Update all consumers and tests; remove unused Resend imports/config/dependency after complete cutover. Preserve optional social/magic-link support without activating it. Missing configuration fails delivery rather than pretending to send.
- [x] Use native auth page/provider redirect configuration and safe callback validation to retain `/participant-portal/join/[programId]` through signup/login/email/reset. Keep general merchant login and invitation paths working.
- [x] Wire RefRef-only mail env/secrets and opt-in outbound network for webapp/API without exposing DB or removing non-root/read-only policy. Do not activate signup or alter live env/secrets.
- [x] Integration owner installs the justified SDK, then runs auth/privacy tests and verifies generated emails and callback URLs against the installed SDK contract. External delivery requires separately authorized RefRef sender/credentials/domain and received-message evidence; report it unverified when absent.

### Task 3: Explicit self-service permission, immutable rules and atomic join

**Files:** `packages/types/src/program-config.ts`, new programme terms/acceptance schema in `packages/coredb/src/schema.ts` and migrations 0005–0007; new cohesive `packages/coredb/src/partners.ts` exported by coredb; existing programme/participant routers, protected `apps/webapp/src/app/participant-portal/join/[programId]/page.tsx`; existing programme editor plus a focused rules/settings component; immutable read-only rules page. The entry checks its own native session outside the authenticated route group so signup/login retain the selected programme.

**Interfaces:** programme config gains `selfService`. `programTerms` stores immutable text/economic snapshot/fingerprint/creator/program/product; `programAcceptance` stores immutable user/participant/program/product/terms/server-time and native scoped FKs/uniqueness. No separate identity or enrollment engine.

```ts
// tRPC inputs remain scope-keyed for client-cache isolation; userId must equal session.
const joinInput = z.object({
  userId: z.string().min(1), programId: z.string().min(1),
  termsId: z.string().min(1), acceptRules: z.literal(true), code: inputRefcodeSchema,
}).strict();
// participation({userId,programId}) returns only programme summary, published rules,
// own acceptance, own codes and a non-persisted suggested first code.
// join(joinInput) returns {productId,programId,participantId,codeId,code}.
```

- [x] Add DB/router tests for no session/unverified/service account, disabled/inactive/unapproved programme, changed terms, missing checkbox, two owners/products and concurrent/repeated join. Expectations: explicit rejection, one own participant, one first code, one acceptance, no organization membership or buyer-identity reassignment.
- [x] Implement one shared owner/enrollment/code transaction. Lock programme before owner/code changes; use existing owner uniqueness and immutable identity. Stable new external identity derives from the verified RefRef user ID, never email. Never claim an existing unowned externally-created participant without admin evidence.
- [x] Publish a new immutable rules record from scoped admin input with explicit review; store its actual economic terms. Enabling requires active programme, current approved terms and actual published rules. Preserve self-service on template/reward/design config saves. Turning it off must remain possible when inactive.
- [x] Require exact displayed terms at join; stale publication rejects and reloads unchecked consent. Existing participation returns existing codes rather than creates a new first code. A new revision needs explicit acceptance, never implicit upgrade.
- [x] Add protected join UI using existing forms/components/Query. No public marketing landing. No bank details at join. Expose a stable full-text rules document and previously accepted immutable revision in own portal. Do not auto-publish the legal draft or invent organizer details.
- [x] Verify normal widget/private/admin flows and late accepted financial snapshots still work; rules/terms updates do not rewrite prior acceptances or paid purchases.

### Task 4: Meaningful multiple codes and coherent 3–32 cutover

**Files:** `packages/types/src/referral-contract.ts`, `packages/utils/src/refcode.ts`, all discovered exports/callers (including SDK, API request/OpenAPI and direct refer validator), `packages/coredb/src/partners.ts`, participant router/portal; backend `packages/domain/src/referral.ts` and its consumers/tests; current mobile buyer field/contract validation where required.

**Interfaces:** `availability({userId,programId,code}) -> {code,available}`; `createCode({userId,programId,code})` returns only the own code DTO; `setCodeActive({userId,productId,codeId,isActive})` never edits text/ownership. Same owned code creation is idempotent; another scope's code gives conflict without owner disclosure.

- [x] Add literal boundary tests for length 2/3/32/33, normalization, invalid characters and `health`; add two-owner collision/IDOR tests and exact-current-input UI check.
- [x] Adopt one 3–32 schema for input/canonical/snapshot/API/SDK/backend; keep random seven-character generation as a valid suggestion, not a legacy path. Migrate/remove deprecated utility aliases across every caller.
- [x] Reuse the profanity filter for creation and DB unique constraint for races. Never silently regenerate a user's chosen code. Availability is a bounded read, not a reservation; actual insert conflict is explicit.
- [x] Add own-code creation/activation UI with the existing 300ms debounce and query keys containing user/context/current code. Disable submit while checking/error/pending; preserve user text on conflict. No separate availability boolean vulnerable to out-of-order responses.
- [x] Preserve all existing generic RefRef widget/redirect features; adapt only shared code format. Disabled codes reject new resolve but previously accepted checkout/purchase snapshots remain payable.
- [x] Verify SDK/OpenAPI and backend/mobile manual preview/checkout contracts with a meaningful long code; no URL attribution is added.

### Task 5: Truthful owner-only code statistics

**Files:** `packages/coredb/src/partner-statistics.ts`, participant router and own portal code/report components; financial integration tests.

**Interfaces:** `codeStats({userId,productId,from,to})` requires own participant and a bounded <=366-day interval. Return safe per-code/program/currency purchase counts, paid-minor sums and pending/approved/rejected/disbursed commission-minor buckets; no customer identifiers or payout allocation.

- [x] Add a real purchase fixture with amount `1000`, two reward rules with commissions `100` and `50`, and duplicate purchase delivery. Expected one purchase, paid `1000`, commission `150`; a foreign owner's query receives no code/report data. Add different-currency/date-boundary assertions.
- [x] Aggregate purchases and rewards independently using native grouped SQL on event/referral/refcode relationships, then join aggregates without multiplying event amounts. Financial purchase metadata must be V2/server-accepted and processed; no synthetic historical/signup/click data.
- [x] Add bounded period selection and currency-aware display. Keep payout totals participant/product/currency-level. Expose code status/copy/activation and rules link, not paid-out-by-code or conversion rate.
- [x] Run the report regressions and inspect the real own portal with generated independent owners.

### Task 6: Native paid-account recruitment surface

**Files:** mobile `app/settings/index.tsx`, new `app/settings/partner-program.tsx`, existing settings/AppBar mappings, focused presentation under `src/features`, config/env/examples and relevant existing billing/visibility tests. Read the brandbook first.

**Interfaces:** existing scoped `useBillingSummary`; no new backend endpoint. Configuration holds the approved RefRef HTTPS app origin and programme ID; derived destination is `/participant-portal/join/[programId]` with no identity/query secrets. Normal system `Linking.openURL`, not WebView/SSO/auth-session imitation.

- [x] Check unknown/trial/paid visibility and direct route access using real eligibility logic and existing scope-aware query conventions. A cached other-tenant value is never a proof for the current scope.
- [x] Add a themed marketing Card and one native illustrated information screen, reusing Card/Button/icons/theme/AppBar. No new carousel, mascot, animation library or second header.
- [x] Explain first eligible confirmed purchase, approved reward, manual withdrawal in RefRef, and eligible recipient model without invented rates/timelines. RefRef registration is independent from AI. Do not insert advertising into chats/tasks/tariffs/auth/bank return.
- [x] Make HTTPS trusted-origin configuration explicit, reject credentials/unsafe URLs, preserve input state, handle browser-open failure and rapid taps using existing async conventions. Browser return is not enrollment or financial success.
- [x] Verify the actual mobile UI with available runtime; inspect both platform API support and run native platform smoke when available. Web proof is reported only as web proof. No EAS publish/build triggered by this feature task.

### Task 7: Integration proof, independent review and operational documentation

**Files:** existing READMEs/changelog, current spec status, implemented tests/config only; no rewrite of historical audit reports/plans.

- [x] Run serially: dedicated RefRef migration/security/first-payment/auth/SDK/widget/redirect suites, RefRef `type:check`/lint/build, backend targeted referral/billing plus project test/type/lint commands, mobile tests/type/lint/Expo exports. Record actual commands/results and name unrelated failures rather than hide them.
- [x] Exercise the changed UI and real transaction/API path with two independent generated identities/products. Prove owner access without bank details, exact rules acceptance, meaningful code/manual purchase, no duplicate event/reward, correct code stats, payout reservation/frozen recipient and foreign-scope denial.
- [x] Request an independent code/security review over only this implementation plus relevant unchanged contracts. Fix verified defects with regression proof; do not accept a green audit claim based on suppression or untested crypto patches.
- [x] Update operational docs with mail configuration/egress, programme rules enablement, native recruitment config, code policy and manual payout behaviour. Remove throwaway smoke scripts/services and leave no live activation.
- [x] Report completed behaviour, exercised evidence and precise missing external prerequisites. No commits, production migrations, EAS, bank payments or external mail claims without actual authorized execution.

#### Recorded completion

- RefRef full webapp205/14 files, package suites112, root type graph20/20, separate SDK typecheck, whole zero-warning ESLint; final root build14/14 (10cached), hard2GiB/1CPU/no swap/heap1024, peak at ceiling but no OOM. Direct ACME type checking also verified the restored original generated declaration.
- Backend full1681 passed/227 skipped plus types/ESLint; mobile657/82 plus types/ESLint, Android+iOS Hermes/Web exports, Chromium billing51 and390px dark recruitment Chromium/Firefox6.
- Actual independent-account join/code/consent, confirmed synthetic purchase/replay, native reward approval, frozen-recipient reserve, two-way HTTP403 and packaged-runtime/auth UI were exercised. No received mail, bank transfer, EAS or native device execution is claimed.
- Independent reviews drove regressions and fixes, including scoped legal-draft preservation and provider-independent reset/anonymous-resend completion. The final reviewers found no demonstrated remaining material defect in their stated scope.
- Production RefRef audit0; full unfiltered dev-tooling audit remains4 advisories (1low/3moderate), with no suppression. Existing unrelated global formatting failures remain77 backend files and mobile `tests/e2e/creatives.spec.ts`.
- Own disposable DB, HTTP/mobile containers, browser tabs and temporary credentials/fixtures were removed. Existing services, private configuration, staging and unrelated edits were not overwritten. Implementation remains uncommitted on `feat/partner-self-service-20261031`; deployment and real activation are separate operator decisions.
- Operational details, technical references, review/verification boundaries and external prerequisites: [`README.md`](../../../README.md#partner-self-service-verification--2026-10-31).
