# RefRef Refer Server

Public-facing Fastify server for handling referral redirects.

## Overview

The refer server provides public endpoints for:

- **Referral Link Redirects** (`/:id`) - Redirects referral links to target URLs with attribution

## Development

### Run Development Server

```bash
# Start refer server (port 3002)
pnpm -F @refref/refer dev

# Set TEST_DATABASE_URL to a disposable, migrated test database, then run tests.
pnpm -F @refref/refer exec vitest run --maxWorkers=1 --minWorkers=1
```

Redirect regressions execute real SQL against `TEST_DATABASE_URL`; its database
name must contain `test`. They create randomized multi-product fixtures and
delete only those fixtures afterward. Never point this setting at an existing
application database. Health tests retain their isolated database mock.

### Environment Variables

Create `.env` in the refer app directory:

```bash
# Database
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/refref"

# Server Configuration
PORT=3002
HOST="0.0.0.0"
LOG_LEVEL="info"
NODE_ENV="development"
```

## API Endpoints

### Referral Link Redirect

```
GET /:code
GET /:productSlug/:slug
```

Globally unique referral codes resolve directly. Vanity slugs resolve only
within the named product, even when multiple products use the same slug.

The destination is the program's configured landing page. Existing query
parameters (including repeated values) and fragments are preserved. The only
attribution parameter added is the opaque `refcode`, replacing any stale
`refcode` in that URL. Participant names, email addresses and participant IDs
are never added, including in encoded form.

**Response:**

- `307 Temporary Redirect` - Redirects to the landing page with opaque attribution
- `404 Not Found` - Unknown product, code or vanity link
- `500 Internal Server Error` - Landing page missing or redirect processing failed

### Health Check

```
GET /health
```

Returns server health status.

**Response:**

```json
{
  "status": "ok",
  "timestamp": "2025-01-01T00:00:00.000Z"
}
```

## Architecture

### Key Features

- **Fastify Framework** - High-performance web framework
- **CORS Enabled** - Allows cross-origin requests
- **Rate Limiting** - Prevents abuse (100 requests/minute global limit)
- **Graceful Shutdown** - Handles SIGINT/SIGTERM signals
- **Structured Logging** - JSON-formatted logs via Pino

### Directory Structure

```
apps/refer/
├── src/
│   ├── index.ts           # Server entry point
│   ├── routes/
│   │   ├── health.ts      # Health check endpoint
│   │   └── r.ts           # Referral link redirects
│   └── app.ts             # Fastify app setup
├── test/                  # Vitest tests
├── package.json
├── tsconfig.json
└── README.md
```

## Production Deployment

### Referral Redirect Deployment

The `/:id` redirect endpoint can be deployed as:

- **Cloudflare Workers** - Global edge deployment
- **Vercel/Netlify** - Serverless functions
- **Traditional Server** - Docker container or VPS

Ensure database connection is configured properly for production.

## Testing

```bash
# Run all tests
pnpm -F @refref/refer test

# Watch mode
pnpm -F @refref/refer test:watch

# With UI
pnpm -F @refref/refer test:ui
```

Tests use:

- **Vitest** - Fast test runner
- **Playwright** - HTTP request testing
- In-memory database or mocks

## Performance Optimization

### Referral Redirect Optimization

The `/:slug` endpoint is highly optimized:

1. **Database Index** - `referral_link.slug` has an index for fast lookups
2. **Single Query** - Uses JOIN to fetch all data in one query
3. **Connection Pooling** - Efficient database connection management
4. **Minimal Processing** - Direct redirect without complex logic

## Troubleshooting

### Referral Redirects Not Working

1. Check database connection
2. Verify referral link exists in database
3. Check server logs for errors
4. Ensure database index exists on `referral_link.slug`

### Port Already in Use

Change port in `.env`:

```bash
PORT=3003
```

## Related Documentation

- [apps/assets](../assets/README.md) - Production script serving
- [apps/api](../api/README.md) - Authenticated API endpoints
- [apps/webapp](../webapp/README.md) - Web application
- [packages/coredb](../../packages/coredb/README.md) - Database schema
