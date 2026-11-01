# Независимый аудит referral/partner-сценария — 2026-11-01

## Вывод

В исходном результате были реальные дефекты: повторное использование отозванного аккаунта реферера, устаревшее финансовое одобрение, восстановление не той оплаты, неправильный MIME исторических файлов, недостаточная проверка суммы начисления, неустанавливаемый npm lock и потеря публичных SDK-файлов при восстановлении Turbo cache. Все семь исправлены с проверкой соответствующего поведения. Простое утверждение «всё профессионально и зелёное» до этой перепроверки было бы необоснованным.

Прикладные проверки, перечисленные ниже, проходят. Общий результат security audit **не нулевой**; глобальный backend Prettier также сохраняет 65 посторонних нарушений. Они не скрыты настройками. Это не сертификат отсутствия любых регрессий и не разрешение производственного запуска.

## 1. Границы, история и сохранность

| Репозиторий | До первой тематической работы              | Проверенный HEAD                           | История                | Уже изменённые пути на старте аудита |
| ----------- | ------------------------------------------ | ------------------------------------------ | ---------------------- | ------------------------------------ |
| RefRef      | `81af934fec3b20990a4d9af7ed472d0d14d73a82` | `a03308f4de8426fc55213039e7c61980e169f207` | 7 тематических + merge | 187                                  |
| Backend     | `a123bb67ec4da512128bb86f91796d32e35fb86a` | `c2b3109ab686fdf22160250de82eb2acd657ee2e` | 5 тематических + merge | 184                                  |
| Mobile      | `25d549ab9ad024d6f76d7b4aa280482344011af5` | `13064b68f8b51be24d7617512cd403c408d3637f` | 3 тематических + merge | 53                                   |

Сравнивались исходные деревья, вся последовательность коммитов, HEAD, staged/unstaged и новые файлы. Инвентаризированы 584 исходных пути изменений, включая 454 production-classified; дополнительно проверены исправления самого аудита. Стартовая фиксация SHA-256 охватывает 4664 исходных файла. Стартовые изменения не приписывались автоматически этому аудиту.

Страховочные `589cba36e828`, `2e5f0e63a4e5`, `8b35ad4de1d7` не являются предками соответствующего HEAD; их деревья совпадают с проверенными HEAD. Это отдельные снимки, а не ещё три изменения поведения.

Перед редактированием сохранены binary staged/unstaged patches, исходные индексы и изменённые/новые файлы в приватном каталоге вне Git. Исходные файлы не удалены; объекты, режимы, пути и flags всех трёх индексов сохранены. Автоматически добавленный Next import в `apps/acme/next-env.d.ts` восстановлен до исходных байтов. Коммиты, stage/reset/stash, merge/push, деплой, EAS и миграция существующих баз в этом аудите не выполнялись.

### Проверенная последовательность

- **RefRef:** `6310221e21c4` — изоляция/зависимости/сборка; `c930f8f7079b` — условия, деньги и заявки; `a0ab1497ec34` — авторизация/организации/приватность; `f51bd10d0abd` — API/SDK; `34149437f685` — настройка/кабинет/ручные выплаты; `f4a221a5cbe1` — проверки; `73b55e4d2935` — документация; `a03308f4de84` — merge.
- **Backend:** `df7117aa1878` — OpenBao timeout/cancellation; `ab78dcd23ea0` — контракт/расчёт; `87bd03c3606d` — checkout/подтверждение/привязка/HTTP; `38b614e68533` — опциональная сеть; `64e78fb7ad7b` — документация/ключи; `c2b3109ab686` — merge.
- **Mobile:** `f63aead249bf` — generated/dev exclusions; `9a2196533a90` — промокод/цены/оплата/recovery; `35f5d9661d77` — документация/нативная сборка; `13064b68f8b5` — merge.

Незакоммиченный срез дополнительно включает self-service RefRef, собственную почту, публикацию правил/согласие, коды/статистику, блок партнёрства в оплаченном ЛК, а также смежные изменения Mastra/chat/files/auth и dependency hardening. Проверка не ограничивалась последним referral diff.

## 2. Версии и подход

| Приложение | Подтверждённые версии                                                                                                                                                                                                              |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mobile     | Expo 57.0.20; React Native 0.86.3; React 19.2.3; Router 57.0.19; assistant-ui React Native 0.1.44, core 0.3.21, ai-sdk 0.0.8, store 0.3.15; AI SDK 7.0.119; Zod 4.6.6; expo-file-system 57.0.6 с существующим патчем; Vitest 5.0.3 |
| Backend    | Mastra core/server 1.76.0, hono 1.7.18, ai-sdk 1.11.0, memory 1.37.0; AI SDK 7.0.119; Zod 4.6.6; Vitest 4.1.12; Node минимум 22.13                                                                                                 |
| RefRef     | Next 16.4.2; React 19.3.1; Better Auth 1.7.11; Drizzle 0.45.4; Zod 4.6.7; SESv2 3.1109.0; renderer 2.2.0; Turbo 2.11.9; Vitest 4.1.12                                                                                              |

Версии установлены по manifests, обоим backend lock-файлам и физически установленным пакетам. RefRef проверялся также в закреплённом Node 24.22.0 Alpine/pnpm 10.34.7; host npm-проверка — Node 22.23.2/npm 10.9.8. При расхождении общей документации с конкретной версией использованы исходники и типы установленного SDK.

Expo/RN/Mastra/assistant-ui не обновлялись ради свежести. Стандартные Better Auth callbacks, native RN primitives, Expo WebBrowser/Linking/FileSystem, TanStack Query, AI SDK/Mastra storage/processors сохранены. RefRef остаётся самостоятельным приложением: нет общего sender, общего аккаунта или скрытого email-based SSO с AI backend.

## 3. Подтверждённые дефекты и исправления

### F1. Свежая проверка владельца кода

**Файлы:** `refref/packages/coredb/src/referrals.ts:30,225`; вызывающие `partners.ts`, `payouts.ts`.

Новая проверка кода могла использовать ранее привязанного владельца после ban, снятия email verification или превращения в service account. Теперь общий `verifiedPersonAccount` проверяет актуальную запись при новом resolve. Проверка не размножена по HTTP-обработчикам. Уже принятые обязательства и повтор подтверждённой покупки не аннулируются задним числом.

**Доказательство:** три failing-before случая; реальные PostgreSQL self-service tests 22/22; настоящий HTTP отказ нового resolve с 403 после ban и сохранение прежних event/reward IDs при replay.

### F2. Финансовое одобрение относилось не к тем условиям

**Файлы:** `refref/apps/webapp/src/app/(authenticated)/(core)/programs/[id]/_components/reward-step-config.tsx:72,264,288`; `src/server/api/routers/program.ts:892,938`.

Checkbox теперь относится к конкретному сохранённому fingerprint, сохранённым датам и редактируемым датам. Изменение условий снимает отметку. Сервер под существующим `FOR UPDATE` сравнивает обе просмотренные сохранённые даты перед записью; конкурентное изменение даёт `CONFLICT`, а не незаметное одобрение нового периода. Пустой override сохраняет просмотренное сохранённое значение.

**Доказательство:** пять React regressions; две настоящие SQL race-проверки; actual production-standalone браузер показал ошибку при изменении периода между просмотром и отправкой, без изменения approval/дат. Для native tRPC batch stream транспортный HTTP 200 с `RPC.CONFLICT`/`httpStatus:409` — штатный JSONL-контракт, не имитация успеха.

### F3. При восстановлении новой оплаты использовался старый checkout

**Файл:** `ai-marketing-agent-user-mobile/app/settings/billing.tsx:393`; regression в `tests/e2e/billing.spec.ts`.

После терминально завершённой попытки A новая B могла быть принята сервером при потере ответа; локальный `checkoutId` всё ещё указывал на A. Единственное необходимое изменение — убрать старый локальный ID в начале действительно разрешённой новой попытки. История, серверная reservation и idempotency key не удаляются; pending/unknown попытка по-прежнему блокирует создание следующей.

**Доказательство:** настоящий Expo Web RED → GREEN: A failed → B accepted/response lost → summary/resume B, без третьего ключа. Затем полная Chromium-серия 112 passed/1 conditional skip.

### F4. Исторические inline-файлы и порядок импорта

**Файлы:** `ai-backend-marketing-agent/infra/postgres/migrations/1793491200000_reconcile_inline_chat_file_mime.sql:1`; `scripts/migrate-mastra-storage.ts:287`.

Старый `text/plain` в native file parts не соответствовал уже мигрированному JSON/Markdown/XML-артефакту. Forward SQL согласует MIME с текущим inline artifact, сохраняя IDs, body, порядок и остальные части сообщения. Scope проверяет tenant/workspace/native thread resource; private attachment/provenance и отдельная attachment authority исключены.

Одной SQL-миграции было недостаточно: поддержанный запуск импорта старой LibSQL истории после миграций снова приносил старый MIME. Поэтому существующий importer исполняет тот же SQL после импорта, включая повторный completed/resume путь. Не создан второй алгоритм преобразования. Ceiling полного scan и блокировки документированы; writers должны быть остановлены по runbook.

**Доказательство:** два реальных PostgreSQL migration cases и один actual frozen-LibSQL → native-Postgres CLI regression с тремя отдельными invocations; валидный RED до исправления → GREEN после. Full-suite-safe guard требует совпадения собственных test DSN.

### F5. ACK проверял конфигурацию, но не точную комиссию

**Файлы:** `ai-backend-marketing-agent/packages/runtime/src/referrals/pricing.ts:101`; `refref-client.ts:198`.

Чужой ACK с правильными policy/rule IDs, но другой суммой мог отмечаться доставленным. Теперь сумма сравнивается с точным ожидаемым minor amount по принятому snapshot, вместе с прежними проверками конфигурации, валюты, набора правил и идентичности. Используется существующая integer/BigInt half-up математика; отдельный ledger не добавлен. Принятые исторические base-basis snapshots не переинтерпретируются, новые проценты считаются от фактически уплаченной суммы.

**Доказательство:** четыре неверных ACK сначала принимались, после исправления отвергаются; связанная серия 56/56 passed. Actual backend client → actual RefRef HTTP: base 1000 − discount 100 = paid 900 minor; 25% = 225 minor, то есть RUB 2.25.

### F6. npm lock был неустанавливаемым, Docker обходил peer-проверку

**Файлы:** `ai-backend-marketing-agent/package-lock.json:2352`; `Dockerfile:4`.

Чистый `npm ci` воспроизвёл ошибку: API 1.10.0 не соответствует установленным OpenTelemetry SDK peers `<1.10.0`. Native npm выбрал 1.9.1 — уже используемый pnpm и разрешённый исходным manifest range. Дополнительный delta — только same-version `@types/pg` classification `dev → devOptional`; остальные версии/пакеты этой коррекции не менялись.

Docker теперь также выполняет `npm ci --strict-peer-deps`. Удалены `--legacy-peer-deps`, скрывавший такой дефект, и неиспользуемый ONNX install switch; ONNX closure отсутствует. Полный набор runtime/migration dependencies, entrypoint, writer fencing и resource settings сохранены.

**Доказательство:** strict clean host CI, complete `npm ls --all`, TypeScript, 31 actual Vitest/PG/loader tests; затем настоящее Docker image build со strict peers, native secure-registration checks и оба SaaS security/lifecycle/collaboration tests.

### F7. Зелёная сборка не восстанавливала публичные SDK из cache

**Файл:** новый `refref/apps/assets/turbo.json:1`.

Общие Turbo outputs объявляли `.next`/`dist`, но `@refref/assets` пишет два downloadable bundle в `public`. На настоящем cache hit все четыре задачи завершались успешно, а `widget.v1.js` отсутствовал. Это реальная потеря build artifact, а не косметический warning.

Штатная package configuration наследует корневой graph/inputs/env и объявляет ровно `public/attribution.v1.js`, `public/widget.v1.js`. Глобальный `public/**` не добавлялся: он мог бы ошибочно исключить статические source assets других приложений из inputs. Cache не выключался.

**Доказательство:** isolated bind mounts, без удаления пользовательских assets: RED при 4/4 cache hits и отсутствующем widget; после исправления старый cache корректно инвалидирован для assets, upstream graph сохранён; следующий 4/4 hit восстановил оба bundle с точным SHA-256 исходной сборки. Проверка исполняла настоящий Turbo 2.11.9.

### Обоснованное сокращение без изменения поведения

- `refref/packages/auth/src/index.ts:33`: ручная копия magic-link plugin types заменена штатным `ReturnType<typeof magicLink>`. Runtime plugin не менялся; native auth 13 tests и отдельно названный SDK typecheck проходят.
- `refref/apps/webapp/next.config.ts:12`: удалён неработавший opt-out workspace email package. Установленный Next сопоставляет real resolved `node_modules` path, а workspace templates фактически bundlятся. SES externalization сохранена. Свежая Next сборка, типы, strict lint и 215 tests после удаления проходят.
- Форматирование ограничено task-owned файлами. Посторонние 65 backend formatter failures не переписаны и не добавлены в ignore.

## 4. Что из прежней реализации подтверждено и сохранено

| Смысловая группа           | Решение и основание сохранения                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Изоляция инфраструктуры    | Default-off RefRef integration и опциональная сеть не превращены в обязательную доступность RefRef. Restricted DML runtime role отделён от migrator. RefRef builder heap 1024/2GiB сохранён; installer 1408 и runtime budgets не менялись ради тестов.                                                                                                                                                            |
| Общий RefRef, не только AI | Сохранены реальные V1 widget/template/custom-rule callers, ordinary Single/Double-Sided setup, discount/coupon transport и signed historical cash balances. AI first-paid restriction не навязана другим программам. Это живые контракты, а не новая legacy-ветка.                                                                                                                                                |
| Оплата                     | Право на первую успешную оплату относится к payer tenant. Промокод без скидки сохраняет привязку; отказ RefRef не запрещает явно выбранную оплату без кода. Цена повторно проверяется сервером до банка; browser return не активирует доступ и не создаёт начисление.                                                                                                                                             |
| Unknown/replay             | Accepted send permission, неизвестный исход банка и незакрытая first-payment claim не освобождаются по таймауту/404/локальной дате. Сохранены обычное продление, повтор запроса с тем же ключом и явный refresh. Не добавлен самовольный outbox/автоматический replay внешних эффектов.                                                                                                                           |
| Self-service               | Опубликованная выбранная программа доступна для чтения до login; join требует своего подтверждённого RefRef аккаунта и согласия с опубликованной версией правил. Банковские реквизиты не нужны для начала участия. Join не даёт membership в организации организатора. Прежнее native signup-создание собственной организации не удалено.                                                                         |
| Аккаунты/коды              | RefRef referrer auth account и AI payer tenant независимы. По совпадению email не присваивается чужая финансовая запись. Сохранены выбранный код 3–32 Latin letters/digits, явный conflict без случайной подмены, несколько кодов/активность/история. Старые 7 символов входят в тот же формат без compatibility branch.                                                                                          |
| Статистика/выплаты         | Покупки агрегируются до join с несколькими rewards, валюты не смешиваются. Начисление pending до Approve Reward; request резервирует деньги; recipient фиксируется за владельцем; повтор completion не списывает повторно. Per-code approved rewards не выдаются за распределение общего payout по кодам.                                                                                                         |
| Почта/возврат              | Собственный SESv2/Postbox transport RefRef и штатные Better Auth verification/resend/reset/invitation callbacks сохранены. Backend sender/секреты не импортированы. Проверены safe callback return, reset token one-time use, privacy ответов и сохранение выбранной программы.                                                                                                                                   |
| Mobile/design              | Нативный marketing block только в оплаченном ЛК, отдельная information page и системный переход в независимый RefRef. Нет вовлечения до оплаты, дополнительных recruitment triggers, новых promo links/click tracking/SSO. UI использует существующие компоненты/токены; новая система дизайна не создавалась.                                                                                                    |
| Chat/Mastra/files          | Серверный tenant/workspace/user resource, private uploader ownership, scope reset, approvals/restart/fencing, transient stream activity и file lifecycle сохраняются. Text/report/JSON cutover включает перенос данных, IDs/versions/body/связей, а не удаление возможности создавать и скачивать материалы. Историческая ownership recovery требует evidence, не угадывает владельца по единственному участнику. |

Факт «у одного человека один email» не доказывает идентичность финансовых субъектов двух приложений. Также tenant-based first-paid policy не является полной защитой от физического лица с несколькими аккаунтами; банковский/KYC противофрод не реализован и не обещается.

## 5. Зависимости: исправления и реальные остатки

Применены официальные security fixes: RE2JS 2.8.7; glob 14.0.2 у проверенных callers; caller-scoped minimatch 11.0.1; mobile MCP Hono node-server 2.1.3. Установленный glob допускает minimatch `^11.0.0`; выбранная версия входит в этот range. Legacy minimatch3 не заменён несовместимым modern API.

Проверены semantic lock graphs, неизменность importers/patch hashes и реальные consumers: async Path objects/name/fullpath, `glob.sync` alias, first-match stream, abort во время обхода без наблюдаемого дальнейшего чтения. Native RE2 lookbehind vector дал 8000 совпадений; это проверка конкретного вектора, не универсальное доказательство сложности. Actual Expo fingerprint Android+iOS одинаков до/после игнорируемой CNG генерации, с Git и без VCS: `8f412fbb3c260b3b7028c8cdfcb8541a36757ee7`.

Прежний вывод «node-forge upstream-blocked на 1.4.0» устарел. Официальный 1.4.1 уже установлен до этого аудита; actual Expo signing SDK PEM/certificate/CSR/development-certificate round trips, independent Node signature verification и отказ tampered manifest проверены. Не применялись vendor crypto patch, alias/fake version или неподтверждённый major selector-parser override. Нужды в PEM-Buffer correction 1.4.2 для string-typed Expo callers не обнаружено. Selector-parser 6.1.5 — официальный исправленный v6 backport с обновлёнными advisory metadata.

| Финальный аудит lock closure | Full                                                                    | Production classification                               |
| ---------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------- |
| RefRef / pnpm                | 1 low deepmerge + 1 moderate legacy minimatch                           | 0                                                       |
| Backend / pnpm               | 2 moderate advisory sources: Hono1, legacy minimatch                    | 1 moderate Hono1                                        |
| Backend / npm                | 13 moderate affected/meta-vulnerable packages, те же 2 advisory sources | 2 moderate affected packages, один Hono advisory source |
| Mobile / pnpm                | 1 low deepmerge + 1 moderate legacy minimatch                           | 1 low Expo configuration deepmerge edge                 |

High/critical в этих проверках нет. «Prod classification» не означает, что весь dev tooling физически отсутствует в backend image: он сохраняет инструменты миграции/TypeScript execution.

- **deepmerge:** registry latest 4.3.1, endpoint 4.3.2 — 404; reviewed GHSA не имеет официальной patched version. Требуемого опубликованного исправления нет.
- **minimatch3:** published legacy-v3 всё ещё 3.1.5; ESLint9 и плагины используют callable/default/`makeRe`, несовместимые с11. Применимость конкретного нового `optimizationLevel` вектора к3 не установлена; finding не скрыт. Координированная ESLint migration не подменяется сломанным override.
- **Backend Hono1:** опубликованный node-ws peer остаётся на node-server1. Это не доказательство невозможности v2 migration. Проверенные API/admin/Mastra пути не монтируют `serveStatic`; private downloads используют scoped object lookup. Reachability assessment не объявляет библиотеку безопасной и не делает audit зелёным.

## 6. Выполненные проверки

| Поверхность                          | Реальный результат                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend full suite после исправлений | 268 files passed/2 conditional skipped; 1909 tests passed/5 conditional skipped; exit0.                                                                                                                                                                                                                                                                                                                                                                                   |
| Пять opt-in backend cases            | Отдельно пройдены real-PG legacy maintenance2, actual Redis orphan-group/live-fanout1, native full SaaS lifecycle/collaboration2. Это не один full run с нулём skips.                                                                                                                                                                                                                                                                                                     |
| Backend качество/installers          | pnpm TypeScript + ESLint passed; strict clean npm CI + complete peer graph + TypeScript passed; native npm subset31 passed. Actual Docker build использовал strict peers, не legacy bypass.                                                                                                                                                                                                                                                                               |
| Native complete SaaS stack           | Реальные disposable PostgreSQL/OpenBao/TLS/SeaweedFS/Redis/API/connector; все secure-registration checks passed: tenant isolation, повтор без mutation, неразглашение до proof, concurrent idempotency, invalid/expired/over-attempt rejection, server-derived scope, spray caps, refresh rotation/logout revocation. Оба existing SaaS tests passed. Provider/model/Postbox endpoints — controlled fixtures, не реальные облачные операции.                              |
| RefRef full quality                  | Root build14/14, zero cached; forced type tasks20/20; отдельно SDK `typecheck`; zero-warning root ESLint; root tests247 = webapp215/API22/refer10. Дополнительно widget6/attribution23/SDK21/utils40/ID28; всего365 non-browser checks.                                                                                                                                                                                                                                   |
| RefRef после удаления no-op config   | Fresh Next webpack89s, TypeScript37.2s,31 pages/traces; webapp types/strict lint/215 tests passed. Assets config отдельно доказана настоящими miss/hit cache runs.                                                                                                                                                                                                                                                                                                        |
| Actual RefRef UI/HTTP/PG             | Независимые verified accounts, выбранный код/consent/join, свой кабинет, foreign403 и отсутствие чужого кода, stale-approval UI error; screenshots390/1280 просмотрены. Затем actual native tRPC: wrong-origin403, pending withdrawal denied, approve225, concurrent один reserve100, frozen recipient, foreign read/withdraw403, synthetic completed100 once, available125; запрос126 отвергнут. Per-code totals2 purchases/1800 paid minor. Реального перевода не было. |
| Mobile                               | TypeScript,657 tests/82 files, весь native lint/JS-TS-JSON formatter passed. Full Chromium112 passed/1 conditional skip,1worker/0retries; unmocked API calls закрыты fixture firewall. API/bank/LLM этой общей серии — mocks. Единственный skip затем отдельно пройден1/1 на настоящем собственном backend/email sink.                                                                                                                                                    |
| Android/iOS/Web export               | Actual Expo export после security install: Web4471/iOS4343/Android4586 modules; оба native14MiB Hermes `.hbc`. Четыре Web JS/CSS runtime файла совпали SHA-256 с полной browser-tested сборкой.                                                                                                                                                                                                                                                                           |
| Android native regression            | Реальная Kotlin/compileSdk36 компиляция и Robolectric SDK30: cancellation regression1/1 без skips/errors; private revert даёт assertion RED, восстановленный патч GREEN. Не полный APK, не Android emulator/device и не iOS native build.                                                                                                                                                                                                                                 |
| Native SDK consumers                 | Expo signing/certificates/CSR + Node crypto; actual fingerprint Git/no-VCS; RE2/glob callers; package SDK tests и строгие types.                                                                                                                                                                                                                                                                                                                                          |

Условный browser skip — `tests/e2e/auth.spec.ts:339`, controlled-email registration/repeat/login: в общей серии не были заданы sink URL/token. Затем этот существующий сценарий отдельно прошёл1/1 с одним worker и без retries на настоящем собственном API/Postbox-compatible sink: регистрация, повтор без подмены аккаунта и вход. Использован тот же Expo Web bundle и штатный `window.__APP_CONFIG__.API_BASE_URL`, без API/auth mocks и без изменения приложения. Это всё ещё не cloud Postbox receipt.

Дополнительно из того же чистого npm graph пройдены13/13 `billing-checkout-repository.integration.test.ts` на настоящем PostgreSQL: в том числе выбор актуального renewal при старом expired и запрет нового ключа для expired, но ещё потенциально payable первой оплаты. Это два целевых npm run31+13, не утверждение полного npm full-suite run.

### Ресурсы и ошибки fixtures

Две свежие bounded RefRef сборки завершились при 2GiB/1CPU/no-swap и V8 old-space1024. Последний full-root run: `memory.peak=2147483648`, `max=129`, `oom=0`, `oom_kill=0`; highest500ms sample: anon1861824512/file230801408/kernel44531712. Следующий fresh webapp run также достиг2GiB, `max=156`, без OOM. Это успешные измеренные runs под давлением, **не доказательство запаса памяти или гарантированной повторяемости**. Не выводится «минимально нужно2.44GiB» из другого filtered graph.

Исправлены только ошибки собственной verification среды: executable SWC/Conscrypt cache при noexec `/tmp`, недостающие private Android SDK components, неверный standalone Origin/принудительный POST query и первоначально неверный runner для Vitest mjs. Продуктовые проверки/CSRF/peer validation для этого не отключались. Private CNG сравнение сначала содержало лишний manifest delta; сравнение повторено на одинаковых установленных sources, включая no-VCS режим.

При первом объединении UI создал tenant до SaaS case, который явно требует чистую базу; его precondition корректно остановил проверку. Только private driver переставлен: clean-db gates перед изменяющим БД UI. Повторный общий запуск дал secure-registration PASS, SaaS2/2 и live OTP UI1/1; assertion и продуктовый код не ослаблялись.

## 7. Конкретные ограничения

- Security audit остаётся non-zero по таблице; никакие advisories не подавлены. ESLint9 upstream уже помечен unsupported; это отдельный согласованный migration scope, не повод менять правила на несовместимые ради цвета.
- Global backend `format:check` flags65 файлов, byte-identical как pre-task base, так и старту аудита; task-owned source форматирован. Не утверждается зелёный global formatter.
- Android/iOS устройства/эмулятор и Xcode недоступны. Web, Hermes export и Robolectric не доказывают iOS gestures/keyboards/browser return, нативный Android UI, APK/IPA/EAS build или OTA delivery. HTTPS App/Universal Links в этом аудите не подтверждены.
- Нет настоящего платежа банка, settlement, возврата/перевода, cloud Postbox receipt, внешнего LLM/provider run, production OpenBao/network/activation или representative production-money restore. Все изменяющие данные проверки использовали собственные disposable данные.
- При неизвестном исходе банка safe recovery может потребовать оператора. Межсервисная доставка после COMMIT без outbox требует существующего explicit refresh/manual repair при потере ACK; автоматические переводы/retries не добавлены.
- Юридический текст остаётся draft. Реальные реквизиты организатора, применимость НПД/ИП и налоговая модель не утверждены; checkbox не снимает законные обязанности организатора. Банковская проверка реквизитов, KYC и налоговый engine отсутствуют, как и обещание их наличия.

## 8. Основания и первичные ссылки

- [React Native0.86 Linking — Android/iOS](https://reactnative.dev/docs/0.86/linking).
- [Expo SDK57 WebBrowser](https://docs.expo.dev/versions/v57.0.0/sdk/webbrowser/) и [FileSystem](https://docs.expo.dev/versions/v57.0.0/sdk/filesystem/); установленный SDK остаётся решающим для конкретных signatures/cancellation.
- [Mastra RequestContext](https://mastra.ai/docs/server/request-context); версии1.76 проверены также по установленным source/types и actual runtime.
- [assistant-ui React Native](https://www.assistant-ui.com/docs/react-native) и установленный `@assistant-ui/react-native@0.1.44`.
- [Better Auth native email/password/verification](https://www.better-auth.com/docs/authentication/email-password).
- [tRPC batch stream link и native transport](https://trpc.io/docs/client/links/httpBatchStreamLink).
- [Next native server package opt-outs](https://nextjs.org/docs/app/api-reference/config/next-config-js/serverExternalPackages) и [memory guide](https://nextjs.org/docs/app/guides/memory-usage); matching дополнительно проверен в установленном16.4.2.
- [Turborepo package configurations2.11.7](https://github.com/vercel/turborepo/blob/v2.11.7/apps/docs/content/docs/reference/package-configurations.mdx); поведение реально исполнено на2.11.9.
- [OpenTelemetry SDK2.12 API peer metadata](https://registry.npmjs.org/@opentelemetry%2fcontext-async-hooks/2.12.0).
- [Yandex Postbox SDK delivery](https://yandex.cloud/ru/docs/postbox/operations/send-email).
- [RE2JS advisory](https://github.com/advisories/GHSA-gg6h-894w-4m9c), [glob14 release](https://registry.npmjs.org/glob/14.0.2), [deepmerge advisory](https://github.com/advisories/GHSA-gcqx-w48m-w2h4), [Hono advisory](https://github.com/advisories/GHSA-rmxm-3fg6-px4f), [minimatch advisory](https://github.com/advisories/GHSA-g3hv-75wg-m249), [forge advisory](https://github.com/advisories/GHSA-86w9-cpqp-85rv), [selector-parser advisory](https://github.com/advisories/GHSA-rj75-hqrm-r3gf).

Source inspections независимых finance/native/backend/dependency reviewers использованы как дополнительный review, не как выдуманное исполнение тестов. Все runtime/check результаты в таблице получены главным процессом аудита. Полные первоначальные инвентаризации и журналы проверок сохранены отдельно; секреты и одноразовые credentials в отчёт не включены.

## 9. Состояние после аудита

Повторная проверка4664 исходных файлов не обнаружила удалённых стартовых файлов или посторонней перезаписи: дельты ограничены намеренными исправлениями/документацией/форматированием task-owned source. Все три HEAD, staged objects/modes/paths и исходные index flags сохранены. Generated ACME declaration совпадает с начальным файлом побайтово.

Остановлены только собственные PostgreSQL/Redis/standalone/browser/static-frontend services. Собственные сети, image tags, одноразовые credentials, тестовые копии, exports и Android SDK удалены; существующие приложения/контейнеры и общие dependency/build caches не останавливались и не очищались. В owner-only каталоге вне Git оставлены12 стартовых снимков и3 безопасных UI evidence images; каталог0700, файлы0600.
