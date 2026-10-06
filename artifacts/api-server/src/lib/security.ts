import cors, { type CorsOptions } from "cors";
import type { RequestHandler } from "express";
import { logger } from "./logger";

const BASE_CORS_OPTIONS: CorsOptions = {
  methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  maxAge: 600,
  optionsSuccessStatus: 204,
};

const CONTENT_SECURITY_POLICY = "default-src 'none'; frame-ancestors 'none'";
const HSTS = "max-age=63072000; includeSubDomains; preload";
const PERMISSIONS_POLICY = [
  "camera=()",
  "microphone=()",
  "geolocation=()",
  "payment=()",
  "usb=()",
  "interest-cohort=()",
].join(", ");

/**
 * Number of proxy hops to trust. 0 (the default) trusts nothing, which is the only safe
 * setting when the real hop count is unknown.
 */
export function resolveTrustProxyHops(
  raw: string | undefined = process.env.TRUST_PROXY_HOPS,
): number {
  const hops = Number(raw);
  return Number.isInteger(hops) && hops > 0 ? hops : 0;
}

function parseOrigins(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

/**
 * Allowlist-based CORS. Origins are matched exactly against CORS_ORIGINS; an Origin that
 * is not in the list gets no CORS headers at all (same-origin only). The request Origin
 * is never reflected back unless it matched.
 */
export function createCorsMiddleware(): RequestHandler {
  const configured = parseOrigins(process.env.CORS_ORIGINS);
  const allowAnyOrigin = configured.includes("*");
  const allowlist = new Set(configured.filter((origin) => origin !== "*"));
  const allowCredentials = process.env.CORS_CREDENTIALS === "true";

  if (configured.length === 0) {
    logger.warn(
      "CORS_ORIGINS is unset: cross-origin requests will be rejected (same-origin only). Set CORS_ORIGINS to a comma-separated allowlist, e.g. CORS_ORIGINS=https://app.example.com",
    );
  } else if (allowAnyOrigin) {
    // '*' is an explicit opt-in to fully open CORS: any website the user visits can read
    // responses from this API. Acceptable for a public, credential-free API; a serious
    // exposure if private data is reachable, so it is never the default.
    logger.warn(
      'CORS_ORIGINS="*" allows every origin to read responses from this API',
    );
  }

  if (allowCredentials && allowAnyOrigin) {
    logger.warn(
      'CORS_ORIGINS="*" cannot be combined with CORS_CREDENTIALS=true (browsers reject "*" with credentials); credentials will not be advertised',
    );
  }

  return cors((req, callback) => {
    const origin = req.headers.origin;

    // No Origin header: same-origin navigation, curl, or a non-browser client. There is
    // nothing to allow, and no header value to reflect.
    if (!origin) {
      callback(null, { ...BASE_CORS_OPTIONS, origin: false, credentials: false });
      return;
    }

    const matched = allowAnyOrigin || allowlist.has(origin);

    callback(null, {
      ...BASE_CORS_OPTIONS,
      origin: matched ? (allowAnyOrigin ? "*" : origin) : false,
      credentials: matched && allowCredentials && !allowAnyOrigin,
    });
  });
}

/**
 * Hand-rolled security headers; `helmet` is not a dependency of this package and must
 * not be added. HSTS is only emitted when the request reached us over TLS, judged via
 * req.secure (which honours the `trust proxy` setting) rather than the raw socket.
 */
export const securityHeaders: RequestHandler = (req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Permissions-Policy", PERMISSIONS_POLICY);
  res.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);

  if (req.secure) {
    res.setHeader("Strict-Transport-Security", HSTS);
  }

  next();
};

export const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
};