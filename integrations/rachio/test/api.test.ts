import { expect, test } from "bun:test";
import { RachioApi, RachioError } from "../src/api.ts";

const BASE = "https://api.rach.io/1/public";
const NOON = Date.parse("2026-10-03T12:00:00Z");
const MIDNIGHT = Date.parse("2026-10-04T00:00:00Z");

interface Reply {
  status?: number;
  /** JSON-encoded unless a string; null for no body. */
  body?: unknown;
  headers?: Record<string, string>;
}

/** A fetch that answers each request with the next reply (the last one repeats) and records it. */
function cloud(...replies: (Reply | Error)[]) {
  const sent: { method: string; url: string; headers: Headers; body?: unknown }[] = [];
  const clock = { now: NOON };
  const fetch = async (url: string, init?: RequestInit) => {
    sent.push({
      method: init?.method ?? "GET",
      url,
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const reply = replies[Math.min(sent.length, replies.length) - 1] ?? {};
    if (reply instanceof Error) throw reply;
    const { status = 200, body = {}, headers = {} } = reply;
    const text = body === null ? null : typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, { status, headers });
  };
  const api = new RachioApi("key-123", fetch, () => clock.now);
  return { api, sent, clock };
}

const limit = (remaining: string, reset = "2026-10-04T00:00:00Z") => ({
  "x-ratelimit-remaining": remaining,
  "x-ratelimit-reset": reset,
});

async function rejection(promise: Promise<unknown>): Promise<RachioError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof RachioError) return err;
    throw err;
  }
  throw new Error("expected a RachioError");
}

// ───────── requests ─────────

test("requests carry the API key as a bearer token and JSON bodies", async () => {
  const { api, sent } = cloud({ status: 204, body: null });
  await api.stopWater("dev-1");
  expect(sent).toHaveLength(1);
  expect(sent[0]?.method).toBe("PUT");
  expect(sent[0]?.url).toBe(`${BASE}/device/stop_water`);
  expect(sent[0]?.headers.get("authorization")).toBe("Bearer key-123");
  expect(sent[0]?.headers.get("content-type")).toBe("application/json");
  expect(sent[0]?.body).toEqual({ id: "dev-1" });
});

test("startZone caps the run at three hours and rounds to whole seconds", async () => {
  const { api, sent } = cloud({ status: 204, body: null });
  await api.startZone("z", 20_000);
  await api.startZone("z", 10_800);
  await api.startZone("z", 90.6);
  await api.startZone("z", 90.4);
  expect(sent.map((s) => s.body)).toEqual([
    { id: "z", duration: 10_800 },
    { id: "z", duration: 10_800 },
    { id: "z", duration: 91 },
    { id: "z", duration: 90 },
  ]);
  expect(sent[0]?.url).toBe(`${BASE}/zone/start`);
});

test("rainDelay rounds the duration; zero is sent to cancel a delay", async () => {
  const { api, sent } = cloud({ status: 204, body: null });
  await api.rainDelay("dev-1", 3600.7);
  await api.rainDelay("dev-1", 0);
  expect(sent.map((s) => [s.url, s.body])).toEqual([
    [`${BASE}/device/rain_delay`, { id: "dev-1", duration: 3601 }],
    [`${BASE}/device/rain_delay`, { id: "dev-1", duration: 0 }],
  ]);
});

test("setEnabled maps to the on and off endpoints", async () => {
  const { api, sent } = cloud({ status: 204, body: null });
  await api.setEnabled("dev-1", true);
  await api.setEnabled("dev-1", false);
  expect(sent.map((s) => s.url)).toEqual([`${BASE}/device/on`, `${BASE}/device/off`]);
});

test("a 204 response resolves to undefined", async () => {
  const { api } = cloud({ status: 204, body: null });
  expect(await api.stopWater("dev-1")).toBeUndefined();
});

// ───────── currentSchedule ─────────

test("currentSchedule parses a running zone", async () => {
  const running = { status: "PROCESSING", zoneId: "zone-1", zoneStartDate: 5, zoneDuration: 60 };
  const { api, sent } = cloud({ body: running });
  expect(await api.currentSchedule("dev-1")).toMatchObject(running);
  expect(sent[0]?.url).toBe(`${BASE}/device/dev-1/current_schedule`);
  expect(sent[0]?.method).toBe("GET");
});

test("currentSchedule treats {}, an empty body, null, and 204 as nothing running", async () => {
  for (const reply of [{ body: {} }, { body: "" }, { body: "null" }, { status: 204, body: null }]) {
    const { api } = cloud(reply);
    expect(await api.currentSchedule("dev-1")).toEqual({});
  }
});

test("currentSchedule rejects a schedule with fields of the wrong type", async () => {
  const { api } = cloud({ body: { zoneId: 42 } });
  await expect(api.currentSchedule("dev-1")).rejects.toThrow();
});

// ───────── devices ─────────

test("devices reads the person id, then that person's controllers", async () => {
  const device = {
    id: "dev-1",
    name: "Backyard",
    status: "ONLINE",
    on: false,
    zones: [{ id: "z1", zoneNumber: 1, name: "Lawn", enabled: false }],
  };
  const { api, sent } = cloud({ body: { id: "p-9" } }, { body: { id: "p-9", devices: [device] } });
  expect(await api.devices()).toMatchObject([device]);
  expect(sent.map((s) => s.url)).toEqual([`${BASE}/person/info`, `${BASE}/person/p-9`]);
});

test("devices fills defaults: no devices list, no zones, zones without enabled, no on", async () => {
  const none = cloud({ body: { id: "p" } }, { body: { id: "p" } });
  expect(await none.api.devices()).toEqual([]);

  const sparse = cloud(
    { body: { id: "p" } },
    {
      body: {
        id: "p",
        devices: [
          { id: "d1", name: "No zones" },
          { id: "d2", name: "Zone default", zones: [{ id: "z", zoneNumber: 1, name: "Lawn" }] },
        ],
      },
    },
  );
  const [first, second] = await sparse.api.devices();
  expect(first).toMatchObject({ id: "d1", on: true, zones: [] });
  expect(second?.zones).toEqual([{ id: "z", zoneNumber: 1, name: "Lawn", enabled: true }]);
});

test("devices rejects a payload whose zones lack required fields, or a person with no id", async () => {
  const noName = cloud(
    { body: { id: "p" } },
    { body: { id: "p", devices: [{ id: "d", name: "D", zones: [{ id: "z", zoneNumber: 1 }] }] } },
  );
  await expect(noName.api.devices()).rejects.toThrow();

  const noId = cloud({ body: { username: "ryan" } });
  await expect(noId.api.devices()).rejects.toThrow();
  expect(noId.sent).toHaveLength(1); // the second request is never made
});

// ───────── errors ─────────

test("401 and 403 say the API key was rejected", async () => {
  for (const status of [401, 403]) {
    const { api } = cloud({ status, body: { error: "Unauthorized" } });
    const err = await rejection(api.stopWater("dev-1"));
    expect(err.message).toBe("Rachio rejected the API key");
    expect(err.retryAt).toBeUndefined();
  }
});

test("other errors include Rachio's error text when the body is JSON", async () => {
  const { api } = cloud({ status: 400, body: { error: "Missing data", code: 301 } });
  const err = await rejection(api.startZone("z", 60));
  expect(err.message).toBe("Rachio answered 400: Missing data");
  expect(err.retryAt).toBeUndefined();
});

test("errors with a non-JSON or unexpected body give just the status", async () => {
  for (const body of ["<html>Bad Gateway</html>", "", { message: "no error field" }]) {
    const { api } = cloud({ status: 502, body });
    expect((await rejection(api.stopWater("dev-1"))).message).toBe("Rachio answered 502");
  }
});

test("a network failure is a RachioError saying Rachio cannot be reached", async () => {
  const { api } = cloud(new Error("getaddrinfo ENOTFOUND api.rach.io"));
  const err = await rejection(api.stopWater("dev-1"));
  expect(err.message).toBe("Cannot reach Rachio: getaddrinfo ENOTFOUND api.rach.io");
  expect(err.retryAt).toBeUndefined();
  expect(api.remaining).toBeUndefined();
});

// ───────── request budget ─────────

test("remaining is undefined before any response and tracks the header after each one", async () => {
  const { api } = cloud(
    { status: 204, body: null, headers: limit("42") },
    { status: 204, body: null, headers: limit("41") },
    { status: 204, body: null }, // no header: the last known count stays
  );
  expect(api.remaining).toBeUndefined();
  await api.stopWater("d");
  expect(api.remaining).toBe(42);
  await api.stopWater("d");
  expect(api.remaining).toBe(41);
  await api.stopWater("d");
  expect(api.remaining).toBe(41);
});

test("the count is read from error responses too", async () => {
  const { api } = cloud({ status: 500, body: "", headers: limit("7") });
  await rejection(api.stopWater("d"));
  expect(api.remaining).toBe(7);
});

test("once the budget is spent, calls are refused locally until the ISO reset time", async () => {
  const { api, sent, clock } = cloud({ status: 204, body: null, headers: limit("0") });
  await api.stopWater("d"); // this one succeeds; it used the last request
  expect(api.remaining).toBe(0);

  const err = await rejection(api.stopWater("d"));
  expect(err.message).toBe("Rachio's daily request limit is used up");
  expect(err.retryAt).toBe(MIDNIGHT);
  expect(sent).toHaveLength(1);

  clock.now = MIDNIGHT - 1;
  await rejection(api.stopWater("d"));
  expect(sent).toHaveLength(1);

  clock.now = MIDNIGHT; // the reset time itself: allowed again
  await api.stopWater("d");
  expect(sent).toHaveLength(2);
});

test("the reset time is also understood in RFC 1123 form", async () => {
  const { api, sent, clock } = cloud({
    status: 204,
    body: null,
    headers: limit("0", "Sun, 04 Oct 2026 00:00:00 GMT"),
  });
  await api.stopWater("d");
  expect((await rejection(api.stopWater("d"))).retryAt).toBe(MIDNIGHT);
  clock.now = MIDNIGHT + 1000;
  await api.stopWater("d");
  expect(sent).toHaveLength(2);
});

test("with no usable reset time, a spent budget does not block requests", async () => {
  // Without knowing when the budget resets, refusing would block forever; Rachio decides.
  const { api, sent } = cloud({
    status: 204,
    body: null,
    headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "soon" },
  });
  await api.stopWater("d");
  await api.stopWater("d");
  expect(sent).toHaveLength(2);
});

test("a 429 is reported as the daily limit, with the reset time as retryAt", async () => {
  const { api, sent } = cloud({ status: 429, body: "", headers: limit("0") });
  const err = await rejection(api.stopWater("d"));
  expect(err.message).toBe("Rachio's daily request limit is used up");
  expect(err.retryAt).toBe(MIDNIGHT);
  // The next call is refused without asking Rachio.
  await rejection(api.stopWater("d"));
  expect(sent).toHaveLength(1);
});

test("a 429 with no rate-limit headers has no retryAt", async () => {
  const { api } = cloud({ status: 429, body: null });
  expect((await rejection(api.stopWater("d"))).retryAt).toBeUndefined();
});

test("a later reset header replaces an earlier one", async () => {
  const { api, clock } = cloud(
    { status: 204, body: null, headers: limit("5", "2026-10-03T00:00:00Z") },
    { status: 204, body: null, headers: limit("0", "2026-10-04T00:00:00Z") },
  );
  await api.stopWater("d");
  await api.stopWater("d");
  clock.now = MIDNIGHT - 1;
  expect((await rejection(api.stopWater("d"))).retryAt).toBe(MIDNIGHT);
});
