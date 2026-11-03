import { expect, test } from "bun:test";
import { buildQuery, ESPHOME_SERVICE, parseResponse } from "../src/mdns.ts";
import { decodeMessage, encodeMessage, encodePlainFrame, PlainFrameReader } from "../src/proto.ts";

// ───────── plaintext framing ─────────

test("a frame is 0x00, varint length, varint type, body", () => {
  expect([...encodePlainFrame({ type: 7, body: new Uint8Array(0) })]).toEqual([0, 0, 7]);
  const hello = encodePlainFrame(
    encodeMessage("HelloRequest", { clientInfo: "casita", apiVersionMajor: 1 }),
  );
  expect([...hello]).toEqual([0, 10, 1, 0x0a, 6, 0x63, 0x61, 0x73, 0x69, 0x74, 0x61, 0x10, 1]);
});

test("frames survive arbitrary chunking, including multi-byte varints", () => {
  const ping = encodeMessage("PingRequest");
  const frames = [
    ping,
    encodeMessage("DeviceInfoResponse", { name: "x".repeat(200), macAddress: "AA:BB" }),
    encodeMessage("ButtonCommandRequest", { key: 4_000_000_000 }), // type 62, fixed32 key
  ];
  const stream = Buffer.concat(frames.map(encodePlainFrame));
  for (const size of [1, 3, 64, 10_000]) {
    const reader = new PlainFrameReader();
    const out = [];
    for (let i = 0; i < stream.length; i += size)
      out.push(...reader.push(stream.subarray(i, i + size)));
    expect(out.map((f) => f.type)).toEqual([7, 10, 62]);
    expect(decodeMessage(out[1] ?? ping)).toMatchObject({
      name: "DeviceInfoResponse",
      message: { macAddress: "AA:BB" },
    });
    expect(decodeMessage(out[2] ?? ping)).toMatchObject({ message: { key: 4_000_000_000 } });
  }
});

test("bad preambles are named; unknown message types are skipped", () => {
  expect(() => new PlainFrameReader().push(Uint8Array.of(0x01, 0, 0))).toThrow(
    "requires encryption",
  );
  expect(() => new PlainFrameReader().push(Uint8Array.of(0x42))).toThrow("bad preamble");
  expect(() =>
    new PlainFrameReader().push(Uint8Array.of(0, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80)),
  ).toThrow("varint");
  expect(decodeMessage({ type: 9999, body: new Uint8Array(0) })).toBeUndefined();
});

test("decoded messages carry defaults for absent fields", () => {
  const decoded = decodeMessage(encodeMessage("SensorStateResponse", { key: 5, state: 1.5 }));
  expect(decoded).toEqual({
    name: "SensorStateResponse",
    message: { key: 5, state: 1.5, missingState: false, deviceId: 0 },
  });
});

// ───────── mDNS ─────────

const name = (text: string) => [
  ...text.split(".").flatMap((l) => [l.length, ...new TextEncoder().encode(l)]),
  0,
];
const u16 = (n: number) => [n >> 8, n & 0xff];
const record = (owner: number[], type: number, data: number[]) => [
  ...owner,
  ...u16(type),
  ...u16(1),
  0,
  0,
  0,
  120,
  ...u16(data.length),
  ...data,
];

test("the query asks for the service's PTR records with a unicast reply", () => {
  const query = buildQuery(ESPHOME_SERVICE);
  expect([...query.subarray(0, 12)]).toEqual([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
  expect([...query.subarray(12)]).toEqual([...name(ESPHOME_SERVICE), 0, 12, 0x80, 1]);
});

test("a response's PTR, SRV, and A records become a device, with compressed names", () => {
  const header = [0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 2];
  const service = name(ESPHOME_SERVICE); // at offset 12
  const pointerToService = [0xc0, 12];
  const instance = [12, ...new TextEncoder().encode("kitchen-plug"), ...pointerToService];
  const ptr = record(service, 12, instance);
  const instanceOffset = header.length + ptr.length - instance.length;
  const host = name("kitchen-plug.local");
  const srv = record([0xc0, instanceOffset], 33, [...u16(0), ...u16(0), ...u16(6053), ...host]);
  const a = record(host, 1, [192, 168, 1, 40]);
  const packet = Uint8Array.from([...header, ...ptr, ...srv, ...a]);
  expect(parseResponse(packet, ESPHOME_SERVICE)).toEqual([
    { name: "kitchen-plug", host: "192.168.1.40", port: 6053 },
  ]);

  // Without an address record the host name is used.
  const noAddress = Uint8Array.from([0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 1, ...ptr, ...srv]);
  expect(parseResponse(noAddress, ESPHOME_SERVICE)).toEqual([
    { name: "kitchen-plug", host: "kitchen-plug.local", port: 6053 },
  ]);
});

test("other services, truncated packets, and compression loops yield nothing", () => {
  const other = Uint8Array.from([
    0,
    0,
    0x84,
    0,
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    0,
    ...record(name("_http._tcp.local"), 12, name("x._http._tcp.local")),
  ]);
  expect(parseResponse(other, ESPHOME_SERVICE)).toEqual([]);
  expect(parseResponse(Uint8Array.of(1, 2, 3), ESPHOME_SERVICE)).toEqual([]);
  const loop = Uint8Array.from([
    0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0xc0, 12, 0, 12, 0, 1, 0, 0, 0, 0, 0, 0,
  ]);
  expect(parseResponse(loop, ESPHOME_SERVICE)).toEqual([]);
});
