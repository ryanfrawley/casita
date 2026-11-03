# @casita/api

The WebSocket and HTTP surface, and everything about who may do what.

## Owns

- `src/schema.ts`: the wire protocol as Zod schemas, shared with the CLI and the web app. It is
  bundled for the browser, so it imports only `@casita/core/types` and `@casita/core/retention`.
- `src/server.ts`: `Bun.serve` app, one connection object per socket, the read filter,
  event streaming with snapshots, and the HTTP routes.
- `src/auth/`: users, sessions and API tokens, grants, the audit log, the pure
  `resolveLevel` function, and OIDC login.
- `src/web.ts`: what a browser needs that the CLI does not: the session cookie, the same-origin
  check, and the web app's files.
- `requirePermission`: the router policy the server registers first.

## Rules

- Permissions are enforced in exactly two places: the read filter here and `requirePermission`.
- An entity a user cannot read is indistinguishable from one that does not exist.
- A browser's session is an `HttpOnly; SameSite=Strict` cookie, never a token a script can read.
  The cookie counts only on a request from a page this server served (`sameOrigin`); a `GET`
  may use it alone, so download links work.
- A new request type needs a schema entry, a handler, and (if admin-only) a line in `ADMIN_ONLY`.

## Must not import

- `@casita/server`, `@casita/cli`, or anything under `integrations/`.
