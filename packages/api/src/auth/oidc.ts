// OpenID Connect login: Authorization Code flow with PKCE, endpoints discovered from the issuer.

import type { AuthConfig } from "@casita/core";
import { CoreError } from "@casita/core";
import { z } from "zod";
import type { IdentityProvider } from "./auth.ts";

export type OidcConfig = AuthConfig["oidc"][number];

const discoverySchema = z.looseObject({
  issuer: z.string(),
  authorization_endpoint: z.url(),
  token_endpoint: z.url(),
});

const tokenSchema = z.looseObject({ id_token: z.string() });

const claimsSchema = z.looseObject({
  iss: z.string(),
  sub: z.string().min(1),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number(),
  nonce: z.string().optional(),
});

/** How long a login may sit at the identity provider before its state is forgotten. */
const PENDING_TTL_MS = 10 * 60_000;
/** An identity provider that hangs must not hang the login request with it. */
const FETCH_TIMEOUT_MS = 10_000;

const random = (bytes: number) =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");
const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("base64url");
const trimSlash = (url: string) => url.replace(/\/+$/, "");

export class OidcProvider implements IdentityProvider {
  readonly name: string;
  private discovery?: z.infer<typeof discoverySchema>;
  private readonly pending = new Map<
    string,
    { verifier: string; nonce: string; expiresAt: number }
  >();

  constructor(
    private readonly config: OidcConfig,
    private readonly now: () => number = Date.now,
  ) {
    this.name = config.name;
  }

  private async discover() {
    if (this.discovery) return this.discovery;
    const url = `${trimSlash(this.config.issuer)}/.well-known/openid-configuration`;
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }).catch(
      () => undefined,
    );
    const parsed = discoverySchema.safeParse(
      response?.ok ? await response.json().catch(() => undefined) : undefined,
    );
    if (!parsed.success)
      throw new CoreError("unavailable", `Cannot read OIDC discovery from ${url}`);
    if (trimSlash(parsed.data.issuer) !== trimSlash(this.config.issuer)) {
      throw new CoreError(
        "invalid",
        `OIDC discovery names a different issuer: ${parsed.data.issuer}`,
      );
    }
    this.discovery = parsed.data;
    return parsed.data;
  }

  /** Where to send the browser, and the state that will come back with it. */
  async startLogin(): Promise<{ redirectUrl: string; state: string }> {
    const { authorization_endpoint } = await this.discover();
    const at = this.now();
    for (const [key, entry] of this.pending) if (entry.expiresAt <= at) this.pending.delete(key);

    const state = random(24);
    const verifier = random(48);
    const nonce = random(16);
    this.pending.set(state, { verifier, nonce, expiresAt: at + PENDING_TTL_MS });
    const url = new URL(authorization_endpoint);
    // Added to whatever query the endpoint already carries, which must be kept (RFC 6749 3.1).
    const query = {
      response_type: "code",
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUrl,
      scope: "openid profile email",
      state,
      nonce,
      code_challenge: sha256(verifier),
      code_challenge_method: "S256",
    };
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return { redirectUrl: url.toString(), state };
  }

  /** Exchanges the callback's code for an ID token and returns who it identifies. */
  async completeLogin(
    params: URLSearchParams,
  ): Promise<{ provider: string; subject: string; claims: Record<string, unknown> }> {
    const state = params.get("state") ?? "";
    const code = params.get("code");
    const login = this.pending.get(state);
    this.pending.delete(state); // single use
    const denied = params.get("error");
    if (denied) throw new CoreError("auth", `The identity provider refused the login: ${denied}`);
    if (!code || !login || login.expiresAt <= this.now()) {
      throw new CoreError("auth", "This login link is invalid or has expired; start again");
    }

    const { token_endpoint } = await this.discover();
    const response = await fetch(token_endpoint, {
      method: "POST",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: this.config.redirectUrl,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code_verifier: login.verifier,
      }),
    }).catch(() => undefined);
    const token = tokenSchema.safeParse(
      response?.ok ? await response.json().catch(() => undefined) : undefined,
    );
    if (!token.success) throw new CoreError("auth", "The identity provider did not issue a token");

    // The ID token came straight from the token endpoint over the back channel, so its
    // transport authenticates it (OIDC Core 3.1.3.7); the claims are still checked.
    let payload: unknown;
    try {
      payload = JSON.parse(
        Buffer.from(token.data.id_token.split(".")[1] ?? "", "base64url").toString(),
      );
    } catch {
      payload = undefined;
    }
    const claims = claimsSchema.safeParse(payload);
    if (!claims.success)
      throw new CoreError("auth", "The identity provider returned a malformed ID token");
    const { iss, aud, exp, nonce, sub } = claims.data;
    const audiences = Array.isArray(aud) ? aud : [aud];
    if (
      trimSlash(iss) !== trimSlash(this.config.issuer) ||
      !audiences.includes(this.config.clientId) ||
      exp * 1000 <= this.now() ||
      nonce !== login.nonce
    ) {
      throw new CoreError("auth", "The ID token is not valid for this login");
    }
    return { provider: this.name, subject: sub, claims: claims.data };
  }
}
