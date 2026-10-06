/**
 * Centralised resource limits and low-level field validators.
 *
 * Every value here exists to keep HeaderForge inside two hard budgets:
 *   1. What Chromium's declarativeNetRequest engine will accept.
 *   2. What an extension page can hold in memory without becoming unresponsive.
 *
 * Anything read from disk (storage) or from an imported file passes through these
 * checks before it is trusted, so a hostile or corrupt backup cannot exhaust the
 * rule budget, freeze the popup, or smuggle CR/LF into a header value.
 */

/** RFC 9110 `token`: the only bytes legal in an HTTP field name. */
export const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * Bytes/characters Chromium will accept in a modified header value.
 * The spec caps a single `modifyHeaders` value at 1024 characters and the whole
 * rule at 8000, so we stay well under both.
 */
export const MAX_HEADER_NAME_LENGTH = 128;
export const MAX_HEADER_VALUE_LENGTH = 1024;

export const MAX_URL_PATTERN_LENGTH = 1024;
export const MAX_PROFILE_NAME_LENGTH = 64;
export const MAX_ID_LENGTH = 64;

/** Counts that keep a configuration renderable and compilable. */
export const MAX_PROFILES = 200;
export const MAX_HEADERS_PER_PROFILE = 500;
export const MAX_FILTERS_PER_PROFILE = 200;

/** Guard rails for untrusted text (import paste boxes, file reads). */
export const MAX_IMPORT_BYTES = 8 * 1024 * 1024;
export const MAX_IMPORT_CHARS = MAX_IMPORT_BYTES;

/** Guard rails for the URL tester, which runs a user regex over its input. */
export const MAX_TEST_URL_LENGTH = 2048;

/**
 * Headers Chromium refuses to let extensions modify. Rejecting these up front
 * turns a silent no-op (and a confusing "why isn't this working?" report) into
 * an inline validation message.
 */
export const FORBIDDEN_REQUEST_HEADERS = new Set([
  "accept-ch",
  "accept-encoding",
  "accept-language",
  "access-control-request-headers",
  "access-control-request-method",
  "connection",
  "content-length",
  "cookie",
  "cookie2",
  "date",
  "dnt",
  "expect",
  "host",
  "keep-alive",
  "origin",
  "permissions-policy",
  "referer",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
]);

export const FORBIDDEN_RESPONSE_HEADERS = new Set([
  "access-control-allow-credentials",
  "access-control-allow-headers",
  "access-control-allow-methods",
  "access-control-allow-origin",
  "access-control-expose-headers",
  "access-control-max-age",
  "age",
  "content-encoding",
  "content-length",
  "content-range",
  "date",
  "etag",
  "expires",
  "keep-alive",
  "last-modified",
  "location",
  "p3p",
  "proxy-authenticate",
  "proxy-authentication-info",
  "set-cookie",
  "server",
  "strict-transport-security",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "vary",
  "via",
  "www-authenticate",
]);

export function findControlCharacters(value: string): string | undefined {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001F\u007F]/.exec(value)?.[0];
}

export interface HeaderFieldProblem {
  message: string;
}

/**
 * Validates a single header field. Returns `undefined` when the pair is safe to
 * compile, otherwise a human-readable reason suitable for inline UI display.
 */
export function validateHeaderField(
  name: string,
  value: string,
  operation: "set" | "append" | "remove",
): HeaderFieldProblem | undefined {
  if (name.length > MAX_HEADER_NAME_LENGTH) {
    return { message: `Header name exceeds ${MAX_HEADER_NAME_LENGTH} characters.` };
  }
  if (!HEADER_NAME_PATTERN.test(name)) {
    return {
      message:
        'Header names may only contain letters, digits and "!#$%&\'*+-.^_`|~".',
    };
  }
  if (operation === "remove") return undefined;
  if (value.length > MAX_HEADER_VALUE_LENGTH) {
    return { message: `Header value exceeds ${MAX_HEADER_VALUE_LENGTH} characters.` };
  }
  const control = findControlCharacters(value);
  if (control !== undefined) {
    return {
      message: `Header value contains an illegal control character (0x${control.charCodeAt(0).toString(16).padStart(2, "0")}).`,
    };
  }
  return undefined;
}

export function isForbiddenHeader(name: string, type: "request" | "response"): boolean {
  const lower = name.toLowerCase();
  return type === "request"
    ? FORBIDDEN_REQUEST_HEADERS.has(lower)
    : FORBIDDEN_RESPONSE_HEADERS.has(lower);
}

/**
 * Bounds and sanity-checks a user-supplied URL pattern. Rejects RE2-incompatible
 * constructs early so the DNR call cannot fail as a whole, and rejects
 * catastrophic-looking expressions that could stall the UI-side matcher.
 */
export function validateUrlPattern(pattern: string, isRegex: boolean): HeaderFieldProblem | undefined {
  if (!pattern.trim()) return { message: "URL filters cannot be blank." };
  if (pattern.length > MAX_URL_PATTERN_LENGTH) {
    return { message: `URL pattern exceeds ${MAX_URL_PATTERN_LENGTH} characters.` };
  }
  if (findControlCharacters(pattern) !== undefined) {
    return { message: "URL pattern contains an illegal control character." };
  }
  if (!isRegex) return undefined;

  try {
    new RegExp(pattern);
  } catch {
    return { message: `Invalid regular expression: ${pattern}` };
  }
  // Nested unbounded quantifiers are the classic ReDoS shape. Chrome evaluates
  // DNR filters with RE2 (linear time), but the popup's live preview uses the
  // JavaScript engine, so we refuse the dangerous shapes up front.
  if (/\([^)]*[+*][^)]*\)\s*[+*]/.test(pattern) || /\([^)]*\{\d+,\}\s*\{/.test(pattern)) {
    return {
      message:
        "This pattern nests unbounded quantifiers and can freeze the preview. Simplify it.",
    };
  }
  return undefined;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Clamps an untrusted integer into `[min, max]`, falling back on junk. */
export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(numeric)));
}