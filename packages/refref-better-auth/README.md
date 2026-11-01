# @refref/better-auth

Server-side signup attribution for Better Auth. This checkout contains local hardening changes; no package has been published. Consume the built package from this fork when integrating it, not an assumed equivalent registry release. The sibling backend/mobile applications are not connected automatically.

Verified with Better Auth 1.7.11 and Node.js 24. See the [root deployment instructions](../../README.md) for the isolated development stack and bounded build/test commands.

## Strict TypeScript consumers

Better Auth's public plugin type references both Node and Bun SQLite adapters, even when the application uses another database. Install genuine declarations, not local `declare module` substitutes:

```bash
npm install --save-dev @types/node@24.19.2 bun-types@1.3.14
```

Select only the required Bun SQLite declaration alongside the Node declarations:

```json
{
  "compilerOptions": {
    "types": ["node", "bun-types/sqlite"],
    "skipLibCheck": false
  }
}
```

Node 22 consumers use `@types/node@22.20.5` instead. This loads the upstream SQLite module declaration, not unrelated Bun global overrides or a Bun runtime. JavaScript consumers do not need these optional type peers. The bundler's `node16` syntax target is not a promise of Node 16/20 runtime support.

## Configuration

Add this plugin to your existing Better Auth plugin list; keep the existing database, providers and other authentication options:

```typescript
import { refrefAnalytics } from "@refref/better-auth";

const analytics = refrefAnalytics({
  apiKey: process.env.REFREF_API_KEY!,
  productId: process.env.REFREF_PRODUCT_ID!,
  apiUrl: process.env.REFREF_API_URL!,
  programId: process.env.REFREF_PROGRAM_ID,
});
```

Required server environment:

```dotenv
REFREF_API_KEY=your_product_authorized_service_key
REFREF_PRODUCT_ID=your_product_id
REFREF_API_URL=http://127.0.0.1:4310/tracking
```

The URL is explicit: there is **no external hosted default**. The loopback example works from the development server itself; a different container needs an explicitly approved route to the gateway, not a shared database. Keep service keys on the backend, never in browser/mobile bundles.

| Option | Behavior |
| --- | --- |
| `apiKey`, `productId`, `apiUrl` | Required. The API checks that the product/program belongs to the key's organization. Keys are organization-wide, not single-product credentials. |
| `programId` | Optional explicit program selection. |
| `cookieName` | Defaults to `refref-refcode`, matching the attribution script. |
| `disableSignupTracking` | Disables automatic user-creation tracking. |
| `customSignupTrack` | Trusted asynchronous replacement for the default HTTP delivery. Do not log its user data; bound your own I/O. |

The plugin uses the native database `user.create.after` hook, not a synthetic HTTP path. Both `auth.handler(request)` and direct server `auth.api.signUpEmail({ headers, body })` calls retain attribution. A normal sign-in does not create another signup event. Effective endpoint headers take precedence over the original request headers.

## Referral cookie

The referral URL parameter is `refcode`; the cookie is `refref-refcode`. Its value is an opaque code, not a name, email, participant identifier or authentication credential.

The supplied attribution script handles this for browser integrations. A minimal equivalent first-party cookie example:

```typescript
const refcode = new URL(window.location.href).searchParams.get("refcode");
if (refcode) {
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `refref-refcode=${encodeURIComponent(refcode)}; Path=/; Max-Age=2592000; SameSite=Lax${secure}`;
}
```

Native cookie parsing preserves encoded values. `extractRefcodeFromRequest(request, cookieName?)` and `extractRefcodeFromContext(context, cookieName?)` are also exported; the latter supports request-based and headers-only endpoint contexts.

## Manual event delivery

Use the separately exported client. Better Auth does **not** expose an injected `auth.api.refrefClient`:

```typescript
import { RefRefAPIClient } from "@refref/better-auth";

const client = new RefRefAPIClient(
  process.env.REFREF_API_KEY!,
  process.env.REFREF_API_URL!,
);

const result = await client.trackPurchase({
  timestamp: new Date().toISOString(),
  productId: process.env.REFREF_PRODUCT_ID!,
  programId: process.env.REFREF_PROGRAM_ID,
  payload: {
    userId: "external-user-id",
    orderId: "stable-order-id",
    orderAmount: 99.99,
    currency: "USD",
  },
});

if (!result.success) {
  // A bounded diagnostic, never the raw transport error or response body.
  throw new Error(result.message);
}
```

The supported methods are `trackSignup` and `trackPurchase`. There is no generic custom-event endpoint. Exported types include `RefRefPluginOptions`, `SignupTrackingData`, `SignupTrackingPayload`, `PurchaseTrackingPayload`, `TrackingResponse` and `TrackingEventData`.

## Delivery and privacy boundaries

- HTTP(S) API bases only; URL credentials, queries and fragments are rejected. Redirects are not followed with service credentials.
- Each default HTTP delivery has a five-second deadline. Non-success response bodies are cancelled, not logged; successful data is schema-validated and restricted to event/participant/referral identifiers.
- Account creation is not rolled back when attribution fails. The plugin emits only a generic failure diagnostic; it does not log names, emails, referral codes or raw errors. Delivery is best-effort and has no automatic retry.
- The host application's own logging, telemetry and custom callbacks remain its responsibility. Disable Better Auth telemetry in the host configuration when required.

## Verification

After preparing the disposable test environment described in the root README:

```bash
node scripts/dev.mjs run corepack pnpm --filter @refref/better-auth test
node scripts/dev.mjs run corepack pnpm --filter @refref/better-auth typecheck
node scripts/dev.mjs run corepack pnpm --filter @refref/better-auth build
```

Tests exercise native Better Auth account-creation/sign-in transitions and a real loopback HTTP server, including headers-only attribution, disabled/failing delivery, URL rejection, response validation and PII-free diagnostics.

## License

This package declares MIT licensing in its package metadata. The RefRef server repository is AGPL-3.0; do not treat the package metadata as changing the server's license.
