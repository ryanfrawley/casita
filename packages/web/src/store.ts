// What the web app knows about the house, kept current over one socket.
//
// `reduce` is a pure function from what the server said to what the app holds, as the CLI
// dashboard's layout is a pure function of its data. `createStore` is the part that talks:
// it connects, loads, subscribes, reconnects, and sends commands. Nothing here is drawn
// ahead of the device: a command marks its entity pending until the server answers.

import type { RequestParams, RequestType } from "@casita/api/schema";
import {
  type CasitaClient,
  CasitaError,
  type EventMessage,
  present,
  type Row,
  setUnits,
  type UnitSystem,
} from "@casita/client";

export type Command = RequestParams<"send_command">["command"];

export type Phase =
  /** The first connection is being made. */
  | "connecting"
  /** The server wants a login. */
  | "signed-out"
  | "ready"
  /** The socket dropped; what is shown is the last the server said. */
  | "reconnecting";

export interface House {
  phase: Phase;
  me?: Row;
  units: UnitSystem;
  entities: Row[];
  devices: Row[];
  areas: Row[];
  /** entity id → state record */
  states: ReadonlyMap<string, Row>;
  integrations: Row[];
  /** Commands in flight: entity id → what is being waited for ("Turning on…"). */
  pending: ReadonlyMap<string, string>;
  /** What the house did lately, newest first. */
  recent: readonly Happening[];
}

export interface Happening {
  entityId: string;
  name: string;
  /** How the new state reads: "On · 40%", "Unlocked". */
  text: string;
  at: number;
}

const RECENT_KEPT = 20;

/** What changed, without how long ago: "Motion · 4 min" → "Motion", "Pressed just now" → "Pressed". */
const happened = (domain: string, text: string): string =>
  domain === "binary_sensor"
    ? (text.split(" · ")[0] ?? text)
    : domain === "button" && text.startsWith("Pressed")
      ? "Pressed"
      : text;

export const EMPTY: House = {
  phase: "connecting",
  units: "metric",
  entities: [],
  devices: [],
  areas: [],
  states: new Map(),
  integrations: [],
  pending: new Map(),
  recent: [],
};

export type Loaded = Pick<House, "me" | "entities" | "devices" | "areas" | "integrations"> & {
  states: Row[];
};

export type Action =
  | { type: "phase"; phase: Phase }
  | { type: "loaded"; data: Loaded }
  | { type: "units"; units: UnitSystem }
  | { type: "me"; me: Row }
  /** The integrations as `get_integrations` lists them, again. */
  | { type: "integrations"; integrations: Row[] }
  | { type: "event"; event: EventMessage["event"] }
  | { type: "command_sent"; entityId: string; waiting: string }
  | { type: "command_done"; entityId: string };

const withEntry = <V>(map: ReadonlyMap<string, V>, key: string, value: V | undefined) => {
  const next = new Map(map);
  if (value === undefined) next.delete(key);
  else next.set(key, value);
  return next;
};

export function reduce(house: House, action: Action): House {
  switch (action.type) {
    case "phase":
      // Signing out forgets the house: the next person may not be allowed to see it.
      return action.phase === "signed-out"
        ? { ...EMPTY, phase: "signed-out", units: house.units }
        : { ...house, phase: action.phase };
    case "loaded":
      return {
        ...house,
        ...action.data,
        states: new Map(action.data.states.map((record) => [String(record.entityId), record])),
        phase: "ready",
      };
    case "units":
      return { ...house, units: action.units };
    case "integrations":
      return { ...house, integrations: action.integrations };
    case "me":
      return { ...house, me: action.me };
    case "command_sent":
      return { ...house, pending: withEntry(house.pending, action.entityId, action.waiting) };
    case "command_done":
      return { ...house, pending: withEntry(house.pending, action.entityId, undefined) };
    case "event": {
      const event = action.event as Row & { type: string };
      if (event.type === "state_changed") {
        const id = String(event.entityId);
        const after = event.new as Row;
        const entity = house.entities.find((candidate) => candidate.id === id);
        // Worth a line only when what it reads as has changed, and only for what is shown.
        // A sensor's or the weather's every reading is not news; its history is in its chart.
        // Both read against the same moment, so "Motion · 5 min" does not differ from itself
        // five minutes on; and the line keeps only what happened, since it carries its own time.
        const at = Number(after.updatedAt);
        const text = happened(String(entity?.domain), present(after, at).text);
        const before = happened(String(entity?.domain), present(house.states.get(id), at).text);
        const noted =
          entity &&
          !entity.hidden &&
          entity.domain !== "sensor" &&
          entity.domain !== "weather" &&
          text !== before
            ? [
                { entityId: id, name: String(entity.name), text, at: Number(after.updatedAt) },
                ...house.recent,
              ].slice(0, RECENT_KEPT)
            : house.recent;
        return { ...house, states: withEntry(house.states, id, after), recent: noted };
      }
      if (event.type === "integration_status") {
        const { integrationId, status, error } = event;
        const known = house.integrations.some((i) => i.integrationId === integrationId);
        return {
          ...house,
          integrations: known
            ? house.integrations.map((i) =>
                i.integrationId === integrationId ? { ...i, status, error } : i,
              )
            : [...house.integrations, { integrationId, status, error }],
        };
      }
      return house;
    }
  }
}

/** Entities, devices and areas coming, going or changing: the lists are loaded again. */
const TOPOLOGY = /^(entity|device|area)_/;
/** A config change at or above server.units may have changed the unit system. */
const UNITS_PATHS = ["server.units", "server", ""];

/** How a command ended, in the server's own words when it failed. */
export type Outcome =
  | { ok: true; confirmed: boolean }
  | { ok: false; code: string; message: string };

export type RenameListener = (oldId: string, newId: string, kind: "entity" | "device") => void;

export interface Store {
  getState(): House;
  subscribe(listener: () => void): () => void;
  /** Connects, and keeps connected. Resolves once the first attempt has ended either way. */
  start(): Promise<void>;
  stop(): void;
  /** Signs in for a session cookie, then connects. Rejects with the server's message. */
  login(username: string, password: string): Promise<void>;
  logout(): Promise<void>;
  /**
   * Sends a command and waits for the device to confirm. The entity reads `waiting` until
   * the answer comes; its state changes only when the device reports it.
   */
  command(entityId: string, command: Command, waiting: string): Promise<Outcome>;
  /** Hears each event of one type, for a page that keeps a list of its own current. */
  onEvent(type: string, listener: (event: Row) => void): () => void;
  /** Hears of each entity or device whose id changes, as (old id, new id, what it is). */
  onRenamed(listener: RenameListener): () => void;
  /** Any other request; rejects with a CasitaError carrying the server's code and message. */
  request<T extends RequestType>(type: T, params: RequestParams<T>): Promise<unknown>;
  /** Asks again who is signed in, after something about them changed. */
  refreshMe(): Promise<void>;
}

export interface StoreOptions {
  /** Opens an authenticated socket. In a browser the session cookie does the authenticating. */
  connect: () => Promise<CasitaClient>;
  /** Base URL for the HTTP routes; empty for the page's own origin. */
  http?: string;
  fetch?: typeof fetch;
  /** Delay before reconnect attempt `n` (from 0). Default: 1 s doubling to 30 s. */
  backoff?: (attempt: number) => number;
  /**
   * How often a `ping` goes out on a quiet socket, so a proxy or the server does not take
   * silence for a dead connection and cut it. Default 30 s; 0 sends none.
   */
  keepaliveMs?: number;
  /** How long a dropped socket may take to come back before "reconnecting" is shown. Default 2 s. */
  graceMs?: number;
  /**
   * How long a request made while the socket is (re)connecting waits for it, so a page that
   * asks as it mounts on a fresh load is answered once the house is reached. Default 10 s.
   */
  connectWaitMs?: number;
}

export function createStore(options: StoreOptions): Store {
  const { connect, http = "" } = options;
  const request_ = options.fetch ?? fetch;
  const backoff = options.backoff ?? ((attempt) => Math.min(30_000, 1000 * 2 ** attempt));
  const keepaliveMs = options.keepaliveMs ?? 30_000;
  const graceMs = options.graceMs ?? 2_000;
  const connectWaitMs = options.connectWaitMs ?? 10_000;
  /** Requests waiting for a socket: told when one opens, or failed when the store stops. */
  const waiting = new Set<{ open(c: CasitaClient): void; fail(err: unknown): void }>();
  const listeners = new Set<() => void>();
  const renameListeners = new Set<RenameListener>();
  const eventListeners = new Map<string, Set<(event: Row) => void>>();
  let house = EMPTY;
  let client: CasitaClient | undefined;
  let stopped = true;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let reload: ReturnType<typeof setTimeout> | undefined;
  let grace: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const dispatch = (action: Action) => {
    const next = reduce(house, action);
    if (next === house) return;
    house = next;
    // Signed out, no socket is coming: what waits for one is told so now.
    if (house.phase === "signed-out")
      for (const w of [...waiting]) w.fail(new CasitaError("auth", "Signed out"));
    for (const listener of listeners) listener();
  };

  const applyUnits = (units: UnitSystem) => {
    setUnits(units);
    dispatch({ type: "units", units });
  };

  const load = async (from: CasitaClient) => {
    const [me, entities, devices, areas, states, integrations] = await Promise.all([
      from.request("get_me", {}),
      from.request("get_entities", {}),
      from.request("get_devices", {}),
      from.request("get_areas", {}),
      from.request("get_states", {}),
      from.request("get_integrations", {}),
    ]);
    if (from !== client) return; // superseded while loading
    dispatch({
      type: "loaded",
      data: {
        me: (me as { user: Row }).user,
        entities: entities as Row[],
        devices: devices as Row[],
        areas: areas as Row[],
        states: states as Row[],
        integrations: integrations as Row[],
      },
    });
  };

  const onEvent = (from: CasitaClient, { event }: EventMessage) => {
    dispatch({ type: "event", event });
    for (const listener of eventListeners.get(event.type) ?? []) listener(event as Row);
    if (event.type === "entity_renamed" || event.type === "device_renamed") {
      const kind = event.type === "entity_renamed" ? "entity" : "device";
      const renamed = event as {
        oldId?: unknown;
        entity?: { id?: unknown };
        device?: { id?: unknown };
      };
      const newId = kind === "entity" ? renamed.entity?.id : renamed.device?.id;
      for (const listener of renameListeners) listener(String(renamed.oldId), String(newId), kind);
    }
    if (TOPOLOGY.test(event.type)) {
      // A rename or a new device arrives as a burst of events; one reload covers it.
      clearTimeout(reload);
      reload = setTimeout(() => void load(from).catch(() => {}), 200);
    } else if (event.type === "integration_status" && event.status === "running") {
      // What a running instance offers (its actions, whether its devices have settings) is
      // known only once its setup has finished.
      void from.request("get_integrations", {}).then(
        (integrations) => {
          if (from === client)
            dispatch({ type: "integrations", integrations: integrations as Row[] });
        },
        () => {},
      );
    } else if (event.type === "config_changed" && UNITS_PATHS.includes(String(event.path))) {
      void from.request("get_status", {}).then(
        (status) => applyUnits((status as Row).units === "imperial" ? "imperial" : "metric"),
        () => {},
      );
    }
  };

  const open = async (attempt: number): Promise<void> => {
    if (stopped) return;
    let opened: CasitaClient | undefined;
    try {
      const next = await connect();
      if (stopped) return next.close();
      client = opened = next;
      for (const w of [...waiting]) w.open(next);
      applyUnits(next.units);
      next.onEvent((message) => onEvent(next, message));
      next.onClose((code) => {
        if (client !== next) return;
        client = undefined;
        clearTimeout(reload);
        clearInterval(heartbeat);
        if (stopped) return;
        // The server ends a socket this way when its session ends.
        if (code === 4401) return dispatch({ type: "phase", phase: "signed-out" });
        // A socket that was cut while the house is fine is back in a moment; the banner is for
        // when it is not. Meanwhile what is shown is the last the server said.
        clearTimeout(grace);
        grace = setTimeout(() => dispatch({ type: "phase", phase: "reconnecting" }), graceMs);
        retry = setTimeout(() => void open(0), 0);
      });
      // Subscribed before loading, so nothing that changes during the load is missed.
      await next.request("subscribe", {});
      await load(next);
      clearTimeout(grace);
      // A quiet house sends nothing for a long time; a ping says the socket is still wanted.
      // One that goes unanswered means the socket is dead without saying so: close it, and
      // the close handler brings a new one.
      if (keepaliveMs > 0) {
        heartbeat = setInterval(() => {
          if (client !== next) return clearInterval(heartbeat);
          next.request("ping", {}).catch(() => next.close());
        }, keepaliveMs);
      }
    } catch (err) {
      if (stopped) return;
      if (err instanceof CasitaError && err.code === "auth") {
        return dispatch({ type: "phase", phase: "signed-out" });
      }
      if (opened) {
        // The socket opened and then something failed. Its close handler does the retrying;
        // if it is somehow still open, closing it gets us there.
        if (client === opened) opened.close();
        return;
      }
      // Could not get back: say so now rather than at the end of the grace.
      clearTimeout(grace);
      if (house.phase !== "connecting") dispatch({ type: "phase", phase: "reconnecting" });
      retry = setTimeout(() => void open(attempt + 1), backoff(attempt));
    }
  };

  const notConnected = () => new CasitaError("connection", "Not connected to the house right now");
  const live = (): CasitaClient => {
    if (!client) throw notConnected();
    return client;
  };
  /** The socket, waiting a while for one that is on its way; never once signed out or stopped. */
  const soon = (): Promise<CasitaClient> => {
    if (client) return Promise.resolve(client);
    if (house.phase === "signed-out") return Promise.reject(new CasitaError("auth", "Signed out"));
    if (stopped) return Promise.reject(notConnected());
    return new Promise((resolve, reject) => {
      const w = {
        open: (c: CasitaClient) => {
          clearTimeout(timer);
          waiting.delete(w);
          resolve(c);
        },
        fail: (err: unknown) => {
          clearTimeout(timer);
          waiting.delete(w);
          reject(err);
        },
      };
      const timer = setTimeout(() => w.fail(notConnected()), connectWaitMs);
      waiting.add(w);
    });
  };

  return {
    getState: () => house,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    start() {
      stopped = false;
      return open(0);
    },
    stop() {
      stopped = true;
      for (const w of [...waiting]) w.fail(notConnected());
      clearTimeout(retry);
      clearTimeout(reload);
      clearTimeout(grace);
      clearInterval(heartbeat);
      client?.close();
      client = undefined;
    },
    async login(username, password) {
      const response = await request_(`${http}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, cookie: true }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new CasitaError("auth", body.error?.message ?? "Couldn't sign in");
      }
      clearTimeout(retry);
      dispatch({ type: "phase", phase: "connecting" });
      stopped = false;
      await open(0);
    },
    async logout() {
      await request_(`${http}/api/auth/logout`, { method: "POST" }).catch(() => {});
      this.stop();
      dispatch({ type: "phase", phase: "signed-out" });
    },
    async command(entityId, command, waiting) {
      dispatch({ type: "command_sent", entityId, waiting });
      try {
        const result = (await live().request("send_command", {
          entityId,
          command,
          confirm: true,
        })) as Row;
        return { ok: true, confirmed: result.status === "confirmed" };
      } catch (err) {
        return err instanceof CasitaError
          ? { ok: false, code: err.code, message: err.message }
          : { ok: false, code: "internal", message: String(err) };
      } finally {
        dispatch({ type: "command_done", entityId });
      }
    },
    onEvent(type, listener) {
      const set = eventListeners.get(type) ?? new Set();
      eventListeners.set(type, set);
      set.add(listener);
      return () => void set.delete(listener);
    },
    onRenamed(listener) {
      renameListeners.add(listener);
      return () => void renameListeners.delete(listener);
    },
    // A command is now or not at all; a request may wait for the socket to come.
    request: (type, params) => soon().then((c) => c.request(type, params)),
    async refreshMe() {
      const me = (await live().request("get_me", {})) as { user: Row };
      dispatch({ type: "me", me: me.user });
    },
  };
}
