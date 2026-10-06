import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

const configuredLevel = process.env.LOG_LEVEL ?? "info";

// Debug logs are high-volume and high-cardinality; on an autoscale deployment they are
// a log-spend and PII risk, so production is never allowed to drop to debug.
const level =
  isProduction && (configuredLevel === "debug" || configuredLevel === "trace")
    ? "info"
    : configuredLevel;

export const logger = pino({
  level,
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers['set-cookie']",
      "req.headers['x-api-key']",
      "req.headers['x-auth-token']",
      "req.headers['proxy-authorization']",
      // Client-identifying, and trivially forged: an X-Forwarded-For log line is both a
      // privacy leak and a source of spoofable data for downstream log analytics.
      "req.headers['x-forwarded-for']",
      "res.headers['set-cookie']",
    ],
    // Rely on an explicit mask rather than pino's default so a future path typo cannot
    // fall through to printing the raw secret value.
    censor: "[redacted]",
  },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});