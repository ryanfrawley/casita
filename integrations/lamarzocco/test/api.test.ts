import { describe, expect, test } from "bun:test";
import {
  type DashboardHandlers,
  type Fetch,
  LaMarzoccoCloud,
  LaMarzoccoError,
  type MachineView,
  machineView,
  type Socket,
} from "../src/api.ts";
import { clockIn, machineName, modelName, poweredOn } from "../src/index.ts";
import { Installation } from "../src/signing.ts";
import { decodeFrame, encodeFrame } from "../src/stomp.ts";
import { FakeLaMarzocco, NOW } from "./fake-cloud.ts";

const MINUTE = 60_000;

/** A client signed with a fresh installation that the fake cloud has registered. */
async function client(
  options: { now?: () => number; wrap?: (fetch: Fetch) => Fetch } = {},
): Promise<{ fake: FakeLaMarzocco; cloud: LaMarzoccoCloud }> {
  const fake = await FakeLaMarzocco.create();
  const fetch = options.wrap ? options.wrap(fake.fetch) : fake.fetch;
  const cloud = new LaMarzoccoCloud(
    "ry@example.com",
    "good-password",
    new Installation(Installation.generate()),
    fetch,
    options.now ?? (() => NOW),
  );
  await cloud.register();
  return { fake, cloud };
}

/**
 * Lets the fake see (and record) every request, then swaps in `respond`'s answer for the
 * requests it picks out; returning undefined keeps the fake's own answer.
 */
const override =
  (respond: (path: string, n: number) => Response | undefined) =>
  (fetch: Fetch): Fetch => {
    const seen = new Map<string, number>();
    return async (url, init) => {
      const real = await fetch(url, init);
      const path = `${init?.method ?? "GET"} ${new URL(url).pathname.replace("/api/customer-app", "")}`;
      const n = (seen.get(path) ?? 0) + 1;
      seen.set(path, n);
      return respond(path, n) ?? real;
    };
  };

const json = (status: number, data: unknown) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

async function caught(promise: Promise<unknown>): Promise<LaMarzoccoError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof LaMarzoccoError) return err;
    throw err;
  }
  throw new Error("expected a LaMarzoccoError");
}

// ───────────────────────── Tokens ─────────────────────────

describe("access tokens", () => {
  test("a token is reused while it has more than ten minutes left", async () => {
    let now = NOW;
    const { fake, cloud } = await client({ now: () => now });
    const first = await cloud.accessToken();
    now += 49 * MINUTE;
    expect(await cloud.accessToken()).toBe(first);
    await cloud.things();
    expect(fake.calls("/auth/")).toEqual(["POST /auth/init", "POST /auth/signin"]);
  });

  test("within ten minutes of the hour it is refreshed, not signed in again", async () => {
    let now = NOW;
    const { fake, cloud } = await client({ now: () => now });
    const first = await cloud.accessToken();
    now += 50 * MINUTE;
    const second = await cloud.accessToken();
    expect(second).not.toBe(first);
    expect(fake.calls("/auth/")).toEqual([
      "POST /auth/init",
      "POST /auth/signin",
      "POST /auth/refreshtoken",
    ]);
    expect(fake.requests.at(-1)?.body).toEqual({
      username: "ry@example.com",
      refreshToken: "refresh",
    });
    // The refreshed token lasts another hour from when it was issued.
    now += 49 * MINUTE;
    expect(await cloud.accessToken()).toBe(second);
    expect(fake.calls("/auth/")).toHaveLength(3);
  });

  test("a token past its hour is replaced by signing in, not by a refresh", async () => {
    let now = NOW;
    const { fake, cloud } = await client({ now: () => now });
    await cloud.accessToken();
    now += 61 * MINUTE;
    await cloud.accessToken();
    expect(fake.calls("/auth/")).toEqual([
      "POST /auth/init",
      "POST /auth/signin",
      "POST /auth/signin",
    ]);
  });

  test("a failed refresh falls back to signing in", async () => {
    let now = NOW;
    const { fake, cloud } = await client({
      now: () => now,
      wrap: override((path) =>
        path === "POST /auth/refreshtoken" ? json(500, { message: "boom" }) : undefined,
      ),
    });
    await cloud.accessToken();
    now += 55 * MINUTE;
    const token = await cloud.accessToken();
    expect(token).toBe(fake.accessToken);
    expect(fake.calls("/auth/")).toEqual([
      "POST /auth/init",
      "POST /auth/signin",
      "POST /auth/refreshtoken",
      "POST /auth/signin",
    ]);
  });

  test("a refresh the cloud refuses also falls back to signing in", async () => {
    let now = NOW;
    const { fake, cloud } = await client({
      now: () => now,
      wrap: override((path) => (path === "POST /auth/refreshtoken" ? json(401, {}) : undefined)),
    });
    await cloud.accessToken();
    now += 55 * MINUTE;
    expect(await cloud.accessToken()).toBe(fake.accessToken);
    expect(fake.calls("/auth/signin")).toHaveLength(2);
  });

  test("concurrent calls share one sign-in", async () => {
    const { fake, cloud } = await client();
    const tokens = await Promise.all([
      cloud.accessToken(),
      cloud.accessToken(),
      cloud.accessToken(),
    ]);
    expect(new Set(tokens).size).toBe(1);
    expect(fake.calls("/auth/signin")).toHaveLength(1);
  });

  test("concurrent calls near expiry share one refresh", async () => {
    let now = NOW;
    const { fake, cloud } = await client({ now: () => now });
    await cloud.accessToken();
    now += 55 * MINUTE;
    const tokens = await Promise.all([cloud.accessToken(), cloud.accessToken()]);
    expect(new Set(tokens).size).toBe(1);
    expect(fake.calls("/auth/refreshtoken")).toHaveLength(1);
  });

  test("after a failed sign-in, the next call tries again", async () => {
    const { fake, cloud } = await client();
    fake.password = "changed";
    const err = await caught(cloud.accessToken());
    expect(err.message).toMatch(/refused the username or password/);
    expect(err.auth).toBe(true);
    fake.password = "good-password";
    expect(await cloud.accessToken()).toBe(fake.accessToken);
  });

  test("a sign-in the cloud answers with an error status is not an auth failure", async () => {
    const { cloud } = await client({
      wrap: override((path) => (path === "POST /auth/signin" ? json(502, {}) : undefined)),
    });
    const err = await caught(cloud.accessToken());
    expect(err.message).toBe("La Marzocco's sign-in answered 502");
    expect(err.auth).toBe(false);
  });
});

// ───────────────────────── Requests ─────────────────────────

describe("requests", () => {
  test("a 401 signs in again and retries with the new token", async () => {
    const { fake, cloud } = await client();
    await cloud.accessToken();
    fake.accessToken = "revoked-by-the-cloud"; // the token in hand no longer works
    const things = await cloud.things();
    expect(things.map((t) => t.serialNumber)).toEqual(["MR012345", "PG000111"]);
    expect(fake.calls()).toEqual([
      "POST /auth/init",
      "POST /auth/signin",
      "GET /things",
      "POST /auth/signin",
      "GET /things",
    ]);
  });

  test("a second 401 is not retried again: it fails as a refused sign-in", async () => {
    const { fake, cloud } = await client({
      wrap: override((path) => (path === "GET /things" ? json(401, {}) : undefined)),
    });
    const err = await caught(cloud.things());
    expect(err.message).toBe("La Marzocco refused the sign-in");
    expect(err.auth).toBe(true);
    expect(fake.calls("GET /things")).toHaveLength(2);
    expect(fake.calls("/auth/signin")).toHaveLength(2);
  });

  test("a 403 asking for the privacy policy says to accept it in the app", async () => {
    const { cloud } = await client({
      wrap: override((path) =>
        path === "GET /things"
          ? json(403, { code: "USER_MUST_ACCEPT_POLICY", message: "policy" })
          : undefined,
      ),
    });
    const err = await caught(cloud.things());
    expect(err.message).toBe(
      "La Marzocco wants its latest privacy policy accepted: open the La Marzocco app and accept it",
    );
    expect(err.auth).toBe(true);
  });

  test("any other 403 names the refused request", async () => {
    const { cloud } = await client({
      wrap: override((path) => (path === "GET /things" ? json(403, { code: "NOPE" }) : undefined)),
    });
    const err = await caught(cloud.things());
    expect(err.message).toBe("La Marzocco refused GET /things");
    expect(err.auth).toBe(true);
  });

  test("a 403 with a body that is not JSON still names the refused request", async () => {
    const { cloud } = await client({
      wrap: override((path) =>
        path === "GET /things"
          ? new Response("<html>Forbidden</html>", { status: 403 })
          : undefined,
      ),
    });
    expect((await caught(cloud.things())).message).toBe("La Marzocco refused GET /things");
  });

  test("a 403 is not retried", async () => {
    const { fake, cloud } = await client({
      wrap: override((path) => (path === "GET /things" ? json(403, {}) : undefined)),
    });
    await caught(cloud.things());
    expect(fake.calls("GET /things")).toHaveLength(1);
  });

  test("a server error gives its status and is not an auth failure", async () => {
    const { cloud } = await client({
      wrap: override((path) => (path === "GET /things" ? json(503, {}) : undefined)),
    });
    const err = await caught(cloud.things());
    expect(err.message).toBe("La Marzocco answered 503");
    expect(err.auth).toBe(false);
  });

  test("a network failure says La Marzocco cannot be reached, with the cause", async () => {
    const { fake, cloud } = await client();
    await cloud.accessToken();
    fake.down = true;
    const err = await caught(cloud.things());
    expect(err.message).toBe("Cannot reach La Marzocco: getaddrinfo ENOTFOUND lion.lamarzocco.io");
    expect(err.auth).toBe(false);
  });

  test("a network failure while signing in is reported the same way", async () => {
    const { fake, cloud } = await client();
    fake.down = true;
    expect((await caught(cloud.accessToken())).message).toMatch(/^Cannot reach La Marzocco: /);
  });

  test("a thrown non-Error is still described", async () => {
    const cloud = new LaMarzoccoCloud("u", "p", new Installation(Installation.generate()), () =>
      Promise.reject("socket hang up"),
    );
    expect((await caught(cloud.things())).message).toBe("Cannot reach La Marzocco: socket hang up");
  });

  // No public method hands back the raw body (each parses it with a schema), so this reaches
  // the private `request` to see what an empty 2xx becomes.
  test("an empty or blank 2xx body is read as an empty object", async () => {
    for (const blank of [null, "", "  \n"]) {
      const { cloud } = await client({
        wrap: override((path) =>
          path === "POST /things/MR012345/command/Ping"
            ? new Response(blank, { status: 200 })
            : undefined,
        ),
      });
      const raw = cloud as unknown as {
        request(method: string, path: string, body?: unknown): Promise<unknown>;
      };
      expect(await raw.request("POST", "/things/MR012345/command/Ping", {})).toEqual({});
    }
  });

  test("requests carry the bearer token, a signature and a JSON body", async () => {
    const seen: Headers[] = [];
    const { fake, cloud } = await client({
      wrap: (fetch) => async (url, init) => {
        seen.push(new Headers(init?.headers));
        return fetch(url, init);
      },
    });
    await cloud.command("MR012345", "CoffeeMachineChangeMode", { mode: "BrewingMode" });
    const last = seen.at(-1);
    expect(last?.get("authorization")).toBe(`Bearer ${fake.accessToken}`);
    expect(last?.get("content-type")).toBe("application/json");
    expect(fake.signed(last ?? new Headers())).toBe(true);
    // A GET has no body, so no content type.
    await cloud.things();
    expect(seen.at(-1)?.get("content-type")).toBeNull();
  });
});

// ───────────────────────── Commands ─────────────────────────

describe("commands", () => {
  test("returns the id of an accepted command", async () => {
    const { cloud } = await client();
    expect(
      await cloud.command("MR012345", "CoffeeMachineChangeMode", { mode: "BrewingMode" }),
    ).toMatch(/^cmd-\d+$/);
  });

  for (const status of ["Error", "Failed"]) {
    test(`a reply whose first status is ${status} throws, naming the command`, async () => {
      const { cloud } = await client({
        wrap: override((path) =>
          path.includes("/command/")
            ? json(200, [
                { id: "c1", status },
                { id: "c2", status: "Pending" },
              ])
            : undefined,
        ),
      });
      const err = await caught(
        cloud.command("MR012345", "CoffeeMachineChangeMode", { mode: "BrewingMode" }),
      );
      expect(err.message).toBe("The machine refused CoffeeMachineChangeMode");
      expect(err.auth).toBe(false);
    });
  }

  test("only the first status counts: a later Error does not throw", async () => {
    const { cloud } = await client({
      wrap: override((path) =>
        path.includes("/command/")
          ? json(200, [
              { id: "c1", status: "Pending" },
              { id: "c2", status: "Error" },
            ])
          : undefined,
      ),
    });
    expect(await cloud.command("MR012345", "CoffeeMachineChangeMode", {})).toBe("c1");
  });

  test("an empty reply list is rejected rather than taken as success", async () => {
    const { cloud } = await client({
      wrap: override((path) => (path.includes("/command/") ? json(200, []) : undefined)),
    });
    await expect(cloud.command("MR012345", "CoffeeMachineChangeMode", {})).rejects.toThrow();
  });
});

// ───────────────────────── Reading a dashboard ─────────────────────────

type Widgets = Parameters<typeof machineView>[0];
const w = (code: string, output: Record<string, unknown> | null, index = 1) => ({
  code,
  index,
  output,
});

describe("machineView", () => {
  test("reads the Mini R fixture's dashboard", async () => {
    const { cloud } = await client();
    const { view } = await cloud.dashboard("MR012345");
    expect(view).toEqual({
      connected: true,
      mode: "StandBy",
      status: "StandBy",
      brewingSince: undefined,
      coffee: {
        status: "StandBy",
        enabled: true,
        enabledSupported: false,
        readyAt: undefined,
        targetTemperature: 94,
        targetLevel: undefined,
      },
      steam: {
        status: "StandBy",
        enabled: true,
        enabledSupported: true,
        readyAt: undefined,
        targetTemperature: undefined,
        targetLevel: "Level1",
      },
      noWater: undefined,
    });
  });

  test("uses only the first boiler's widgets (index 1)", () => {
    const view = machineView(
      [
        w("CMCoffeeBoiler", { status: "Ready", targetTemperature: 120 }, 2),
        w("CMCoffeeBoiler", { status: "HeatingUp", targetTemperature: 93 }, 1),
        w("CMMachineStatus", { mode: "BrewingMode" }, 0),
      ],
      true,
    );
    expect(view.coffee).toMatchObject({ status: "HeatingUp", targetTemperature: 93 });
    expect(view.mode).toBeUndefined();
  });

  test("a widget with no index counts as index 1", () => {
    const widgets = [{ code: "CMCoffeeBoiler", output: { status: "Ready" } }] as Widgets;
    expect(machineView(widgets, true).coffee?.status).toBe("Ready");
  });

  test("prefers the steam level widget over the steam temperature one", () => {
    const view = machineView(
      [
        w("CMSteamBoilerTemperature", { status: "Ready", targetTemperature: 128 }),
        w("CMSteamBoilerLevel", { status: "HeatingUp", targetLevel: "Level2" }),
      ],
      true,
    );
    expect(view.steam).toMatchObject({ status: "HeatingUp", targetLevel: "Level2" });
    expect(view.steam?.targetTemperature).toBeUndefined();
  });

  test("falls back to the steam temperature widget when there is no level one", () => {
    const view = machineView(
      [w("CMSteamBoilerTemperature", { status: "Ready", targetTemperature: 128 })],
      true,
    );
    expect(view.steam).toMatchObject({ status: "Ready", targetTemperature: 128 });
  });

  test("reads no-water from CMNoWater's misspelt allarm field", () => {
    expect(machineView([w("CMNoWater", { allarm: true })], true).noWater).toBe(true);
    expect(machineView([w("CMNoWater", { allarm: false })], true).noWater).toBe(false);
    // Spelt correctly it is not what the cloud sends, so it is not an alarm.
    expect(machineView([w("CMNoWater", { alarm: true })], true).noWater).toBe(false);
    expect(machineView([], true).noWater).toBeUndefined();
  });

  test("ignores widgets it does not know", () => {
    const view = machineView(
      [w("CMPreExtraction", { mode: "Disabled" }), w("CMSomethingNew", { status: "Ready" })],
      false,
    );
    expect(view).toEqual({
      connected: false,
      mode: undefined,
      status: undefined,
      brewingSince: undefined,
      coffee: undefined,
      steam: undefined,
      noWater: undefined,
    });
  });

  test("tolerates a widget whose output is null", () => {
    const view = machineView(
      [
        w("CMMachineStatus", null),
        w("CMCoffeeBoiler", null),
        w("CMSteamBoilerLevel", null),
        w("CMSteamBoilerTemperature", { status: "Ready" }),
        w("CMNoWater", null),
      ],
      true,
    );
    expect(view.mode).toBeUndefined();
    expect(view.coffee).toBeUndefined();
    // A null level widget gives way to the temperature one.
    expect(view.steam?.status).toBe("Ready");
    expect(view.noWater).toBeUndefined();
  });

  test("a dashboard whose widget output is null parses", async () => {
    const { fake, cloud } = await client();
    fake.dashboard.widgets.push({ code: "CMNoWater", output: null as never });
    const { view } = await cloud.dashboard("MR012345");
    expect(view.noWater).toBeUndefined();
    expect(view.coffee?.status).toBe("StandBy");
  });

  test("a boiler with missing or wrongly typed fields gets safe defaults", () => {
    const view = machineView(
      [
        w("CMCoffeeBoiler", {
          status: 3,
          targetTemperature: "94",
          readyStartTime: Number.NaN,
        }),
      ],
      true,
    );
    expect(view.coffee).toEqual({
      status: "Off",
      enabled: true,
      enabledSupported: false,
      readyAt: undefined,
      targetTemperature: undefined,
      targetLevel: undefined,
    });
  });

  test("a boiler is disabled only when enabled is exactly false", () => {
    expect(machineView([w("CMCoffeeBoiler", { enabled: false })], true).coffee?.enabled).toBe(
      false,
    );
    expect(machineView([w("CMCoffeeBoiler", { enabled: null })], true).coffee?.enabled).toBe(true);
  });

  test("brewing reports when the shot started", () => {
    const view = machineView(
      [w("CMMachineStatus", { mode: "BrewingMode", status: "Brewing", brewingStartTime: NOW })],
      true,
    );
    expect(view).toMatchObject({ mode: "BrewingMode", status: "Brewing", brewingSince: NOW });
  });
});

// ───────────────────────── Naming and power ─────────────────────────

const view = (v: Partial<MachineView>): MachineView => ({ connected: true, ...v });

describe("poweredOn", () => {
  test("follows the mode when there is one", () => {
    expect(poweredOn(view({ mode: "BrewingMode", status: "StandBy" }))).toBe(true);
    expect(poweredOn(view({ mode: "EcoMode" }))).toBe(true);
    expect(poweredOn(view({ mode: "StandBy", status: "Brewing" }))).toBe(false);
  });

  test("without a mode, follows the status", () => {
    expect(poweredOn(view({ status: "PoweredOn" }))).toBe(true);
    expect(poweredOn(view({ status: "Brewing" }))).toBe(true);
    expect(poweredOn(view({ status: "StandBy" }))).toBe(false);
    expect(poweredOn(view({ status: "Off" }))).toBe(false);
  });

  test("with neither, it is off", () => {
    expect(poweredOn(view({}))).toBe(false);
  });
});

const thing = (t: Record<string, unknown>) =>
  ({ serialNumber: "GS0001", type: "CoffeeMachine", connected: true, ...t }) as Parameters<
    typeof machineName
  >[0];

describe("machine and model names", () => {
  test("the app's name for a known model code", () => {
    expect(modelName(thing({ modelCode: "LINEAMINIR", modelName: "LINEA MINI 2023" }))).toBe(
      "Linea Mini R",
    );
    expect(modelName(thing({ modelCode: "GS3AV" }))).toBe("GS3 AV");
  });

  test("an unknown model code falls back to the cloud's model name, then the code", () => {
    expect(modelName(thing({ modelCode: "STRADA", modelName: "STRADA X" }))).toBe("STRADA X");
    expect(modelName(thing({ modelCode: "STRADA", modelName: null }))).toBe("STRADA");
    expect(modelName(thing({}))).toBeUndefined();
  });

  test("the name given in the app wins, trimmed", () => {
    expect(machineName(thing({ name: "  Kitchen  ", modelCode: "GS3" }))).toBe("Kitchen");
  });

  test("a name that is only the serial number takes the model's name", () => {
    expect(machineName(thing({ name: "GS0001", modelCode: "GS3" }))).toBe("GS3");
    expect(machineName(thing({ name: " GS0001 ", modelCode: "NEW", modelName: "New One" }))).toBe(
      "New One",
    );
  });

  test("a blank or missing name takes the model's name", () => {
    expect(machineName(thing({ name: "   ", modelCode: "LINEAMICRA" }))).toBe("Linea Micra");
    expect(machineName(thing({ name: null, modelCode: "LINEAMINI" }))).toBe("Linea Mini");
  });

  test("with no name and no model, the serial number", () => {
    expect(machineName(thing({ name: "GS0001" }))).toBe("GS0001");
  });
});

describe("clockIn", () => {
  test("formats a time in the given zone, lower-case", () => {
    expect(clockIn("America/Los_Angeles")(NOW + 20 * MINUTE)).toBe("5:46 am");
    expect(clockIn("UTC")(NOW)).toBe("12:26 pm");
  });

  test("a zone it does not know falls back to the server's without throwing", () => {
    let clock: ((ms: number) => string) | undefined;
    expect(() => {
      clock = clockIn("Mars/Olympus_Mons");
    }).not.toThrow();
    expect(clock?.(NOW)).toBe(clockIn(undefined)(NOW));
  });

  test("uses a plain space before am/pm, not the narrow no-break space", () => {
    expect(clockIn("UTC")(NOW)).not.toMatch(/[  ]/);
  });
});

// ───────────────────────── The dashboard socket ─────────────────────────

/** A socket the test drives by hand: nothing happens until the test says so. */
class ScriptedSocket implements Socket {
  private readonly listeners = new Map<string, ((e: { data: unknown }) => void)[]>();
  readonly sent: string[] = [];
  closed = 0;
  headers: Record<string, string> = {};

  addEventListener(type: string, listener: (e: { data: unknown }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  emit(type: "open" | "close" | "error" | "message", data?: unknown): void {
    for (const l of this.listeners.get(type) ?? []) l({ data });
  }

  frame(command: Parameters<typeof encodeFrame>[0], headers = {}, body = ""): void {
    this.emit("message", encodeFrame(command, headers, body));
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed++;
  }

  commands(): string[] {
    return this.sent.map((s) => decodeFrame(s)?.command ?? "?");
  }
}

function recorder() {
  const updates: (MachineView | undefined)[] = [];
  const closes: Error[] = [];
  const handlers: DashboardHandlers = {
    onUpdate: (v) => updates.push(v),
    onClose: (e) => closes.push(e),
  };
  return { updates, closes, handlers };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Opens a scripted socket and brings it to subscribed. */
async function subscribed(cloud: LaMarzoccoCloud, handlers: DashboardHandlers) {
  const socket = new ScriptedSocket();
  const connecting = cloud.connectDashboard("MR012345", handlers, (_url, headers) => {
    socket.headers = headers;
    return socket;
  });
  await tick();
  socket.emit("open");
  socket.frame("CONNECTED", { version: "1.2" });
  return { socket, connection: await connecting };
}

describe("connectDashboard", () => {
  test("connects with the bearer token and subscribes to the machine's dashboard", async () => {
    const { fake, cloud } = await client();
    const { socket } = await subscribed(cloud, recorder().handlers);
    const [connect, subscribe] = socket.sent.map(decodeFrame);
    expect(connect?.command).toBe("CONNECT");
    expect(connect?.headers).toMatchObject({
      host: "lion.lamarzocco.io",
      Authorization: `Bearer ${fake.accessToken}`,
    });
    expect(subscribe?.command).toBe("SUBSCRIBE");
    expect(subscribe?.headers.destination).toBe("/ws/sn/MR012345/dashboard");
    expect(fake.signed(socket.headers)).toBe(true);
  });

  test("an ERROR frame before CONNECTED rejects, with the server's message", async () => {
    const { fake, cloud } = await client();
    await cloud.accessToken();
    fake.accessToken = "someone-else"; // the fake answers CONNECT with ERROR: Unauthorized
    const { closes, handlers } = recorder();
    const err = await caught(cloud.connectDashboard("MR012345", handlers, fake.openSocket));
    expect(err.message).toBe("La Marzocco's socket: Unauthorized");
    expect(fake.socket?.closed).toBe(true);
    expect(fake.socket?.subscribed).toBeUndefined();
    expect(closes).toHaveLength(0);
  });

  test("an ERROR frame with no message header uses its body", async () => {
    const { cloud } = await client();
    const socket = new ScriptedSocket();
    const connecting = cloud.connectDashboard("MR012345", recorder().handlers, () => socket);
    await tick();
    socket.frame("ERROR", {}, "bad things");
    expect((await caught(connecting)).message).toBe("La Marzocco's socket: bad things");
  });

  test("times out if CONNECTED never arrives, and closes the socket", async () => {
    const { cloud } = await client();
    const socket = new ScriptedSocket();
    const { closes, handlers } = recorder();
    const connecting = cloud.connectDashboard("MR012345", handlers, () => socket, 20);
    await tick();
    socket.emit("open");
    const err = await caught(connecting);
    expect(err.message).toBe("timed out connecting to La Marzocco's socket");
    expect(socket.closed).toBe(1);
    expect(socket.commands()).toEqual(["CONNECT"]);
    // A close event the server sends afterwards changes nothing.
    socket.emit("close");
    expect(closes).toHaveLength(0);
  });

  test("once subscribed, the timeout no longer applies", async () => {
    const { cloud } = await client();
    const socket = new ScriptedSocket();
    const { closes, handlers } = recorder();
    const connecting = cloud.connectDashboard("MR012345", handlers, () => socket, 20);
    await tick();
    socket.emit("open");
    socket.frame("CONNECTED");
    await connecting;
    await Bun.sleep(40);
    expect(closes).toHaveLength(0);
    expect(socket.closed).toBe(0);
  });

  test("a socket that fails before connecting rejects", async () => {
    const { fake, cloud } = await client();
    fake.socketsRefused = true;
    const err = await caught(
      cloud.connectDashboard("MR012345", recorder().handlers, fake.openSocket),
    );
    expect(err.message).toBe("La Marzocco's socket failed");
  });

  test("a MESSAGE body that is not JSON is ignored without closing the socket", async () => {
    const { cloud } = await client();
    const { updates, closes, handlers } = recorder();
    const { socket } = await subscribed(cloud, handlers);
    socket.frame("MESSAGE", { destination: "/ws/sn/MR012345/dashboard" }, "{not json");
    socket.frame("MESSAGE", {}, JSON.stringify({ widgets: "not a list" }));
    expect(updates).toHaveLength(0);
    expect(closes).toHaveLength(0);
    expect(socket.closed).toBe(0);

    // The next good message still comes through.
    socket.frame(
      "MESSAGE",
      {},
      JSON.stringify({ connected: true, widgets: [w("CMCoffeeBoiler", { status: "Ready" })] }),
    );
    expect(updates.map((u) => u?.coffee?.status)).toEqual(["Ready"]);
  });

  test("heart-beat newlines are ignored, before and after subscribing", async () => {
    const { cloud } = await client();
    const socket = new ScriptedSocket();
    const { updates, closes, handlers } = recorder();
    const connecting = cloud.connectDashboard("MR012345", handlers, () => socket);
    await tick();
    socket.emit("open");
    socket.emit("message", "\n");
    socket.emit("message", "\r\n");
    socket.frame("CONNECTED");
    await connecting;
    socket.emit("message", "\n");
    socket.emit("message", "\n\n");
    expect(updates).toHaveLength(0);
    expect(closes).toHaveLength(0);
    expect(socket.commands()).toEqual(["CONNECT", "SUBSCRIBE"]);
  });

  test("a frame after leading heart-beat newlines is still read", async () => {
    const { cloud } = await client();
    const { updates, handlers } = recorder();
    const { socket } = await subscribed(cloud, handlers);
    socket.emit(
      "message",
      `\n\n${encodeFrame("MESSAGE", {}, JSON.stringify({ widgets: [w("CMNoWater", { allarm: true })] }))}`,
    );
    expect(updates.map((u) => u?.noWater)).toEqual([true]);
  });

  test("a message with only command outcomes carries them, and no machine state", async () => {
    const { cloud } = await client();
    const seen: unknown[] = [];
    const { socket } = await subscribed(cloud, {
      onUpdate: (v, commands) => seen.push([v, commands]),
      onClose: () => {},
    });
    socket.frame(
      "MESSAGE",
      {},
      JSON.stringify({ connected: false, commands: [{ id: "c1", status: "Success" }] }),
    );
    expect(seen).toEqual([[undefined, [{ id: "c1", status: "Success" }]]]);
  });

  test("the server closing a subscribed socket calls onClose once", async () => {
    const { cloud } = await client();
    const { closes, handlers } = recorder();
    const { socket } = await subscribed(cloud, handlers);
    socket.emit("error");
    socket.emit("close");
    expect(closes.map((e) => e.message)).toEqual(["La Marzocco's socket failed"]);
  });

  test("an ERROR frame after subscribing closes it through onClose", async () => {
    const { cloud } = await client();
    const { closes, handlers } = recorder();
    const { socket } = await subscribed(cloud, handlers);
    socket.frame("ERROR", { message: "session expired" });
    expect(closes.map((e) => e.message)).toEqual(["La Marzocco's socket: session expired"]);
    expect(socket.closed).toBe(1);
  });

  test("closing it locally unsubscribes and does not call onClose", async () => {
    const { cloud } = await client();
    const { closes, handlers } = recorder();
    const { socket, connection } = await subscribed(cloud, handlers);
    connection.close();
    connection.close();
    socket.emit("close");
    expect(socket.commands()).toEqual(["CONNECT", "SUBSCRIBE", "UNSUBSCRIBE"]);
    expect(socket.closed).toBe(1);
    expect(closes).toHaveLength(0);
  });

  test("a sign-in failure rejects before any socket is opened", async () => {
    const { fake, cloud } = await client();
    fake.password = "changed";
    let opened = 0;
    const err = await caught(
      cloud.connectDashboard("MR012345", recorder().handlers, () => {
        opened++;
        return new ScriptedSocket();
      }),
    );
    expect(err.auth).toBe(true);
    expect(opened).toBe(0);
  });
});
