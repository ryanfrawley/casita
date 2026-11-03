import { expect, test } from "bun:test";
import { createPublicKey, verify } from "node:crypto";
import { Installation, requestProof } from "../src/signing.ts";
import { decodeFrame, encodeFrame } from "../src/stomp.ts";

// Computed by pylamarzocco's own algorithm (util/_authentication.py) from the same key.
const reference = (await Bun.file(
  new URL("../../../tests/fixtures/lamarzocco/signing.synthetic.json", import.meta.url),
).json()) as Record<string, string>;
const key = new Installation({
  installationId: reference.installationId ?? "",
  privateKey: reference.privateKey ?? "",
});
const NONCE = "9b2f3c1a-0000-4000-8000-0123456789ab";

test("derives the same public key and secret as pylamarzocco", () => {
  expect(key.publicKeyDer.toString("base64")).toBe(reference.publicKey ?? "");
  expect(key.secret.toString("base64")).toBe(reference.secret ?? "");
});

test("registration carries the installation id, the proof, and the public key", () => {
  expect(key.registration()).toEqual({
    headers: {
      "X-App-Installation-Id": reference.installationId ?? "",
      "X-Request-Proof": reference.registrationProof ?? "",
    },
    body: { pk: reference.publicKey ?? "" },
  });
});

test("request headers: the proof matches pylamarzocco and the signature verifies", () => {
  const headers = key.headers(1_762_000_000_000, NONCE.toUpperCase());
  expect(headers["X-Nonce"]).toBe(NONCE);
  expect(headers["X-Timestamp"]).toBe("1762000000000");
  const input = `${reference.installationId}.${NONCE}.1762000000000`;
  expect(requestProof(input, key.secret)).toBe(reference.requestProof ?? "");
  const publicKey = createPublicKey({ key: key.publicKeyDer, format: "der", type: "spki" });
  const signed = Buffer.from(`${input}.${reference.requestProof}`);
  expect(
    verify(
      "sha256",
      signed,
      publicKey,
      Buffer.from(headers["X-Request-Signature"] ?? "", "base64"),
    ),
  ).toBe(true);
});

test("a proof needs a 32-byte secret", () => {
  expect(() => requestProof("x", new Uint8Array(16))).toThrow(/32 bytes/);
});

test("a generated installation round-trips through storage", () => {
  const stored = Installation.generate();
  expect(stored.registered).toBe(false);
  expect(stored.installationId).toMatch(/^[0-9a-f-]{36}$/);
  expect(new Installation(stored).publicKeyDer.length).toBe(91);
});

test("STOMP frames encode and decode", () => {
  const raw = encodeFrame("MESSAGE", { destination: "/ws/sn/X/dashboard", id: "a:b" }, "{}");
  expect(raw).toBe("MESSAGE\ndestination:/ws/sn/X/dashboard\nid:a:b\n\n{}\0");
  expect(decodeFrame(raw)).toEqual({
    command: "MESSAGE",
    headers: { destination: "/ws/sn/X/dashboard", id: "a:b" },
    body: "{}",
  });
  expect(decodeFrame("\n")).toBeUndefined();
  expect(decodeFrame("\r\nCONNECTED\r\nversion:1.2\r\n\r\n\0")).toEqual({
    command: "CONNECTED",
    headers: { version: "1.2" },
    body: "",
  });
});
