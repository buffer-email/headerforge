---
name: HeaderForge product constraints
description: Core deliverable and local-only data requirements for HeaderForge.
---

HeaderForge's core product is an installable Chromium Manifest V3 extension; the web UI is a control dashboard and preview, not the browser network-modification runtime. Store header rules, token values, and profiles only in extension-local storage. Do not add a backend or telemetry for this data.

**Why:** the user described HeaderForge as an installable browser extension and required local-only handling for request/response rules and potentially sensitive header values.

**How to apply:** When changing persistence, request interception, import/export, or packaging, keep runtime behavior in the extension, preserve local-only storage, and treat the Replit preview as UI-only.
