import express, { type Express, type Request } from "express";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { createRateLimiter } from "./lib/rate-limit";
import {
  createCorsMiddleware,
  noStore,
  resolveTrustProxyHops,
  securityHeaders,
} from "./lib/security";

const HEALTH_PATH = "/api/healthz";

const app: Express = express();

const trustProxyHops = resolveTrustProxyHops();

// Off unless TRUST_PROXY_HOPS is set. This deployment runs behind an autoscale proxy,
// but the hop count is not knowable from here, and a wrong guess means believing
// attacker-supplied X-Forwarded-For values - which forges req.secure (silently enabling
// HSTS on plain http) and defeats IP-keyed rate limiting. Set it to the exact number of
// proxies in front of the app (1 for Replit's edge).
app.set("trust proxy", trustProxyHops > 0 ? trustProxyHops : false);
app.set("x-powered-by", false);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          // Query strings can carry tokens/identifiers, so only the path is logged.
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(securityHeaders);
app.use(createCorsMiddleware());
app.use(
  createRateLimiter({
    trustProxy: trustProxyHops > 0,
    // The platform health probe must never be throttled: a 429 here gets the instance
    // flagged unhealthy and killed instead of replaced.
    skip: (req: Request) => req.path === HEALTH_PATH,
  }),
);
app.use(express.json({ limit: "32kb" }));
app.use(express.urlencoded({ extended: false, limit: "32kb" }));

app.use("/api", noStore, router);

export default app;