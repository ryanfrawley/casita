// A stand-in for Open-Meteo: a fetch function that serves the recorded forecast and
// air-quality responses, which a test may alter before they are served.

import type { Fetch } from "../src/api.ts";

type Row = Record<string, unknown>;

const fixture = (name: string) =>
  new URL(`../../../tests/fixtures/open-meteo/${name}`, import.meta.url);

/** When the fixtures were recorded: 2026-10-05 08:30 in Seattle, an hour and a bit after sunrise. */
export const RECORDED_AT = 1_791_214_200_000;

export class FakeOpenMeteo {
  /** Every request made, as its host and its query. */
  readonly requests: { host: string; query: Record<string, string> }[] = [];
  /** Set to make every request fail at the network level. */
  down = false;
  /** Set to make the air-quality API alone answer 500. */
  airDown = false;
  /** Set to answer every request with this status and an Open-Meteo error body. */
  status?: number;

  private constructor(
    readonly forecast: Row & { current: Row; hourly: Record<string, number[]>; daily: Row },
    readonly air: Row & { current: Row },
  ) {}

  static async create(): Promise<FakeOpenMeteo> {
    return new FakeOpenMeteo(
      await Bun.file(fixture("forecast.json")).json(),
      await Bun.file(fixture("air-quality.json")).json(),
    );
  }

  calls(host = ""): number {
    return this.requests.filter((r) => !host || r.host === host).length;
  }

  readonly fetch: Fetch = async (url) => {
    if (this.down) throw new Error("getaddrinfo ENOTFOUND api.open-meteo.com");
    const { host, searchParams } = new URL(url);
    const query = Object.fromEntries(searchParams);
    this.requests.push({ host, query });
    const reply = (status: number, data: unknown) => new Response(JSON.stringify(data), { status });

    if (this.status) return reply(this.status, { error: true, reason: "Too many requests" });
    if (Math.abs(Number(query.latitude)) > 90) {
      return reply(400, { error: true, reason: "Latitude must be in range of -90 to 90°." });
    }
    if (host === "air-quality-api.open-meteo.com") {
      return this.airDown ? reply(500, { error: true, reason: "Internal" }) : reply(200, this.air);
    }
    return reply(200, this.forecast);
  };
}
