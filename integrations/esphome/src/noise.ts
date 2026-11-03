// Noise_NNpsk0_25519_ChaChaPoly_SHA256, as the ESPHome native API uses it, and the
// 0x01 / uint16 length framing that carries it.

import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
// Bun's node:crypto has no ChaCha20-Poly1305, so the AEAD comes from @noble/ciphers.
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { concat, type Frame } from "./proto.ts";

const PROTOCOL = "Noise_NNpsk0_25519_ChaChaPoly_SHA256";
export const ESPHOME_PROLOGUE = new TextEncoder().encode("NoiseAPIInit\0\0");
const EMPTY = new Uint8Array(0);
const TAG_LENGTH = 16;
// DER wrappers that turn a raw 32-byte X25519 key into something node:crypto will import.
const SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

const sha256 = (...parts: Uint8Array[]) => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return new Uint8Array(hash.digest());
};
const hmac = (key: Uint8Array, ...parts: Uint8Array[]) => {
  const mac = createHmac("sha256", key);
  for (const part of parts) mac.update(part);
  return new Uint8Array(mac.digest());
};

/** Noise's HKDF: two or three 32-byte outputs. */
function hkdf(chainingKey: Uint8Array, input: Uint8Array): [Uint8Array, Uint8Array, Uint8Array] {
  const temp = hmac(chainingKey, input);
  const one = hmac(temp, Uint8Array.of(1));
  const two = hmac(temp, one, Uint8Array.of(2));
  const three = hmac(temp, two, Uint8Array.of(3));
  return [one, two, three];
}

function nonceBytes(n: number): Uint8Array {
  const nonce = new Uint8Array(12);
  new DataView(nonce.buffer).setBigUint64(4, BigInt(n), true);
  return nonce;
}

/** One direction's key and counter. */
export class CipherState {
  private n = 0;

  constructor(private readonly key: Uint8Array) {}

  encrypt(plaintext: Uint8Array, ad: Uint8Array = EMPTY): Uint8Array {
    return chacha20poly1305(this.key, nonceBytes(this.n++), ad).encrypt(plaintext);
  }

  /** Throws when the message does not authenticate. */
  decrypt(ciphertext: Uint8Array, ad: Uint8Array = EMPTY): Uint8Array {
    if (ciphertext.length < TAG_LENGTH) throw new Error("encrypted message is too short");
    try {
      return chacha20poly1305(this.key, nonceBytes(this.n++), ad).decrypt(ciphertext);
    } catch {
      throw new Error("decryption failed: wrong encryption key or corrupted data");
    }
  }
}

export interface Keypair {
  publicKey: Uint8Array;
  privateKey: KeyObject;
}

export function generateKeypair(): Keypair {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return {
    publicKey: new Uint8Array(publicKey.export({ type: "spki", format: "der" })).slice(-32),
    privateKey,
  };
}

/** For test vectors, which fix the ephemeral keys. */
export function keypairFromPrivate(raw: Uint8Array): Keypair {
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, raw]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  return { publicKey: new Uint8Array(publicKey).slice(-32), privateKey };
}

function dh(mine: Keypair, theirs: Uint8Array): Uint8Array {
  const publicKey = createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, theirs]),
    format: "der",
    type: "spki",
  });
  return new Uint8Array(diffieHellman({ privateKey: mine.privateKey, publicKey }));
}

/**
 * The NNpsk0 handshake: `-> psk, e` then `<- e, ee`. Each side calls the two message
 * functions for its role in order, then `split`.
 */
export class Handshake {
  private chainingKey: Uint8Array;
  private hash: Uint8Array;
  private cipher?: CipherState;
  private remoteEphemeral?: Uint8Array;

  constructor(
    private readonly role: "initiator" | "responder",
    psk: Uint8Array,
    prologue: Uint8Array,
    private readonly ephemeral: Keypair = generateKeypair(),
  ) {
    if (psk.length !== 32) throw new Error("the encryption key must be 32 bytes");
    this.hash = sha256(new TextEncoder().encode(PROTOCOL)); // the name is longer than 32 bytes
    this.chainingKey = this.hash;
    this.mixHash(prologue);
    // psk0: the pre-shared key is mixed in before the first message's tokens.
    const [chainingKey, tempHash, tempKey] = hkdf(this.chainingKey, psk);
    this.chainingKey = chainingKey;
    this.mixHash(tempHash);
    this.cipher = new CipherState(tempKey);
  }

  /** Initiator: `-> e`. */
  writeFirst(payload: Uint8Array = EMPTY): Uint8Array {
    this.mixEphemeral(this.ephemeral.publicKey);
    return concat(this.ephemeral.publicKey, this.encryptAndHash(payload));
  }

  /** Responder: reads `-> e`, returning the payload. */
  readFirst(message: Uint8Array): Uint8Array {
    this.remoteEphemeral = message.slice(0, 32);
    this.mixEphemeral(this.remoteEphemeral);
    return this.decryptAndHash(message.subarray(32));
  }

  /** Responder: `<- e, ee`. */
  writeSecond(payload: Uint8Array = EMPTY): Uint8Array {
    if (!this.remoteEphemeral) throw new Error("handshake out of order");
    this.mixEphemeral(this.ephemeral.publicKey);
    this.mixKey(dh(this.ephemeral, this.remoteEphemeral));
    return concat(this.ephemeral.publicKey, this.encryptAndHash(payload));
  }

  /** Initiator: reads `<- e, ee`, returning the payload. */
  readSecond(message: Uint8Array): Uint8Array {
    const remote = message.slice(0, 32);
    this.mixEphemeral(remote);
    this.mixKey(dh(this.ephemeral, remote));
    return this.decryptAndHash(message.subarray(32));
  }

  /** The transport ciphers once the handshake is complete. */
  split(): { send: CipherState; receive: CipherState } {
    const [first, second] = hkdf(this.chainingKey, EMPTY);
    const [send, receive] = this.role === "initiator" ? [first, second] : [second, first];
    return { send: new CipherState(send), receive: new CipherState(receive) };
  }

  private mixHash(data: Uint8Array): void {
    this.hash = sha256(this.hash, data);
  }

  private mixKey(input: Uint8Array): void {
    const [chainingKey, tempKey] = hkdf(this.chainingKey, input);
    this.chainingKey = chainingKey;
    this.cipher = new CipherState(tempKey);
  }

  /** In a psk handshake an ephemeral key is both hashed and mixed into the key. */
  private mixEphemeral(publicKey: Uint8Array): void {
    this.mixHash(publicKey);
    this.mixKey(publicKey);
  }

  private encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = this.cipher ? this.cipher.encrypt(plaintext, this.hash) : plaintext;
    this.mixHash(ciphertext);
    return ciphertext;
  }

  private decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const plaintext = this.cipher ? this.cipher.decrypt(ciphertext, this.hash) : ciphertext;
    this.mixHash(ciphertext);
    return plaintext;
  }
}

// ───────── framing: 0x01, uint16 length (big endian), payload ─────────

export function encodeNoiseFrame(payload: Uint8Array): Uint8Array {
  if (payload.length > 0xffff) throw new Error("message too large to encrypt");
  return concat(Uint8Array.of(0x01, payload.length >> 8, payload.length & 0xff), payload);
}

export class NoiseFrameReader {
  private buffer: Uint8Array = new Uint8Array(0);

  push(chunk: Uint8Array): Uint8Array[] {
    this.buffer = concat(this.buffer, chunk);
    const payloads: Uint8Array[] = [];
    while (this.buffer.length >= 3) {
      if (this.buffer[0] !== 0x01)
        throw new Error("the device does not use encryption; remove its encryptionKey");
      const length = ((this.buffer[1] ?? 0) << 8) | (this.buffer[2] ?? 0);
      if (this.buffer.length < 3 + length) break;
      payloads.push(this.buffer.slice(3, 3 + length));
      this.buffer = this.buffer.slice(3 + length);
    }
    return payloads;
  }
}

/** Inside an encrypted frame: uint16 type, uint16 length, body. */
export function packMessage(frame: Frame): Uint8Array {
  const { type, body } = frame;
  return concat(Uint8Array.of(type >> 8, type & 0xff, body.length >> 8, body.length & 0xff), body);
}

export function unpackMessage(plaintext: Uint8Array): Frame {
  if (plaintext.length < 4) throw new Error("malformed encrypted message");
  const type = ((plaintext[0] ?? 0) << 8) | (plaintext[1] ?? 0);
  const length = ((plaintext[2] ?? 0) << 8) | (plaintext[3] ?? 0);
  return { type, body: plaintext.slice(4, 4 + length) };
}
