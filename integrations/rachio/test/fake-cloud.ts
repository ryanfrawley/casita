// A stand-in for Rachio's cloud: a fetch function that serves a fixture account, obeys
// zone commands, and counts down a request budget.

import type { Fetch } from "../src/api.ts";

type Row = Record<string, unknown>;

export const FIXTURE_URL = new URL(
  "../../../tests/fixtures/rachio/person.synthetic.json",
  import.meta.url,
);

export class FakeRachio {
  /** Every request made, as "METHOD /path" plus its JSON body. */
  readonly requests: { call: string; body?: Row }[] = [];
  apiKey = "good-key";
  remaining = 3500;
  /** Set to make every request fail at the network level. */
  down = false;
  running?: { zoneId: string; startedAt: number; seconds: number };

  private constructor(readonly person: { id: string; devices: Row[] }) {}

  static async create(): Promise<FakeRachio> {
    return new FakeRachio((await Bun.file(FIXTURE_URL).json()) as { id: string; devices: Row[] });
  }

  device(id = "dev-1"): Row {
    const device = this.person.devices.find((d) => d.id === id);
    if (!device) throw new Error(`no device ${id}`);
    return device;
  }

  calls(prefix = ""): string[] {
    return this.requests.map((r) => r.call).filter((c) => c.includes(prefix));
  }

  readonly fetch: Fetch = async (url, init) => {
    if (this.down) throw new Error("getaddrinfo ENOTFOUND api.rach.io");
    const path = new URL(url).pathname.replace("/1/public", "");
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Row) : undefined;
    this.requests.push({ call: `${method} ${path}`, body });

    const headers = {
      "x-ratelimit-limit": "3500",
      "x-ratelimit-remaining": String(Math.max(0, --this.remaining)),
      "x-ratelimit-reset": "2026-10-04T00:00:00Z",
    };
    const reply = (status: number, data?: unknown) =>
      new Response(data === undefined ? null : JSON.stringify(data), { status, headers });
    const auth = new Headers(init?.headers).get("authorization");
    if (auth !== `Bearer ${this.apiKey}`) return reply(401, { error: "Unauthorized" });
    if (this.remaining < 0) return reply(429);

    if (path === "/person/info") return reply(200, { id: this.person.id });
    if (path === `/person/${this.person.id}`) return reply(200, this.person);
    const schedule = /^\/device\/([^/]+)\/current_schedule$/.exec(path);
    if (schedule) {
      const r = this.running;
      return reply(
        200,
        r
          ? {
              status: "PROCESSING",
              zoneId: r.zoneId,
              zoneStartDate: r.startedAt,
              zoneDuration: r.seconds,
            }
          : {},
      );
    }
    if (path === "/zone/start") {
      if (typeof body?.id !== "string") return reply(400, { error: "Missing data", code: 301 });
      this.running = { zoneId: body.id, startedAt: 1_000_000, seconds: Number(body.duration) };
      return reply(204);
    }
    if (path === "/device/stop_water") {
      this.running = undefined;
      return reply(204);
    }
    if (path === "/device/rain_delay") {
      this.device(String(body?.id)).rainDelayExpirationDate =
        2_000_000 + Number(body?.duration) * 1000;
      return reply(204);
    }
    if (path === "/device/on" || path === "/device/off") {
      this.device(String(body?.id)).on = path === "/device/on";
      return reply(204);
    }
    return reply(404, { error: "Not found" });
  };
}
