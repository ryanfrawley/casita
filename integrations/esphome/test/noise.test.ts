import { expect, test } from "bun:test";
import {
  ESPHOME_PROLOGUE,
  encodeNoiseFrame,
  Handshake,
  keypairFromPrivate,
  NoiseFrameReader,
  packMessage,
  unpackMessage,
} from "../src/noise.ts";

const hex = (text: string) => new Uint8Array(Buffer.from(text, "hex"));
const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

// The Noise_NNpsk0_25519_ChaChaPoly_SHA256 vector from the cacophony test suite
// (https://github.com/mcginty/snow/blob/main/tests/vectors/cacophony.txt).
const vector = {
  prologue: "4a6f686e2047616c74",
  psk: "54686973206973206d7920417573747269616e20706572737065637469766521",
  initEphemeral: "893e28b9dc6ca8d611ab664754b8ceb7bac5117349a4439a6b0569da977c464a",
  respEphemeral: "bbdb4cdbd309f1a1f2e1456967fe288cadd6f712d65dc7b7793d5e63da6b375b",
  messages: [
    [
      "4c756477696720766f6e204d69736573",
      "ca35def5ae56cec33dc2036731ab14896bc4c75dbb07a61f879f8e3afa4c794479b962b8aff8485742ac32f905ba45369e2465fb59e138a93d67a0d1266b6a54",
    ],
    [
      "4d757272617920526f746862617264",
      "95ebc60d2b1fa672c1f46a8aa265ef51bfe38e7ccb39ec5be34069f144808843d6062704d5a9c422a8e834423f8c1feada7e8d0d910a1a2cd030fb584221e3",
    ],
    ["462e20412e20486179656b", "e632c3763d7669067383433197a3baddf146e9e70ad4b4e9e59e0f"],
    ["4361726c204d656e676572", "64c6bee32ea91c8474bb4c21d7a700109ad45af77b29764ba5eb1e"],
    [
      "4a65616e2d426170746973746520536179",
      "e2fa0bed0603b62d3ccac2ecabbf3fe33f3e86514909b323361626266cb2471cc8",
    ],
    [
      "457567656e2042f6686d20766f6e2042617765726b",
      "0c01dc9cec1fe4ddd692e8dd32188aa351088dc91183639a53b57aa4692b5ebdef8b8ca111",
    ],
  ] as const,
};

test("matches the published NNpsk0 test vector, handshake and transport", () => {
  const initiator = new Handshake(
    "initiator",
    hex(vector.psk),
    hex(vector.prologue),
    keypairFromPrivate(hex(vector.initEphemeral)),
  );
  const responder = new Handshake(
    "responder",
    hex(vector.psk),
    hex(vector.prologue),
    keypairFromPrivate(hex(vector.respEphemeral)),
  );
  const [m0, m1, ...transport] = vector.messages;

  const first = initiator.writeFirst(hex(m0[0]));
  expect(toHex(first)).toBe(m0[1]);
  expect(toHex(responder.readFirst(first))).toBe(m0[0]);

  const second = responder.writeSecond(hex(m1[0]));
  expect(toHex(second)).toBe(m1[1]);
  expect(toHex(initiator.readSecond(second))).toBe(m1[0]);

  const i = initiator.split();
  const r = responder.split();
  // Transport messages alternate, starting with the initiator.
  transport.forEach(([payload, ciphertext], index) => {
    const [sender, receiver] = index % 2 === 0 ? [i.send, r.receive] : [r.send, i.receive];
    const encrypted = sender.encrypt(hex(payload));
    expect(toHex(encrypted)).toBe(ciphertext);
    expect(toHex(receiver.decrypt(encrypted))).toBe(payload);
  });
});

test("a wrong key fails the handshake with a readable error", () => {
  const initiator = new Handshake("initiator", new Uint8Array(32).fill(1), ESPHOME_PROLOGUE);
  const responder = new Handshake("responder", new Uint8Array(32).fill(2), ESPHOME_PROLOGUE);
  expect(() => responder.readFirst(initiator.writeFirst())).toThrow("wrong encryption key");
  expect(() => new Handshake("initiator", new Uint8Array(16), ESPHOME_PROLOGUE)).toThrow(
    "must be 32 bytes",
  );
});

test("tampered or truncated transport data is rejected", () => {
  const key = new Uint8Array(32).fill(7);
  const initiator = new Handshake("initiator", key, ESPHOME_PROLOGUE);
  const responder = new Handshake("responder", key, ESPHOME_PROLOGUE);
  responder.readFirst(initiator.writeFirst());
  initiator.readSecond(responder.writeSecond());
  const encrypted = initiator.split().send.encrypt(Uint8Array.of(1, 2, 3));
  encrypted[0] = (encrypted[0] ?? 0) ^ 1;
  const receive = responder.split().receive;
  expect(() => receive.decrypt(encrypted)).toThrow("decryption failed");
  expect(() => receive.decrypt(Uint8Array.of(1, 2))).toThrow("too short");
});

test("noise frames survive arbitrary chunking; a plaintext device is called out", () => {
  const frames = [
    encodeNoiseFrame(Uint8Array.of(1, 2, 3)),
    encodeNoiseFrame(new Uint8Array(0)),
    encodeNoiseFrame(new Uint8Array(300).fill(9)),
  ];
  const stream = Buffer.concat(frames);
  for (const size of [1, 2, 5, 1000]) {
    const reader = new NoiseFrameReader();
    const out: Uint8Array[] = [];
    for (let i = 0; i < stream.length; i += size)
      out.push(...reader.push(stream.subarray(i, i + size)));
    expect(out.map((p) => p.length)).toEqual([3, 0, 300]);
  }
  expect(() => new NoiseFrameReader().push(Uint8Array.of(0x00, 0x02, 0x01))).toThrow(
    "does not use encryption",
  );
  expect(() => encodeNoiseFrame(new Uint8Array(70_000))).toThrow("too large");
});

test("the inner message header round-trips type and length", () => {
  const frame = { type: 1025, body: Uint8Array.of(5, 6, 7) };
  expect(toHex(packMessage(frame))).toBe("04010003050607");
  expect(unpackMessage(packMessage(frame))).toEqual(frame);
  expect(() => unpackMessage(Uint8Array.of(1))).toThrow("malformed");
});
