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

To load the unpacked extension:

1. Open `chrome://extensions` (or the equivalent extensions page in Edge, Brave, Arc, or Opera).
2. Turn on **Developer mode**.
3. Choose **Load unpacked** and select `artifacts/headerforge/dist/public/`.

## Permission and privacy notes

HeaderForge needs access to all sites because its purpose is to apply user-authored rules to arbitrary URL patterns. The extension does not read page contents and does not send stored values off the device. Browser-native header modification is performed by declarative network rules, not by a request proxy or per-request background script.

## Supported features

- Request and response headers with set, append, remove, and per-rule enablement
- Multiple profiles with independent enablement and priority order
- URL wildcard and regular-expression filters, plus resource-type filters
- Global pause and current-tab-only scope
- HeaderForge JSON backup/restore and ModHeader-style JSON import
- Dynamic timestamp, ISO date, UUID, and bounded random-integer value tokens
- Extension badge count and a visible error state when Chromium rejects rules

## Browser notes

The popup and options page require the extension to be loaded in a Chromium-based browser to access extension storage and the network-rule API. The Replit preview is a local-storage-backed UI preview; it cannot modify browser traffic. Some response headers and reserved request headers are restricted by Chromium, and regular expressions must be supported by Chromium's DNR/RE2 implementation.
