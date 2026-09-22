import {
  Router,
  type Request,
  type Response,
  type NextFunction,
  type RequestHandler,
} from "express";
import {
  registerUser,
  loginUser,
  type AuthDeps,
} from "./authService.js";
import { requireAuth, type AuthedRequest } from "./authMiddleware.js";

/**
 * HTTP routes for the auth foundation:
 *   POST /auth/register  -> 201 { user }        (409 on duplicate email)
 *   POST /auth/login     -> 200 { user, token } (401 on bad credentials)
 *   GET  /auth/me        -> 200 { user }         (401 without a valid token)
 *
 * Request bodies are validated with Zod inside the auth service; ZodErrors are
 * mapped to HTTP 400 by the app's error handler. AuthErrors carry their own
 * status/code. Business logic lives in the service — routes stay thin.
 */

/** Wrap an async handler so rejected promises reach the Express error handler. */
function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

export function createAuthRouter(deps: AuthDeps = {}): Router {
  const router = Router();

  router.post(
    "/register",
    asyncHandler(async (req, res) => {
      const user = await registerUser(req.body, deps);
      res.status(201).json({ user });
    }),
  );

  router.post(
    "/login",
    asyncHandler(async (req, res) => {
      const { user, token } = await loginUser(req.body, deps);
      res.status(200).json({ user, token });
    }),
  );

  router.get(
    "/me",
    requireAuth(deps),
    asyncHandler(async (req, res) => {
      const payload = (req as AuthedRequest).user!;
      res.status(200).json({ user: { id: payload.sub, email: payload.email } });
    }),
  );

  return router;
}
