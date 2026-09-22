import type { Request, Response, NextFunction } from "express";
import { AuthError } from "./errors.js";
import { verifyAuthToken, type AuthDeps } from "./authService.js";
import type { JwtPayload } from "./jwt.js";

/** Request augmented with the authenticated user's token payload. */
export interface AuthedRequest extends Request {
  user?: JwtPayload;
}

/**
 * Express guard: require a valid `Authorization: Bearer <token>` header. On
 * success it attaches the decoded payload to `req.user` and calls next(); on any
 * failure it forwards an AuthError (401) to the error handler.
 */
export function requireAuth(deps: Pick<AuthDeps, "verifyToken" | "now"> = {}) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      const header = (req.headers.authorization ?? "").trim();
      const match = /^Bearer\s+(.+)$/i.exec(header);
      if (!match) {
        throw new AuthError(
          "authorization header with a bearer token is required",
          "missing_token",
          401,
        );
      }
      (req as AuthedRequest).user = verifyAuthToken(match[1], deps);
      next();
    } catch (err) {
      next(err);
    }
  };
}
