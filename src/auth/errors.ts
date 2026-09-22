/**
 * Typed error for the authentication layer. `code` is a stable machine-readable
 * identifier (e.g. "invalid_credentials"); `status` is a suggested HTTP status
 * for when routes are wired up later. Messages are safe to surface to clients
 * and never contain secrets.
 */
export class AuthError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number = 400,
  ) {
    super(message);
    this.name = "AuthError";
  }
}
