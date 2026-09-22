import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import mongoose from "mongoose";
import { ZodError } from "zod";
import { createAuthRouter } from "./auth/authRoutes.js";
import type { AuthDeps } from "./auth/authService.js";
import { createKitRouter, type KitRouterDeps } from "./api/kitRoutes.js";
import { createJobRouter, type JobRouterDeps } from "./api/jobRoutes.js";

function getMongooseDbStatus(): "connected" | "connecting" | "disconnected" | "disconnecting" {
  switch (mongoose.connection?.readyState) {
    case 1:
      return "connected";
    case 2:
      return "connecting";
    case 3:
      return "disconnecting";
    case 0:
    default:
      return "disconnected";
  }
}

export interface CreateAppOptions {
  /**
   * Auth dependencies threaded into the auth service (user store, token
   * signer/verifier, clock). Injected by tests; production uses the defaults
   * (MongoDB-backed store + env JWT_SECRET).
   */
  authDeps?: AuthDeps;
  /**
   * Kit dependencies (persistence store + regeneration service). Injected by
   * tests; production uses the defaults. The kit routes' JWT guard reuses
   * authDeps, so `auth` is supplied here rather than via kitDeps.
   */
  kitDeps?: Omit<KitRouterDeps, "auth">;
  /**
   * Job dependencies (job fetch). Injected by tests; production uses the default
   * MongoDB-backed jobService. The job routes' JWT guard reuses authDeps.
   */
  jobDeps?: Omit<JobRouterDeps, "auth">;
  /**
   * Optional custom db readiness provider (defaults to mongoose.connection.readyState).
   */
  dbCheck?: () => { status: string };
}

/**
 * Build the Express application.
 * Wires the health check and the auth routes; feature routes are added later.
 */
export function createApp(options: CreateAppOptions = {}): Express {
  const app = express();

  // CORS middleware: allow preflight and cross-origin requests.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin || process.env.CORS_ORIGIN || "*";
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, Accept");
    res.setHeader("Access-Control-Allow-Credentials", "true");

    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.use(express.json());

  // Health check.
  app.get("/health", (_req: Request, res: Response) => {
    const dbStatus = options.dbCheck ? options.dbCheck().status : getMongooseDbStatus();
    res.status(200).json({
      status: "ok",
      ok: true,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      database: dbStatus,
      services: {
        database: dbStatus,
      },
    });
  });

  // Auth routes: /auth/register, /auth/login, /auth/me.
  app.use("/auth", createAuthRouter(options.authDeps));

  // Interview-kit routes (all require a valid JWT; owner-scoped by req.user.sub).
  app.use(
    "/kits",
    createKitRouter({ ...options.kitDeps, auth: options.authDeps }),
  );

  // Job status: GET /jobs/:id (requires a valid JWT; owner-scoped by req.user.sub).
  app.use(
    "/jobs",
    createJobRouter({ ...options.jobDeps, auth: options.authDeps }),
  );

  // 404 fallthrough.
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: { code: "not_found", message: "Not found" } });
  });

  // Centralized JSON error handler. Every error response has the shape
  // { error: { code, message, details? } }. Client (4xx) errors carry their own
  // safe code/message; unexpected (5xx) errors are logged server-side and
  // returned generically so stack traces / internal details never leak.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    // Zod validation failures -> 400 with safe field-level details.
    if (err instanceof ZodError) {
      res.status(400).json({
        error: {
          code: "validation_error",
          message: "Request validation failed",
          details: err.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        },
      });
      return;
    }

    const anyErr = err as { status?: number; code?: string; message?: string };
    const status = typeof anyErr?.status === "number" ? anyErr.status : 500;

    // Intentional client errors (4xx) we raised carry safe, specific messaging.
    if (status >= 400 && status < 500) {
      res.status(status).json({
        error: {
          code: anyErr.code ?? "error",
          message: anyErr.message ?? "Request failed",
        },
      });
      return;
    }

    // Unexpected server error: log the detail server-side, never in the response.
    // eslint-disable-next-line no-console
    console.error("Unhandled server error:", err);
    const isProd = (process.env.NODE_ENV ?? "").toLowerCase() === "production";
    res.status(500).json({
      error: {
        code: "internal_error",
        // In production keep it fully generic; outside production surface only
        // the message (never the stack) to aid local debugging.
        message: isProd
          ? "Internal server error"
          : anyErr?.message ?? "Internal server error",
      },
    });
  });

  return app;
}
