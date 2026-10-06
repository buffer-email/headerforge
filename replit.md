# HeaderForge

HeaderForge is a Chromium Manifest V3 extension for setting, appending, and removing request and response headers, with a popup for quick toggles and an options dashboard for profiles, URL filters, and imports.

## Run & Operate

```sh
pnpm --filter @workspace/api-server run dev   # build + start the API server on $PORT
pnpm run typecheck                           # full typecheck across all packages
pnpm run build                               # typecheck + build all packages
pnpm --filter @workspace/api-spec run codegen # regenerate API hooks and Zod schemas from the OpenAPI spec
pnpm --filter @workspace/db run push         # push DB schema changes (dev only)
pnpm --filter @workspace/headerforge run package:extension # build the unpacked extension + zip
```

### Environment

api-server variables. Every one is read directly from `process.env`; nothing has an in-repo default except where noted.

```sh
PORT=5000                        # REQUIRED. No default. index.ts throws on missing or non-positive/non-numeric.
CORS_ORIGINS=https://app.example.com
                                # Comma-separated allowlist, matched exactly against the request Origin.
                                # Unset/empty (default) = same-origin only; logs a warning at boot.
                                # "*" = fully open CORS; logs a warning. Never the default.
CORS_CREDENTIALS=false           # Default off. Only the exact string "true" enables credentials.
                                # Ignored when CORS_ORIGINS="*" (browsers reject that combination).
RATE_LIMIT_MAX=300               # Requests per window per client IP. Default 300. Non-positive-int falls back to 300.
RATE_LIMIT_WINDOW_MS=60000       # Window length in ms. Default 60000. Also caps the bucket-sweeper interval.
TRUST_PROXY_HOPS=0               # Default 0 = trust nothing. Positive int = Express `trust proxy` hop count,
                                # and it flips the rate limiter onto req.ip. Use 1 for Replit's edge.
LOG_LEVEL=info                   # Default "info". debug/trace are forced up to info when NODE_ENV=production.
NODE_ENV=production              # Unset by default. "production" disables the pino-pretty transport.
DATABASE_URL=postgres://...      # Postgres connection string. Read by @workspace/db
                                # (lib/db/src/index.ts) and drizzle.config.ts; both throw if unset.
                                # No api-server source file reads it today.
```

Extension build variables (`artifacts/headerforge/vite.config.ts`; `package:extension` supplies `PORT=4173` and `BASE_PATH=/` if unset):

```sh
PORT=4173                        # Vite dev server port for the extension UI preview.
BASE_PATH=/                      # Vite base path.
NODE_ENV                         # Anything but "production" enables the Replit dev banner/runtime-error plugins.
REPL_ID                          # Presence (any value) is the flag that turns those Replit dev plugins on.
```

### Do not pass generic type arguments to JSX elements

`@replit/vite-plugin-cartographer` (enabled whenever `REPL_ID` is set) rewrites component tags by injecting
attributes immediately after the tag name. That is invalid for a tag carrying explicit type arguments:

```tsx
<VirtualList<HeaderRule> ... />   // becomes <VirtualList data-replit-metadata="..." <HeaderRule> ... />
```

Vite then fails the whole module with `Unexpected token` and serves `App.tsx` as a **500**, so the dev server and the
error overlay show nothing but a parse error while `tsc` passes and the production build succeeds. Let the type be
inferred from props instead:

```tsx
<VirtualList items={headers} ... />   // T infers from items
```

`tsc` cannot catch this, because the source is valid; only a request for the module does. Verify with
`REPL_ID=1 pnpm --filter @workspace/headerforge run dev` and then request the page, or build with the plugin active.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)
- Extension: React + Vite + wouter, `declarativeNetRequest`, Manifest V3

## Where things live

- `artifacts/headerforge` — the deliverable extension. `public/manifest.json` (permissions, host access, CSP),
  `src/background.ts` (service worker: storage→DNR sync, badge, alarms), `src/lib/dnr.ts` (rule compilation),
  `src/lib/storage.ts` (config load/save/normalise), `src/lib/import-utils.ts` (backup + ModHeader import),
  `src/lib/limits.ts` (resource limits and field validators), `src/App.tsx` (popup + options dashboard).
- `artifacts/api-server` — Express app. Serves only `GET /api/healthz`. The extension does **not** talk to it;
  the extension is local-first and all rule state lives in `chrome.storage.local`. Do not add extension data here.
- `artifacts/mockup-sandbox` — UI scratch space, not shipped.
- `lib/api-spec/openapi.yaml` + `orval.config.ts` — source of truth for API contracts; regenerate hooks/Zod with codegen.
- `lib/api-zod` — shared response schemas consumed by the server (`HealthCheckResponse`).
- `lib/db` — Drizzle schema and pool; owns `DATABASE_URL`.

## Architecture decisions

- DNR rules are grouped by (URL condition, direction, operation) rather than one rule per header. A profile with
  hundreds of headers behind one filter collapses to a handful of rules. Chromium charges against both the rule
  budget and per-request evaluation cost, so the grouping is what keeps large configurations cheap.
- Syncs use `removeAllRules: true` instead of enumerated `removeRuleIds`. The previous implementation rebuilt and
  IPC-serialised 4,500-element id arrays on every single sync.
- The service worker debounces storage writes and fingerprints the compiled rule set (FNV-1a over ids, priorities,
  header triples, and conditions). An identical update skips the DNR round trip, so per-keystroke storage writes
  never cross the IPC boundary.
- The extension does not request the `tabs` permission. `chrome.tabs.query` is still usable and exposes `Tab.id`,
  which is all that tab-scoped DNR rules need. Host permissions are narrowed from `<all_urls>` to
  `http://*/*` + `https://*/*`.
- Zero third-party network requests. No remote fonts (system font stacks only), no analytics, no CDN. The manifest
  CSP pins `script-src`/`font-src`/`img-src`/`connect-src` to `'self'` and `data:`.
- Rule-level validation drops and reports bad rules instead of failing the whole sync. One malformed header or URL
  pattern is skipped with a warning in `CompileResult.problems`; the remaining rules still install.

## Product

Users create profiles of header rules, attach URL filters (wildcard or regex) and resource-type restrictions, and
layer several profiles at once; profile order sets rule priority. Scope is either all tabs or the current tab only,
and a master toggle pauses everything. Configuration is exported/imported as HeaderForge JSON, and ModHeader-style
JSON exports are accepted and converted.

## User preferences

- Header rules, tokens, and profile data stay in extension-local storage. No backend, no telemetry.
- The Replit web preview is a UI preview; it cannot modify browser traffic.

## Gotchas

- The rate limiter is an in-memory `Map` keyed by client IP, so the counter is per process. `.replit` sets
  `deploymentTarget = "autoscale"`, which means the effective global ceiling is `RATE_LIMIT_MAX x instance count`.
  A real global limit needs a shared store or an edge/gateway limiter.
- `trust proxy` is off unless `TRUST_PROXY_HOPS` is set to a positive integer. With it off, `req.ip` is not
  proxy-derived and the limiter falls back to `req.socket.remoteAddress`; with a wrong hop count, attacker-supplied
  `X-Forwarded-For` values would forge `req.secure` (silently enabling HSTS over plain http) and mint unlimited
  limiter identities.
- `/api/healthz` is deliberately skipped by the rate limiter. A 429 from the health probe gets an instance flagged
  unhealthy and killed instead of replaced.
- The logger redacts `authorization`, `cookie`, `set-cookie`, `x-api-key`, `x-auth-token`,
  `proxy-authorization`, and `x-forwarded-for`; the request serializer logs the path only, never the query string.
- `helmet` is not a dependency and must not be added — security headers are hand-rolled in `src/lib/security.ts`.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details