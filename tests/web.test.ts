// What the server does for a browser: a session cookie in place of a token, and the web app's files.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addUser, BOOTSTRAP_TOKEN, boot, DEFAULT_CONFIG, type Harness } from "./harness.ts";

let h: Harness;
let webDir: string;
/** A bearer token for the same user, as the CLI would hold. */
let token: string;
// One server for the file: nothing here changes what the next test sees.
beforeAll(async () => {
  webDir = await mkdtemp(join(tmpdir(), "casita-web-"));
  await writeFile(join(webDir, "index.html"), "<!doctype html><title>Casita</title>");
  await writeFile(join(webDir, "app-abc123.js"), "console.log('casita')");
  await writeFile(join(webDir, "manifest.webmanifest"), "{}");
  await mkdir(join(webDir, "nested"));
  await writeFile(join(webDir, "nested", "font-abc123.woff2"), "font");
  // Every test signs in from the same address; the limit is tested elsewhere.
  h = await boot(DEFAULT_CONFIG, undefined, { webDir, loginRateLimit: 1000 });
  // The first user has to be an admin; once there is one, the bootstrap token stops working.
  ({ token } = await addUser(h, await h.connect(BOOTSTRAP_TOKEN), "ada", "admin"));
});
afterAll(async () => {
  await h.stop();
  await rm(webDir, { recursive: true, force: true });
});

const origin = () => h.url;

async function signIn(): Promise<{ response: Response; cookie: string }> {
  const response = await fetch(`${h.url}/api/auth/login`, {
    method: "POST",
    body: JSON.stringify({ username: "ada", password: "ada-password", cookie: true }),
  });
  const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  return { response, cookie };
}

/** Opens a socket as a browser would and reports how the handshake ended. */
function handshake(headers: Record<string, string>, auth: object = { type: "auth" }) {
  return new Promise<{ ok: boolean; code?: number }>((resolve) => {
    const ws = new WebSocket(`${h.url.replace("http", "ws")}/ws`, { headers });
    ws.addEventListener("open", () => ws.send(JSON.stringify(auth)));
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      resolve({ ok: message.type === "auth_ok" });
      ws.close();
    });
    ws.addEventListener("close", (event) => resolve({ ok: false, code: event.code }));
  });
}

// ───────── the session cookie ─────────

test("a login that asks for a cookie gets one, HttpOnly and SameSite=Strict, and no token", async () => {
  const { response } = await signIn();
  expect(response.status).toBe(200);
  const body = (await response.json()) as Record<string, unknown>;
  expect(body.token).toBeUndefined();
  expect(body.user).toMatchObject({ username: "ada", role: "admin" });
  const cookie = response.headers.get("set-cookie") ?? "";
  expect(cookie).toMatch(
    /^casita_session=casita_[\w-]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+$/,
  );
  // Plain http on the LAN: a Secure cookie would never come back.
  expect(cookie).not.toContain("Secure");
});

test("behind TLS the cookie is Secure", async () => {
  const response = await fetch(`${h.url}/api/auth/login`, {
    method: "POST",
    headers: { "X-Forwarded-Proto": "https" },
    body: JSON.stringify({ username: "ada", password: "ada-password", cookie: true }),
  });
  expect(response.headers.get("set-cookie")).toEndWith("; Secure");
});

test("a login that does not ask still gets its token and no cookie", async () => {
  const response = await h.login("ada", "ada-password");
  expect(((await response.json()) as { token: string }).token).toStartWith("casita_");
  expect(response.headers.get("set-cookie")).toBeNull();
});

test("a wrong password sets no cookie", async () => {
  const response = await fetch(`${h.url}/api/auth/login`, {
    method: "POST",
    body: JSON.stringify({ username: "ada", password: "nope", cookie: true }),
  });
  expect(response.status).toBe(401);
  expect(response.headers.get("set-cookie")).toBeNull();
});

test("a socket from our own page authenticates by cookie, with no token in the auth message", async () => {
  const { cookie } = await signIn();
  expect(await handshake({ Cookie: cookie, Origin: origin() })).toEqual({ ok: true });
});

test("the cookie is ignored on a socket from another site, or from no page at all", async () => {
  const { cookie } = await signIn();
  expect(await handshake({ Cookie: cookie, Origin: "http://evil.example" })).toEqual({
    ok: false,
    code: 4401,
  });
  expect(await handshake({ Cookie: cookie })).toEqual({ ok: false, code: 4401 });
});

test("a socket from another site may still authenticate with a token of its own", async () => {
  const headers = { Origin: "http://tools.example" };
  expect(await handshake(headers, { type: "auth", token })).toEqual({ ok: true });
});

test("a token in the auth message wins over the cookie", async () => {
  const { cookie } = await signIn();
  const headers = { Cookie: cookie, Origin: origin() };
  expect(await handshake(headers, { type: "auth", token: "casita_wrong" })).toEqual({
    ok: false,
    code: 4401,
  });
});

test("no cookie and no token is refused", async () => {
  expect(await handshake({ Origin: origin() })).toEqual({ ok: false, code: 4401 });
});

test("logout by cookie needs our origin, ends the session, and clears the cookie", async () => {
  const { cookie } = await signIn();
  const elsewhere = await fetch(`${h.url}/api/auth/logout`, {
    method: "POST",
    headers: { Cookie: cookie, Origin: "http://evil.example" },
  });
  expect(elsewhere.status).toBe(401);
  expect(await handshake({ Cookie: cookie, Origin: origin() })).toEqual({ ok: true });

  const ours = await fetch(`${h.url}/api/auth/logout`, {
    method: "POST",
    headers: { Cookie: cookie, Origin: origin() },
  });
  expect(ours.status).toBe(200);
  expect(ours.headers.get("set-cookie")).toMatch(/^casita_session=; .*Max-Age=0/);
  expect(await handshake({ Cookie: cookie, Origin: origin() })).toEqual({ ok: false, code: 4401 });
});

test("logout by bearer token sets no cookie", async () => {
  const own = ((await (await h.login("ada", "ada-password")).json()) as { token: string }).token;
  const response = await fetch(`${h.url}/api/auth/logout`, {
    method: "POST",
    headers: { Authorization: `Bearer ${own}` },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("set-cookie")).toBeNull();
});

test("a download link works with the cookie alone", async () => {
  const { cookie } = await signIn();
  const response = await fetch(`${h.url}/api/schema`, { headers: { Cookie: cookie } });
  expect(response.status).toBe(200);
  expect((await fetch(`${h.url}/api/schema`)).status).toBe(401);
});

test("the login page can ask which identity providers there are", async () => {
  const response = await fetch(`${h.url}/api/auth/providers`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ oidc: [] });
});

// ───────── the web app's files ─────────

test("the root serves index.html, never cached, under a content security policy", async () => {
  const response = await fetch(`${h.url}/`);
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain("<title>Casita</title>");
  expect(response.headers.get("content-type")).toStartWith("text/html");
  expect(response.headers.get("cache-control")).toBe("no-cache");
  const policy = response.headers.get("content-security-policy") ?? "";
  expect(policy).toContain("default-src 'self'");
  expect(policy).toContain("frame-ancestors 'none'");
  expect(policy).not.toContain("unsafe-inline");
  // A style the page makes itself carries the response's nonce, which the page reads from a meta tag.
  const nonce = /style-src 'self' 'nonce-([A-Za-z0-9+/=]+)'/.exec(policy)?.[1];
  expect(nonce).toBeDefined();
  expect(html).toContain(`<meta name="csp-nonce" content="${nonce}" />`);
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
});

test("hashed assets are cached for good", async () => {
  for (const path of ["/app-abc123.js", "/nested/font-abc123.woff2"]) {
    const response = await fetch(`${h.url}${path}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  }
  expect((await fetch(`${h.url}/app-abc123.js`)).headers.get("content-type")).toContain(
    "javascript",
  );
});

test("a file with no hash in its name is checked every time", async () => {
  const response = await fetch(`${h.url}/manifest.webmanifest`);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-cache");
  expect((await fetch(`${h.url}/index.html`)).headers.get("cache-control")).toBe("no-cache");
});

test("the app's own routes get index.html; a missing asset is a 404", async () => {
  const route = await fetch(`${h.url}/entities/light.kitchen_ceiling`);
  expect(route.status).toBe(200);
  expect(await route.text()).toContain("<title>Casita</title>");
  expect((await fetch(`${h.url}/missing-abc123.js`)).status).toBe(404);
});

test("nothing outside the web directory is served", async () => {
  await writeFile(join(webDir, "..", "casita-secret.txt"), "secret");
  try {
    for (const path of [
      "/../casita-secret.txt",
      "/%2e%2e/casita-secret.txt",
      "/nested/../../casita-secret.txt",
    ]) {
      // fetch() would tidy the path before sending it; this sends it as written.
      const socket = await Bun.connect({
        hostname: "127.0.0.1",
        port: Number(new URL(h.url).port),
        socket: { data() {} },
      });
      const reply = new Promise<string>((resolve) => {
        socket.reload({ socket: { data: (_, chunk) => resolve(String(chunk)) } });
      });
      socket.write(`GET ${path} HTTP/1.1\r\nHost: casita\r\nConnection: close\r\n\r\n`);
      expect(await reply).not.toContain("secret");
      socket.end();
    }
  } finally {
    await rm(join(webDir, "..", "casita-secret.txt"), { force: true });
  }
});

test("the API keeps its own answers: unknown routes, health, and the need to sign in", async () => {
  expect((await fetch(`${h.url}/health`)).headers.get("content-type")).toStartWith(
    "application/json",
  );
  expect((await fetch(`${h.url}/api/nope`)).status).toBe(401);
  const unknown = await fetch(`${h.url}/api/nope`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(unknown.status).toBe(404);
  expect((await fetch(`${h.url}/`, { method: "POST" })).status).toBe(401);
});

test("with no web directory the root is not served", async () => {
  const bare = await boot();
  try {
    expect((await fetch(`${bare.url}/`)).status).toBe(401);
  } finally {
    await bare.stop();
  }
});
