// Minimal mDNS browsing for `_esphomelib._tcp`: one PTR question, and enough DNS parsing
// to read the PTR, SRV, and A records that come back.

import { createSocket } from "node:dgram";
import type { Logger } from "@casita/core/types";

export const ESPHOME_SERVICE = "_esphomelib._tcp.local";
const MDNS_ADDRESS = "224.0.0.251";
const MDNS_PORT = 5353;
const TYPE_A = 1;
const TYPE_PTR = 12;
const TYPE_SRV = 33;

export interface Found {
  /** The service instance, e.g. "kitchen-plug". */
  name: string;
  host: string;
  port: number;
}

/** A PTR question for `service`, asking for a unicast reply so no multicast membership is needed. */
export function buildQuery(service: string): Uint8Array {
  const name = service
    .split(".")
    .flatMap((label) => [label.length, ...new TextEncoder().encode(label)]);
  return Uint8Array.from([
    0,
    0, // id
    0,
    0, // flags: standard query
    0,
    1,
    0,
    0,
    0,
    0,
    0,
    0, // one question
    ...name,
    0,
    0,
    TYPE_PTR,
    0x80,
    0x01, // class IN, unicast response
  ]);
}

/** Reads a possibly compressed name at `offset`. */
function readName(packet: Uint8Array, offset: number): { name: string; next: number } {
  const labels: string[] = [];
  let position = offset;
  let next: number | undefined;
  for (let hops = 0; hops < 64; hops++) {
    const length = packet[position];
    if (length === undefined) throw new Error("truncated name");
    if (length === 0) return { name: labels.join("."), next: next ?? position + 1 };
    if ((length & 0xc0) === 0xc0) {
      next ??= position + 2;
      position = ((length & 0x3f) << 8) | (packet[position + 1] ?? 0);
      continue;
    }
    labels.push(new TextDecoder().decode(packet.subarray(position + 1, position + 1 + length)));
    position += 1 + length;
  }
  throw new Error("name compression loop");
}

/** The instances of `service` a response describes. Malformed packets yield nothing. */
export function parseResponse(packet: Uint8Array, service: string): Found[] {
  try {
    const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
    const questions = view.getUint16(4);
    const records = view.getUint16(6) + view.getUint16(8) + view.getUint16(10);
    let offset = 12;
    for (let i = 0; i < questions; i++) offset = readName(packet, offset).next + 4;

    const instances: string[] = [];
    const services = new Map<string, { target: string; port: number }>();
    const addresses = new Map<string, string>();
    for (let i = 0; i < records; i++) {
      const { name, next } = readName(packet, offset);
      const type = view.getUint16(next);
      const length = view.getUint16(next + 8);
      const data = next + 10;
      if (type === TYPE_PTR && name.toLowerCase() === service) {
        instances.push(readName(packet, data).name);
      } else if (type === TYPE_SRV) {
        services.set(name, {
          port: view.getUint16(data + 4),
          target: readName(packet, data + 6).name,
        });
      } else if (type === TYPE_A && length === 4) {
        addresses.set(name, [...packet.subarray(data, data + 4)].join("."));
      }
      offset = data + length;
    }
    return instances.flatMap((instance) => {
      const srv = services.get(instance);
      if (!srv) return [];
      const name = instance.slice(0, instance.toLowerCase().lastIndexOf(`.${service}`));
      return [{ name, host: addresses.get(srv.target) ?? srv.target, port: srv.port }];
    });
  } catch {
    return [];
  }
}

export type Browse = (signal: AbortSignal, onFound: (device: Found) => void, log: Logger) => void;

/** Asks the local network for ESPHome devices now and every minute until `signal` aborts. */
export const browse: Browse = (signal, onFound, log) => {
  const socket = createSocket({ type: "udp4", reuseAddr: true });
  const query = buildQuery(ESPHOME_SERVICE);
  const ask = () => {
    socket.send(query, MDNS_PORT, MDNS_ADDRESS, (err) => {
      if (err) log.debug("mDNS query failed", { error: err.message });
    });
  };
  socket.on("message", (packet) => {
    for (const device of parseResponse(packet, ESPHOME_SERVICE)) onFound(device);
  });
  socket.on("error", (err) => log.warn("mDNS discovery failed", { error: err.message }));
  socket.bind(0, () => {
    ask();
    const timer = setInterval(ask, 60_000);
    signal.addEventListener(
      "abort",
      () => {
        clearInterval(timer);
        socket.close();
      },
      { once: true },
    );
  });
};
