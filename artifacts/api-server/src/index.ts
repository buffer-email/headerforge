import type { Server } from "node:http";
import app from "./app";
import { logger } from "./lib/logger";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server: Server = app.listen(port);

// listen() reports bind failures asynchronously, not through the callback argument.
server.on("error", (err) => {
  logger.error({ err }, "Error listening on port");
  process.exit(1);
});

server.on("listening", () => {
  logger.info({ port }, "Server listening");
});

// Slow-loris bounds: without these, a client can trickle bytes over an open socket and
// pin an autoscale instance (and its memory) for as long as it likes.
server.headersTimeout = 20_000;
server.requestTimeout = 30_000;
// Idle keep-alive sockets otherwise accumulate on the instance after every deploy.
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 100;
// Generous enough not to cut off legitimate long-lived requests; requestTimeout above is
// the real request-phase bound.
server.timeout = 60_000;

const SHUTDOWN_GRACE_MS = 10_000;
let shuttingDown = false;

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  logger.info({ signal }, "Shutting down");

  const forceTimer = setTimeout(() => {
    logger.warn("Graceful shutdown timed out; closing open connections");
    server.closeAllConnections?.();
  }, SHUTDOWN_GRACE_MS);
  forceTimer.unref();

  server.close((err) => {
    clearTimeout(forceTimer);

    if (err) {
      logger.error({ err }, "Error closing HTTP server");
    } else {
      logger.info("HTTP server closed");
    }

    process.exit(0);
  });

  // Reclaim keep-alive connections immediately so draining does not wait out
  // keepAliveTimeout for each one.
  server.closeIdleConnections?.();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));