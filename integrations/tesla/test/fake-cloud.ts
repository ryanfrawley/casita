// A stand-in for Tesla's auth server and Fleet API: a fetch function with single-use
// refresh tokens, expiring access tokens, and one vehicle from a fixture.

import type { Fetch } from "../src/api.ts";

type Row = Record<string, unknown>;

export const FIXTURE_URL = new URL(
  "../../../tests/fixtures/tesla/vehicle-data.synthetic.json",
  import.meta.url,
);

export class FakeTesla {
  /** Every request, as "METHOD host/path". */
  readonly requests: string[] = [];
  readonly tokenRequests: Row[] = [];
  /** The one refresh token currently valid; each use replaces it. */
  refreshToken = "refresh-1";
  accessToken = "";
  code = "auth-code";
  /** online | asleep | offline */
  state = "online";
  registered = true;
  down = false;
  private issued = 0;

  private constructor(readonly data: Row) {}

  static async create(): Promise<FakeTesla> {
    return new FakeTesla((await Bun.file(FIXTURE_URL).json()) as Row);
  }

  calls(part: string): string[] {
    return this.requests.filter((r) => r.includes(part));
  }

  private issue(): Row {
    this.issued++;
    this.accessToken = `access-${this.issued}`;
    this.refreshToken = `refresh-${this.issued + 1}`;
    return { access_token: this.accessToken, refresh_token: this.refreshToken, expires_in: 28_800 };
  }

  readonly fetch: Fetch = async (url, init) => {
    if (this.down) throw new Error("getaddrinfo ENOTFOUND tesla");
    const parsed = new URL(url);
    const method = init?.method ?? "GET";
    this.requests.push(`${method} ${parsed.host}${parsed.pathname}`);
    const reply = (status: number, body: unknown) => Response.json(body, { status });

    if (parsed.pathname === "/oauth2/v3/token") {
      const form = Object.fromEntries(new URLSearchParams(String(init?.body)));
      this.tokenRequests.push(form);
      if (form.client_secret !== "secret") return reply(401, { error: "invalid_client" });
      if (form.grant_type === "refresh_token") {
        return form.refresh_token === this.refreshToken
          ? reply(200, this.issue())
          : reply(401, { error: "login_required" });
      }
      if (form.grant_type === "authorization_code") {
        return form.code === this.code
          ? reply(200, this.issue())
          : reply(400, { error: "invalid_grant" });
      }
      if (form.grant_type === "client_credentials") {
        return reply(200, { access_token: "partner-token", expires_in: 28_800 });
      }
      return reply(400, { error: "unsupported_grant_type" });
    }

    const auth = new Headers(init?.headers).get("authorization");
    if (parsed.pathname === "/api/1/partner_accounts") {
      if (auth !== "Bearer partner-token") return reply(401, { error: "invalid bearer token" });
      this.registered = true;
      return reply(200, { response: { domain: (JSON.parse(String(init?.body)) as Row).domain } });
    }
    if (auth !== `Bearer ${this.accessToken}`) return reply(401, { error: "invalid bearer token" });
    if (!this.registered) return reply(412, { error: "must be registered in the current region" });

    const { vin, display_name } = this.data;
    if (parsed.pathname === "/api/1/vehicles")
      return reply(200, { response: [{ vin, display_name, state: this.state }] });
    if (parsed.pathname === `/api/1/vehicles/${vin}/vehicle_data`) {
      // A car can fall asleep between the list call and this one.
      if (this.state !== "online")
        return reply(408, { response: null, error: "vehicle unavailable" });
      return reply(200, { response: this.data });
    }
    return reply(404, { error: "not found" });
  };
}
