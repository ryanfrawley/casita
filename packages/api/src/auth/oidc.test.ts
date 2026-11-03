// OidcProvider against a fake identity provider served on loopback.

import { afterEach, expect, test } from "bun:test";
import { CoreError } from "@casita/core";
import { type OidcConfig, OidcProvider } from "./oidc.ts";

type Row = Record<string, unknown>;

const CLIENT_ID = "casita-client";
const START = Date.UTC(2026, 0, 10);

const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (payload: unknown) => `${part({ alg: "none" })}.${part(payload)}.sig`;
const s256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("base64url");

const servers: { stop(force: boolean): void }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

/** Discovery at any path ending in /.well-known/openid-configuration, and a token endpoint. */
function fakeIdp() {
  const idp = {
    url: "",
    /** The issuer discovery names; defaults to the server's URL. */
    issuer: undefined as string | undefined,
    discoveryStatus: 200,
    discoveryPaths: [] as string[],
    /** Replaces the token endpoint's response. */
    tokenResponse: undefined as (() => Response) | undefined,
    tokenRequests: [] as URLSearchParams[],
    /** The nonce the next ID token carries; set from the authorize URL. */
    nonce: "",
    /** Merged over the default claims of the next ID token. */
    claims: {} as Row,
    clock: START,
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/.well-known/openid-configuration")) {
        idp.discoveryPaths.push(url.pathname);
        if (idp.discoveryStatus !== 200)
          return new Response("down", { status: idp.discoveryStatus });
        return Response.json({
          issuer: idp.issuer ?? idp.url,
          authorization_endpoint: `${idp.url}/authorize?prompt=login`,
          token_endpoint: `${idp.url}/token`,
        });
      }
      if (url.pathname === "/token") {
        idp.tokenRequests.push(new URLSearchParams(await req.text()));
        if (idp.tokenResponse) return idp.tokenResponse();
        return Response.json({
          id_token: jwt({
            iss: idp.url,
            sub: "user-1",
            aud: CLIENT_ID,
            exp: Math.floor(idp.clock / 1000) + 300,
            nonce: idp.nonce,
            email: "ada@example.com",
            ...idp.claims,
          }),
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  idp.url = `http://127.0.0.1:${server.port}`;
  return idp;
}

function setup(config: Partial<OidcConfig> = {}) {
  const idp = fakeIdp();
  const provider = new OidcProvider(
    {
      name: "home",
      issuer: idp.url,
      clientId: CLIENT_ID,
      clientSecret: "s3cret",
      redirectUrl: "http://casita.test/api/auth/oidc/home/callback",
      defaultRole: "guest",
      ...config,
    },
    () => idp.clock,
  );
  /** startLogin, then the callback the IdP would send the browser to. */
  const begin = async () => {
    const { redirectUrl, state } = await provider.startLogin();
    const authorize = new URL(redirectUrl);
    idp.nonce = authorize.searchParams.get("nonce") ?? "";
    return { authorize, state, callback: new URLSearchParams({ code: "the-code", state }) };
  };
  return { idp, provider, begin };
}

async function failure(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(error instanceof CoreError)) throw new Error(`expected a CoreError, got ${String(error)}`);
  return { code: error.code, message: error.message };
}

test("a login sends an S256 PKCE challenge and later the verifier that hashes to it", async () => {
  const { idp, provider, begin } = setup();
  const { authorize, state, callback } = await begin();
  expect(`${authorize.origin}${authorize.pathname}`).toBe(`${idp.url}/authorize`);
  const query = Object.fromEntries(authorize.searchParams);
  expect(query).toMatchObject({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: "http://casita.test/api/auth/oidc/home/callback",
    scope: "openid profile email",
    state,
    code_challenge_method: "S256",
  });
  const result = await provider.completeLogin(callback);
  expect(result).toMatchObject({
    provider: "home",
    subject: "user-1",
    claims: { email: "ada@example.com", aud: CLIENT_ID },
  });
  const [request] = idp.tokenRequests;
  expect(request && Object.fromEntries(request)).toMatchObject({
    grant_type: "authorization_code",
    code: "the-code",
    redirect_uri: "http://casita.test/api/auth/oidc/home/callback",
    client_id: CLIENT_ID,
    client_secret: "s3cret",
  });
  const verifier = request?.get("code_verifier") ?? "";
  expect(verifier.length).toBeGreaterThanOrEqual(43); // RFC 7636 minimum
  expect(s256(verifier)).toBe(query.code_challenge ?? "missing");
});

// RFC 6749 §3.1: an authorization endpoint's query component "MUST be retained when adding
// additional query parameters" (e.g. Azure AD B2C's `?p=<policy>`).
test("the authorization endpoint's own query parameters are kept", async () => {
  const { begin } = setup();
  const { authorize } = await begin();
  expect(authorize.searchParams.get("prompt")).toBe("login");
  expect(authorize.searchParams.get("response_type")).toBe("code");
});

test("each login gets its own state, nonce and verifier", async () => {
  const { begin } = setup();
  const a = (await begin()).authorize.searchParams;
  const b = (await begin()).authorize.searchParams;
  for (const name of ["state", "nonce", "code_challenge"])
    expect(a.get(name)).not.toBe(b.get(name));
});

test("discovery is fetched once and reused", async () => {
  const { idp, provider, begin } = setup();
  await provider.completeLogin((await begin()).callback);
  await provider.completeLogin((await begin()).callback);
  expect(idp.discoveryPaths).toEqual(["/.well-known/openid-configuration"]);
});

test("state is single use, even when the first attempt fails", async () => {
  const { idp, provider, begin } = setup();
  const { callback } = await begin();
  await provider.completeLogin(callback);
  expect((await failure(provider.completeLogin(callback))).message).toContain(
    "invalid or has expired",
  );

  // A callback with the state but no code still uses the state up.
  const second = await begin();
  const noCode = new URLSearchParams({ state: second.state });
  expect((await failure(provider.completeLogin(noCode))).code).toBe("auth");
  expect((await failure(provider.completeLogin(second.callback))).message).toContain(
    "invalid or has expired",
  );
  expect(idp.tokenRequests).toHaveLength(1);
});

test("an unknown or missing state is refused without calling the token endpoint", async () => {
  const { idp, provider } = setup();
  for (const params of [
    new URLSearchParams({ code: "c", state: "made-up" }),
    new URLSearchParams({ code: "c" }),
  ]) {
    expect(await failure(provider.completeLogin(params))).toEqual({
      code: "auth",
      message: "This login link is invalid or has expired; start again",
    });
  }
  expect(idp.tokenRequests).toEqual([]);
});

test("state expires ten minutes after the login started", async () => {
  const { idp, provider, begin } = setup();
  const late = await begin();
  const onTime = await begin();
  idp.clock = START + 10 * 60_000 - 1;
  await provider.completeLogin(onTime.callback);
  idp.clock = START + 10 * 60_000;
  expect((await failure(provider.completeLogin(late.callback))).message).toContain("expired");
});

test("an error from the identity provider is reported with its code", async () => {
  const { provider, begin } = setup();
  const { state } = await begin();
  expect(
    await failure(provider.completeLogin(new URLSearchParams({ error: "access_denied", state }))),
  ).toEqual({ code: "auth", message: "The identity provider refused the login: access_denied" });
});

test("discovery naming a different issuer is refused, and not cached", async () => {
  const { idp, provider, begin } = setup();
  idp.issuer = "https://evil.example";
  expect(await failure(provider.startLogin())).toEqual({
    code: "invalid",
    message: "OIDC discovery names a different issuer: https://evil.example",
  });
  idp.issuer = undefined;
  await provider.completeLogin((await begin()).callback);
  expect(idp.discoveryPaths).toHaveLength(2);
});

test("discovery that fails or is unreachable is reported as unavailable", async () => {
  const { idp, provider } = setup();
  idp.discoveryStatus = 500;
  expect(await failure(provider.startLogin())).toEqual({
    code: "unavailable",
    message: `Cannot read OIDC discovery from ${idp.url}/.well-known/openid-configuration`,
  });

  const gone = fakeIdp();
  const unreachable = new OidcProvider({
    name: "gone",
    issuer: gone.url,
    clientId: CLIENT_ID,
    clientSecret: "x",
    redirectUrl: "http://casita.test/cb",
    defaultRole: "guest",
  });
  for (const server of servers.splice(-1)) server.stop(true);
  expect((await failure(unreachable.startLogin())).code).toBe("unavailable");
});

test("a token endpoint that refuses, omits the ID token, or sends a non-JWT is refused", async () => {
  const { idp, provider, begin } = setup();
  const cases: [() => Response, string][] = [
    [() => Response.json({ error: "invalid_grant" }, { status: 400 }), "did not issue a token"],
    [() => Response.json({ access_token: "at" }), "did not issue a token"],
    [() => new Response("<html>oops</html>"), "did not issue a token"],
    [() => Response.json({ id_token: "not-a-jwt" }), "malformed ID token"],
    [() => Response.json({ id_token: "a.!!!.c" }), "malformed ID token"],
    [
      () => Response.json({ id_token: jwt({ iss: idp.url, aud: CLIENT_ID, exp: 9e9 }) }),
      "malformed ID token",
    ],
    [
      () => Response.json({ id_token: jwt({ iss: idp.url, sub: "", aud: CLIENT_ID, exp: 9e9 }) }),
      "malformed ID token",
    ],
  ];
  for (const [response, message] of cases) {
    idp.tokenResponse = response;
    const error = await failure(provider.completeLogin((await begin()).callback));
    expect(error.code).toBe("auth");
    expect(error.message).toContain(message);
  }
});

test("an audience list must include this client", async () => {
  const { idp, provider, begin } = setup();
  idp.claims = { aud: ["other-app", CLIENT_ID] };
  expect((await provider.completeLogin((await begin()).callback)).subject).toBe("user-1");
  idp.claims = { aud: ["other-app"] };
  expect((await failure(provider.completeLogin((await begin()).callback))).message).toBe(
    "The ID token is not valid for this login",
  );
});

test("an ID token expiring exactly now, or with no nonce, is refused", async () => {
  const { idp, provider, begin } = setup();
  for (const claims of [{ exp: START / 1000 }, { nonce: undefined }]) {
    idp.claims = claims;
    expect((await failure(provider.completeLogin((await begin()).callback))).message).toBe(
      "The ID token is not valid for this login",
    );
  }
});

test("a trailing slash on the configured issuer, discovery or iss does not matter", async () => {
  const { idp, provider, begin } = setup();
  const slashed = new OidcProvider(
    {
      name: "slashed",
      issuer: `${idp.url}/realms/home/`,
      clientId: CLIENT_ID,
      clientSecret: "s3cret",
      redirectUrl: "http://casita.test/cb",
      defaultRole: "guest",
    },
    () => idp.clock,
  );
  idp.issuer = `${idp.url}/realms/home`;
  idp.claims = { iss: `${idp.url}/realms/home` };
  const { redirectUrl, state } = await slashed.startLogin();
  idp.nonce = new URL(redirectUrl).searchParams.get("nonce") ?? "";
  expect((await slashed.completeLogin(new URLSearchParams({ code: "c", state }))).subject).toBe(
    "user-1",
  );
  expect(idp.discoveryPaths).toEqual(["/realms/home/.well-known/openid-configuration"]);

  // The other way round: no slash configured, slashes from the IdP.
  idp.issuer = `${idp.url}/`;
  idp.claims = { iss: `${idp.url}/` };
  expect((await provider.completeLogin((await begin()).callback)).subject).toBe("user-1");
});
