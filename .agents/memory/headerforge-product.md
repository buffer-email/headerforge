---
name: HeaderForge product constraints
description: Core deliverable and local-only data requirements for HeaderForge.
---

HeaderForge's core product is an installable Chromium Manifest V3 extension; the web UI is a control dashboard and preview, not the browser network-modification runtime. Store header rules, token values, and profiles only in extension-local storage. Do not add a backend or telemetry for this data.

**Why:** the user described HeaderForge as an installable browser extension and required local-only handling for request/response rules and potentially sensitive header values.

**How to apply:** When changing persistence, request interception, import/export, or packaging, keep runtime behavior in the extension, preserve local-only storage, and treat the Replit preview as UI-only.

## Hardening invariants (established after the security + scalability pass)

The rule-sync pipeline, the permission set, and the network posture below are load-bearing. Simplifying them
regresses performance or the privacy promise.

- **Grouped DNR compilation, `removeAllRules`, and debounced + fingerprinted sync are load-bearing for
  performance.** `compileDnrRules` groups headers into one rule per `(URL condition, direction, operation)` bucket
  instead of one rule per header; the worker replaces the rule set with `removeAllRules: true` rather than an
  enumerated `removeRuleIds` array (the old code built 4,500-element id arrays on every sync); and the worker
  debounces storage writes and fingerprints the compiled rule set so identical updates never cross the IPC boundary.
  **Why:** Chromium charges against both the rule budget and per-request evaluation cost, and a full rule payload per
  keystroke was the dominant cost. **How to apply:** do not "simplify" these back to per-header rules or enumerated
  id arrays when refactoring `src/lib/dnr.ts` or `src/background.ts`.
- **Zero third-party network requests is a hard product invariant.** No remote fonts, no analytics, no CDN, no
  remotely hosted code. System font stacks only. **Why:** it is the same privacy promise as local-only storage — a
  font `@import` alone would fire a request on every popup open. **How to apply:** the manifest
  `content_security_policy.extension_pages` enforces it (`script-src`/`font-src`/`connect-src` `'self'`,
  `img-src 'self' data:`); do not widen it, and do not add a dependency that pulls remote assets.
- **Never reintroduce the `tabs` permission.** `chrome.tabs.query` works without it and exposes `Tab.id`, which is
  all tab-scoped DNR needs. Host permissions stay narrowed to `http://*/*` + `https://*/*`. **Why:** `tabs` would
  expose tab titles and URLs the product has no use for. **How to apply:** if a change seems to need `tabs`, it
  almost certainly needs `Tab.id` instead.
- **`artifacts/api-server` is a stub for health checks and must not become a store for extension data.** It serves
  only `GET /api/healthz`. **Why:** any extension data sent there would break the local-only constraint above.
  **How to apply:** treat adding extension endpoints, storage, or analytics to the API server as a product change
  that needs explicit user sign-off.

Also established: rule-level validation drops and reports bad rules instead of failing the whole sync, and import
repairs invalid rules with warnings rather than rejecting a file — one typo must never silently disable every rule.
