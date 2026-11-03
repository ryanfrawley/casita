// Message encoding (protobufjs over the generated descriptor) and plaintext framing.

import protobuf from "protobufjs/light";
import { DESCRIPTOR, MESSAGE_IDS, type Messages } from "./api.gen.ts";

export type MessageName = keyof Messages;
/** A decoded message tagged with its name, so a switch on `name` narrows `message`. */
export type AnyMessage = { [K in MessageName]: { name: K; message: Messages[K] } }[MessageName];

export interface Frame {
  type: number;
  body: Uint8Array;
}

const root = protobuf.Root.fromJSON(DESCRIPTOR);
const NAME_BY_ID = new Map<number, MessageName>(
  (Object.entries(MESSAGE_IDS) as [MessageName, number][]).map(([name, id]) => [id, name]),
);

export function encodeMessage<K extends MessageName>(
  name: K,
  value: Partial<Messages[K]> = {},
): Frame {
  const type = root.lookupType(name);
  return { type: MESSAGE_IDS[name], body: type.encode(type.create(value)).finish() };
}

/** Undefined for message types this client does not speak; they are safe to ignore. */
export function decodeMessage(frame: Frame): AnyMessage | undefined {
  const name = NAME_BY_ID.get(frame.type);
  if (!name) return undefined;
  const type = root.lookupType(name);
  const message = type.toObject(type.decode(frame.body), {
    defaults: true,
    arrays: true,
    longs: Number,
  });
  return { name, message } as AnyMessage;
}

// ───────── plaintext framing: 0x00, varint length, varint type, body ─────────

function writeVarint(value: number, out: number[]): void {
  let v = value >>> 0;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
}

/** Reads a varint at `offset`; undefined if the buffer ends first. */
function readVarint(
  buffer: Uint8Array,
  offset: number,
): { value: number; next: number } | undefined {
  let value = 0;
  for (let shift = 0, i = offset; i < buffer.length && shift <= 28; shift += 7, i++) {
    const byte = buffer[i] ?? 0;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, next: i + 1 };
  }
  if (buffer.length - offset >= 5) throw new Error("malformed frame: varint too long");
  return undefined;
}

export function encodePlainFrame(frame: Frame): Uint8Array {
  const header = [0x00];
  writeVarint(frame.body.length, header);
  writeVarint(frame.type, header);
  const out = new Uint8Array(header.length + frame.body.length);
  out.set(header);
  out.set(frame.body, header.length);
  return out;
}

/** Accumulates stream chunks and yields each complete frame. */
export class PlainFrameReader {
  private buffer: Uint8Array = new Uint8Array(0);

  push(chunk: Uint8Array): Frame[] {
    this.buffer = concat(this.buffer, chunk);
    const frames: Frame[] = [];
    for (;;) {
      if (this.buffer.length === 0) break;
      if (this.buffer[0] === 0x01)
        throw new Error("the device requires encryption; set its encryptionKey");
      if (this.buffer[0] !== 0x00) throw new Error("malformed frame: bad preamble");
      const length = readVarint(this.buffer, 1);
      const type = length && readVarint(this.buffer, length.next);
      if (!length || !type || this.buffer.length < type.next + length.value) break;
      frames.push({
        type: type.value,
        body: this.buffer.slice(type.next, type.next + length.value),
      });
      this.buffer = this.buffer.slice(type.next + length.value);
    }
    return frames;
  }
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
