// OIDC login against a fake identity provider served on loopback.

import { afterEach, beforeEach, expect, test } from "bun:test";
import type { CasitaClient } from "../packages/client/src/client.ts";
import { addUser, BOOTSTRAP_TOKEN, boot, DEFAULT_CONFIG, type Harness } from "./harness.ts";

type Row = Record<string, unknown>;

/** Just enough of an IdP: discovery, an authorize page that "logs in" at once, and a token endpoint. */
function fakeIdp() {
  const codes = new Map<string, { challenge: string; nonce: string; redirect: string }>();
  const idp = {
    url: "",
    /** Claims the next token will carry; reset per test. */
    claims: { sub: "idp-user-1", preferred_username: "Ada.L", name: "Ada Lovelace" } as Row,
    tamper: {} as Row,
    tokenRequests: [] as Row[],
    stop: () => server.stop(true),
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/.well-known/openid-configuration") {
        return Response.json({
          issuer: idp.url,
          authorization_endpoint: `${idp.url}/authorize`,
          token_endpoint: `${idp.url}/token`,
        });
      }
      if (url.pathname === "/authorize") {
        const q = url.searchParams;
        const code = crypto.randomUUID();
        codes.set(code, {
          challenge: q.get("code_challenge") ?? "",
          nonce: q.get("nonce") ?? "",
          redirect: q.get("redirect_uri") ?? "",
        });
        return Response.redirect(
          `${q.get("redirect_uri")}?code=${code}&state=${q.get("state")}`,
          302,
        );
      }
      if (url.pathname === "/token") {
        const form = new URLSearchParams(await req.text());
        idp.tokenRequests.push(Object.fromEntries(form));
        const grant = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        const challenge = new Bun.CryptoHasher("sha256")
          .update(form.get("code_verifier") ?? "")
          .digest("base64url");
        if (!grant || grant.challenge !== challenge || form.get("client_secret") !== "s3cret") {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        const payload = {
          iss: idp.url,
          aud: "casita-client",
          exp: Math.floor(Date.now() / 1000) + 300,
          nonce: grant.nonce,
          ...idp.claims,
          ...idp.tamper,
        };
        const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
        return Response.json({
          access_token: "at",
          id_token: `${part({ alg: "none" })}.${part(payload)}.sig`,
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  idp.url = `http://127.0.0.1:${server.port}`;
  return idp;
}

let idp: ReturnType<typeof fakeIdp>;
let h: Harness;
let admin: CasitaClient;

beforeEach(async () => {
  idp = fakeIdp();
  // The IdP only echoes redirectUrl back; login() below sends the callback to the test server.
  h = await boot(
    `${DEFAULT_CONFIG}
[[auth.oidc]]
name = "home"
issuer = "${idp.url}"
clientId = "casita-client"
clientSecret = "s3cret"
redirectUrl = "http://casita.test/api/auth/oidc/home/callback"
`,
    undefined,
    { loginRateLimit: 50 },
  );
  admin = await h.connect(
    (await addUser(h, await h.connect(BOOTSTRAP_TOKEN), "root", "admin")).token,
  );
});
afterEach(async () => {
  await h.stop();
  idp.stop();
});

/** Follows start → IdP → callback the way a browser would. */
async function login(): Promise<Response> {
  const start = await fetch(`${h.url}/api/auth/oidc/home/start`, { redirect: "manual" });
  expect(start.status).toBe(302);
  const authorize = await fetch(start.headers.get("location") ?? "", { redirect: "manual" });
  const callback = new URL(authorize.headers.get("location") ?? "");
  // Whatever port the config names, the request goes to the running server.
  return fetch(`${h.url}${callback.pathname}${callback.search}`);
}

test("the callback links a new identity to a new user with the default role", async () => {
  const response = await login();
  expect(response.status).toBe(200);
  const { token, user } = (await response.json()) as { token: string; user: Row };
  expect(user).toMatchObject({ username: "ada.l", displayName: "Ada Lovelace", role: "guest" });
  expect(idp.tokenRequests[0]).toMatchObject({
    grant_type: "authorization_code",
    client_id: "casita-client",
  });

  const guest = await h.connect(token);
  expect(await guest.request("get_me", {})).toMatchObject({
    user: { username: "ada.l", role: "guest" },
  });
  expect(await guest.request("get_states", {})).toEqual([]);

  // The same subject logs in as the same user, even after an admin promotes or renames things.
  await admin.request("update_user", { userId: String(user.id), role: "member" });
  idp.claims = { ...idp.claims, preferred_username: "someone-else" };
  const again = (await (await login()).json()) as { user: Row };
  expect(again.user).toMatchObject({ id: user.id, username: "ada.l", role: "member" });
  expect(((await admin.request("list_users", {})) as Row[]).map((u) => u.username)).toEqual([
    "ada.l",
    "root",
  ]);
  const audit = (await admin.request("get_audit", {})) as Row[];
  expect(
    audit.filter((a) => a.action === "login" && (a.detail as Row | undefined)?.provider === "home"),
  ).toHaveLength(2);
});

test("a username clash gets a suffix; an OIDC-only user cannot log in with a password", async () => {
  await addUser(h, admin, "ada.l", "member");
  const { user } = (await (await login()).json()) as { user: Row };
  expect(user.username).toBe("ada.l_2");
  expect((await h.login("ada.l_2", "anything-at-all")).status).toBe(401);
});

test("a disabled user is refused", async () => {
  const { user } = (await (await login()).json()) as { user: Row };
  await admin.request("update_user", { userId: String(user.id), disabled: true });
  const refused = await login();
  expect(refused.status).toBe(401);
  expect(await refused.json()).toEqual({
    error: { code: "auth", message: "This account is disabled" },
  });
});

test("bad state, replayed callbacks, and tokens for someone else are rejected", async () => {
  const unknown = await fetch(`${h.url}/api/auth/oidc/home/callback?code=x&state=nope`);
  expect(unknown.status).toBe(401);
  expect(((await unknown.json()) as { error: Row }).error.message).toContain(
    "invalid or has expired",
  );

  const start = await fetch(`${h.url}/api/auth/oidc/home/start`, { redirect: "manual" });
  const authorize = await fetch(start.headers.get("location") ?? "", { redirect: "manual" });
  const callback = new URL(authorize.headers.get("location") ?? "");
  expect((await fetch(`${h.url}${callback.pathname}${callback.search}`)).status).toBe(200);
  expect((await fetch(`${h.url}${callback.pathname}${callback.search}`)).status).toBe(401); // state is single use

  for (const tamper of [
    { aud: "another-client" },
    { iss: "https://evil.example" },
    { exp: 1 },
    { nonce: "wrong" },
  ]) {
    idp.tamper = tamper;
    const response = await login();
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: Row }).error.message).toBe(
      "The ID token is not valid for this login",
    );
  }
  idp.tamper = {};
  const denied = await fetch(`${h.url}/api/auth/oidc/home/callback?error=access_denied&state=x`);
  expect(((await denied.json()) as { error: Row }).error.message).toContain("access_denied");
  expect((await fetch(`${h.url}/api/auth/oidc/nope/start`)).status).toBe(404);
});

// ───────── from the web app ─────────

/** The same journey, begun from the web app's login page. */
async function browserLogin(): Promise<Response> {
  const start = await fetch(`${h.url}/api/auth/oidc/home/start?web=1`, { redirect: "manual" });
  const authorize = await fetch(start.headers.get("location") ?? "", { redirect: "manual" });
  const callback = new URL(authorize.headers.get("location") ?? "");
  return fetch(`${h.url}${callback.pathname}${callback.search}`, { redirect: "manual" });
}

test("a login begun from the web app ends in a session cookie and a redirect home", async () => {
  const response = await browserLogin();
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("/");
  const cookie = response.headers.get("set-cookie") ?? "";
  expect(cookie).toMatch(/^casita_session=casita_[\w-]+; Path=\/; HttpOnly; SameSite=Strict/);
  // No token in a page the browser would show or keep in its history.
  expect(await response.text()).toBe("");

  const token = cookie.split(";")[0]?.split("=")[1] ?? "";
  const guest = await h.connect(token);
  expect(await guest.request("get_me", {})).toMatchObject({ user: { username: "ada.l" } });
});

test("a failed login from the web app goes back to it, with no cookie and no detail", async () => {
  idp.tamper = { nonce: "wrong" };
  const response = await browserLogin();
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("/?login=failed");
  expect(response.headers.get("set-cookie")).toBeNull();
  idp.tamper = {};
});

test("a callback is a browser's only if its start was: the state cannot be claimed twice", async () => {
  const start = await fetch(`${h.url}/api/auth/oidc/home/start?web=1`, { redirect: "manual" });
  const authorize = await fetch(start.headers.get("location") ?? "", { redirect: "manual" });
  const callback = new URL(authorize.headers.get("location") ?? "");
  const first = await fetch(`${h.url}${callback.pathname}${callback.search}`, {
    redirect: "manual",
  });
  expect(first.status).toBe(302);
  // Replayed, the state is unknown both to the provider and as a browser login.
  const replay = await fetch(`${h.url}${callback.pathname}${callback.search}`, {
    redirect: "manual",
  });
  expect(replay.status).toBe(401);
  expect(replay.headers.get("set-cookie")).toBeNull();
});

test("the login page is told which providers there are", async () => {
  expect(await (await fetch(`${h.url}/api/auth/providers`)).json()).toEqual({
    oidc: [{ name: "home" }],
  });
});
