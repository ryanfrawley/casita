// What a browser needs that the CLI does not: a session cookie, and the web app's files.

import { join, normalize, sep } from "node:path";
import { SESSION_TTL_MS } from "./auth/auth.ts";

export const SESSION_COOKIE = "casita_session";

const isHttps = (req: Request): boolean =>
  new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";

/**
 * The Set-Cookie value that hands a browser its session. HttpOnly keeps the token from any
 * script on the page; SameSite=Strict keeps other sites from using it.
 */
export function sessionCookie(req: Request, token: string | null): string {
  const parts = [
    `${SESSION_COOKIE}=${token ?? ""}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${token ? Math.floor(SESSION_TTL_MS / 1000) : 0}`,
  ];
  if (isHttps(req)) parts.push("Secure");
  return parts.join("; ");
}

/** The session token a request's cookies carry, if any. */
export function cookieToken(req: Request): string | undefined {
  for (const pair of (req.headers.get("cookie") ?? "").split(";")) {
    const at = pair.indexOf("=");
    if (at > 0 && pair.slice(0, at).trim() === SESSION_COOKIE) {
      return pair.slice(at + 1).trim() || undefined;
    }
  }
  return undefined;
}

/**
 * Whether a request came from a page this server served. A cookie is sent by the browser on
 * its own, so a request that relies on one must also prove where it came from; a request with
 * no Origin at all is not from a page (the CLI, curl) and carries no cookie worth guarding.
 */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host === (req.headers.get("host") ?? new URL(req.url).host);
  } catch {
    return false;
  }
}

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
};

/**
 * Scripts, styles, fonts and sockets from this server only; images from it and from
 * OpenStreetMap's tile server, for a Casa `Map`; never framed. A style the page makes itself
 * (a theme's rule, the editor's) carries the response's nonce, which the page reads from a
 * meta tag; nothing else inline is allowed.
 */
const contentSecurityPolicy = (nonce: string) =>
  [
    "default-src 'self'",
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data: https://tile.openstreetmap.org",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");

/** Where the page finds the nonce its own styles must carry. */
export const CSP_NONCE_META = "csp-nonce";

/** The meta tag with the nonce, first in the head (or first after the doctype, without one). */
export function withNonce(html: string, nonce: string): string {
  const meta = `<meta name="${CSP_NONCE_META}" content="${nonce}" />`;
  const head = html.search(/<head[^>]*>/i);
  if (head !== -1) {
    const end = html.indexOf(">", head) + 1;
    return `${html.slice(0, end)}${meta}${html.slice(end)}`;
  }
  const doctype = /<!doctype[^>]*>/i.exec(html);
  const at = doctype ? (doctype.index ?? 0) + doctype[0].length : 0;
  return `${html.slice(0, at)}${meta}${html.slice(at)}`;
}

const newNonce = (): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");

/** "index-ezeaktze.js": a name the bundler ended with a hash of the file's content. */
const HASHED = /-[a-z0-9]{6,}\.[a-z0-9]+$/;

/**
 * Serves the built web app from `dir`: a file if the path names one, else `index.html` so the
 * app's own routes survive a reload. Undefined when `dir` holds no app.
 */
export async function serveWeb(dir: string, pathname: string): Promise<Response | undefined> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  const path = normalize(join(dir, decoded));
  // normalize() has resolved any "..": anything now outside the directory is refused.
  const inside = path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep);
  const asset = inside && path !== dir ? Bun.file(path) : undefined;
  if (asset && (await asset.exists())) {
    return new Response(asset, {
      headers: {
        ...SECURITY_HEADERS,
        // A file with its content's hash in its name never changes; the few without one
        // (index.html, the manifest and its icon) are checked every time.
        "Cache-Control": HASHED.test(path) ? "public, max-age=31536000, immutable" : "no-cache",
      },
    });
  }
  // A missing file with an extension is a missing asset, not a route.
  if (/\.[a-z0-9]+$/i.test(decoded)) return undefined;
  const index = Bun.file(join(dir, "index.html"));
  if (!(await index.exists())) return undefined;
  const nonce = newNonce();
  const html = withNonce(await index.text(), nonce);
  return new Response(html, {
    headers: {
      ...SECURITY_HEADERS,
      "Content-Type": "text/html;charset=utf-8",
      "Cache-Control": "no-cache",
      "Content-Security-Policy": contentSecurityPolicy(nonce),
    },
  });
}
