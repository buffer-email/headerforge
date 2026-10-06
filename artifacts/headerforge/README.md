# HeaderForge

HeaderForge is a local-first Manifest V3 extension for Chromium-based browsers. It applies request and response header rules through Chromium's `declarativeNetRequest` engine. Profiles, tokens, rules, and settings are stored in the browser's local extension storage; the extension makes no analytics or telemetry requests.

## Build and install locally

From the workspace root:

```sh
pnpm --filter @workspace/headerforge run package:extension
```

The command creates:

- `artifacts/headerforge/dist/public/` — unpacked extension directory
- `artifacts/headerforge/dist/headerforge-chromium.zip` — zipped extension package

`package:extension` runs the Vite build first (`PORT=4173`, `BASE_PATH=/` unless already set) and then zips
`dist/public`. `pnpm --filter @workspace/headerforge run build` produces the same `dist/public` directory without the
zip.

To load the unpacked extension:

1. Open `chrome://extensions` (or the equivalent extensions page in Edge, Brave, Arc, or Opera).
2. Turn on **Developer mode**.
3. Choose **Load unpacked** and select `artifacts/headerforge/dist/public/`.

Minimum supported Chromium version is 111 (`minimum_chrome_version` in the manifest).

## Permission and privacy notes

HeaderForge needs access to all sites because its purpose is to apply user-authored rules to arbitrary URL patterns. The extension does not read page contents and does not send stored values off the device. Browser-native header modification is performed by declarative network rules, not by a request proxy or per-request background script.

Requested in `public/manifest.json`:

| Permission | Why it is needed |
| --- | --- |
| `declarativeNetRequestWithHostAccess` | Installs the `modifyHeaders` rules that set, append, and remove headers, and grants access to header names/values in the request and response APIs. |
| `storage` | Persists the configuration in `chrome.storage.local`. |
| `alarms` | Service-worker timer used to refresh clock-based tokens. |
| Host access `http://*/*`, `https://*/*` | URL filters can target any site. Host access is deliberately narrowed from `<all_urls>`, which would also cover `file://`, `ftp://`, `chrome://`, and extension pages. |

Deliberately not requested:

- `tabs` — `chrome.tabs.query` works without it and exposes `Tab.id`, which is all tab-scoped DNR rules need. No
  titles, URLs, or other tab metadata are read.
- `scripting`, `activeTab`, `webRequest`, `webRequestBlocking`, `cookies`, `history`, `bookmarks`, `management` — no
  content scripts, no request interception, no browser-state access.
- No remote code and no remotely hosted anything: the CSP below forbids it at runtime as well as at review time.

### Security and privacy posture

- All state lives in `chrome.storage.local` under the key `headerforge.config`. The worker also writes a small
  `headerforge.status` record there. Nothing is sent anywhere; there is no account and no backend.
- No telemetry, no analytics, no crash reporting, no remote fonts. `src/index.css` uses system font stacks only
  because a Google Fonts `@import` would fire a third-party request every time the popup opens.
- Extension CSP is declared explicitly in the manifest and does not permit remote sources:

  ```
  script-src 'self'; object-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;
  font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; connect-src 'self'
  ```

- Nothing is executed remotely: there is no `eval`, and the only bundled code is the build output.
- Exports and clipboard copies contain your header values verbatim. Keep them private if a profile holds
  credentials.

## Supported features

- Request and response headers with set, append, remove, and per-rule enablement
- Multiple profiles with independent enablement and priority order
- URL wildcard and regular-expression filters, plus resource-type filters
- Global pause and current-tab-only scope
- HeaderForge JSON backup/restore and ModHeader-style JSON import
- Dynamic timestamp, ISO date, UUID, and bounded random-integer value tokens
- Extension badge count and a visible error state when Chromium rejects rules

## Dynamic tokens

Tokens are expanded in the service worker at rule-compile time (`expandDynamicTokens` in `src/lib/dnr.ts`):

| Token | Expands to |
| --- | --- |
| `{{$timestamp}}` | Current time as Unix seconds. |
| `{{$isoDate}}` | `new Date().toISOString()`. |
| `{{$uuid}}` | `crypto.randomUUID()`. |
| `{{$randomInt(min,max)}}` | Integer in `[min, max]`, inclusive. Non-integer bounds or `max < min` drop the rule with a warning. |

`{{$randomInt(1,10)}}` is the example shown in the dashboard's token helper.

Clock tokens are refreshed by the worker through the `headerforge.refresh-dynamic-headers` alarm (intended cadence:
one minute). Note that in the current source the worker only *listens* for that alarm — no `chrome.alarms.create`
call exists — so `{{$timestamp}}` and `{{$isoDate}}` currently re-expand whenever some other event triggers a sync
(service-worker start, storage change, tab activation while scope is "current tab", or a `CONFIG_UPDATED` message).

## Limits

From `src/lib/limits.ts` and `MAX_HEADERFORGE_RULES` in `src/lib/dnr.ts`:

| Limit | Value |
| --- | --- |
| Profiles per configuration | 200 |
| Header rules per profile | 500 |
| URL filters per profile | 200 |
| Header name length | 128 characters, RFC 9110 token charset only |
| Header value length | 1024 characters, no control characters (`0x00`-`0x1F`, `0x7F`) |
| URL pattern length | 1024 characters |
| Profile name length | 64 characters (truncated on load) |
| Generated ID length | 64 characters |
| URL tester input length | 2048 characters |
| Import size cap | 8 MiB (`MAX_IMPORT_BYTES`) |
| Compiled DNR rule ceiling | 4,500 |

Exceeding the compiled rule ceiling fails the whole sync: the configuration expands to more than 4,500
`(URL condition, direction, operation)` groups. Because rules are grouped, 500 headers behind one filter cost far
fewer than 500 rules.

`MAX_IMPORT_BYTES` is enforced by `readImportText()` in `src/lib/import-utils.ts`, but no call site in the current
UI imports it — the popup and dashboard parse pasted and picked files directly with `JSON.parse`. Treat the 8 MiB
figure as the defined cap, not as one the UI currently blocks on.

## Storage safety

Imported data is normalised before it is stored (`normalizeConfig` in `src/lib/storage.ts`):

- Structural problems reject the file: not an object, no `profiles` array, no boolean `masterEnabled`, or more than
  200 declared profiles.
- Problems confined to a single rule do not. An invalid header name, header value, URL pattern, resource type, or
  duplicate id is dropped, and a warning naming the dropped rule is recorded. The rest of the profile imports.
- Over-limit collections are truncated to the caps above (first N kept) with a warning, rather than failing.
- Legacy booleans are coerced strictly: `"false"`, `"no"`, and `"0"` are read as disabled. The string `"false"` is
  truthy in JavaScript, so treating it as truthy would silently enable a profile the author turned off.
- `enabled` uses a stricter rule than the other flags, because getting it wrong rewrites traffic rather than merely
  changing a preference. A missing `enabled` key takes the format default (on, since legacy formats have no such
  key). A key that *is* present but unreadable — `true`/`false` are the only values accepted — is read as **disabled**
  and warned about, so `"yes"`, `1`, and typos can never silently switch rewriting on. `masterEnabled` follows the
  same rule.
- `masterEnabled` is stored exactly as authored. It is not forced off just because no profile is currently enabled;
  that is the normal "engine on, nothing selected yet" state, and no rules are compiled without an enabled profile.
- Merge mode appends imported profiles below existing ones (profile order sets rule priority) and re-validates the
  incoming configuration; replace mode installs it as-is after the same validation. Both modes regenerate ids.

`parseConfigurationImport` returns a `warnings` array for these repairs. The current dashboard and popup toast the
import outcome but do not display the per-rule warning text.

## Keyboard shortcuts

None. There are no keyboard shortcuts in the current implementation — `src/App.tsx` registers no `keydown`
handlers and `src/hooks` contains only the mobile-detection and toast hooks. Every action is pointer-driven. (The
unmounted shadcn `src/components/ui/sidebar.tsx` contains a `Ctrl`/`Cmd`+`B` handler for its own sidebar; it is not
part of the shipped UI.)

## Troubleshooting

**The badge shows `!`**

`setError()` in `src/background.ts` sets the badge to `!` after Chromium rejected the rule set. The worker clears
its rules and stores the truncated error message in `headerforge.status` (also in the action tooltip title). Usual
causes: the configuration expands past 4,500 compiled DNR rules, a rule exceeded a Chromium-side limit, or
`updateDynamicRules` rejected the payload. Fix the configuration, save, and the badge clears on the next sync.

**Rules are not applying**

Work through these in order — they are the actual conditions in `getActiveProfiles` / `compileDnrRules`:

1. The master toggle is on. `masterEnabled: false` compiles to zero rules regardless of profile state.
2. The profile is enabled **and** present in `activeProfileIds`. Both are required; the compiled set is the
   intersection.
3. Each header rule has its own enable checkbox ticked. Disabled rules are skipped during compilation.
4. The URL filter matches. Wildcard patterns are anchored to the whole URL with `*` as `[\s\S]*`, case-insensitive;
   regex filters are case-insensitive. Test a URL in the options dashboard's URL tester, which runs the same
   matcher locally.
5. Resource-type restrictions line up. When a header and its filter both restrict resource types, only the
   intersection applies; a disjoint pair compiles to nothing at all. No selection means "all types".
6. Scope is not blocking you. With the scope set to the current tab, rules are installed as session rules pinned to
   the active tab; if no tab id is available, the worker clears all rules rather than leaking global ones.
7. The header is one Chromium refuses to modify. `FORBIDDEN_REQUEST_HEADERS` and `FORBIDDEN_RESPONSE_HEADERS` in
   `src/lib/limits.ts` are dropped at compile time with a warning (for example `Host`, `Cookie`, `Origin`,
   `Content-Length`, `Set-Cookie`, `Strict-Transport-Security`).
8. Two rules with the same match and the same operation but the same header name: Chromium rejects duplicates inside
   one action, so only the first is applied and the second is reported.
9. Give the worker a moment. Storage writes are debounced by 250 ms, so a change takes up to a quarter second to
   reach the rule engine. If the compiled rule set is byte-identical to what is installed, the update is skipped
   entirely.

## Browser notes

The popup and options page require the extension to be loaded in a Chromium-based browser to access extension storage and the network-rule API. The Replit preview is a local-storage-backed UI preview; it cannot modify browser traffic. Some response headers and reserved request headers are restricted by Chromium, and regular expressions must be supported by Chromium's DNR/RE2 implementation.