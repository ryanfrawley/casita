// One TCP connection to an ESPHome device: plaintext frames, or Noise when a key is set.

import type { Messages } from "./api.gen.ts";
import {
  type CipherState,
  ESPHOME_PROLOGUE,
  encodeNoiseFrame,
  Handshake,
  NoiseFrameReader,
  packMessage,
  unpackMessage,
} from "./noise.ts";
import {
  type AnyMessage,
  concat,
  decodeMessage,
  encodeMessage,
  encodePlainFrame,
  type Frame,
  type MessageName,
  PlainFrameReader,
} from "./proto.ts";

export interface ConnectOptions {
  host: string;
  port: number;
  /** Base64 of the 32-byte key from the device's `api: encryption: key:`. */
  encryptionKey?: string;
  timeoutMs?: number;
}

export interface ConnectionHandlers {
  onMessage(message: AnyMessage): void;
  /** The device or the network ended the connection; not called after a local close(). */
  onClose(error: Error): void;
}

export interface Connection {
  send<K extends MessageName>(name: K, value?: Partial<Messages[K]>): void;
  close(): void;
}

function decodeKey(encoded: string): Uint8Array {
  const key = new Uint8Array(Buffer.from(encoded, "base64"));
  if (key.length !== 32) throw new Error("encryptionKey must be the base64 of 32 bytes");
  return key;
}

/** Resolves once the connection can carry messages (after the Noise handshake, if any). */
export function openConnection(
  opts: ConnectOptions,
  handlers: ConnectionHandlers,
): Promise<Connection> {
  return new Promise((resolve, reject) => {
    const where = `${opts.host}:${opts.port}`;
    const handshake = opts.encryptionKey
      ? new Handshake("initiator", decodeKey(opts.encryptionKey), ESPHOME_PROLOGUE)
      : undefined;
    const plainReader = new PlainFrameReader();
    const noiseReader = new NoiseFrameReader();
    let stage: "hello" | "handshake" | "ready" = handshake ? "hello" : "ready";
    let ciphers: { send: CipherState; receive: CipherState } | undefined;
    let socket: { write(data: Uint8Array): number; end(): void } | undefined;
    let unsent: Uint8Array = new Uint8Array(0);
    let settled = false;
    let closed = false;

    const fail = (error: Error) => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      socket?.end();
      if (settled) handlers.onClose(error);
      else reject(error);
      settled = true;
    };
    const timer = setTimeout(
      () => fail(new Error(`timed out connecting to ${where}`)),
      opts.timeoutMs ?? 10_000,
    );

    const flush = () => {
      if (!socket || unsent.length === 0) return;
      const written = socket.write(unsent);
      unsent = unsent.slice(Math.max(written, 0));
    };
    const write = (bytes: Uint8Array) => {
      unsent = concat(unsent, bytes);
      flush();
    };

    const connection: Connection = {
      send(name, value) {
        if (closed) return;
        const frame = encodeMessage(name, value);
        write(
          ciphers
            ? encodeNoiseFrame(ciphers.send.encrypt(packMessage(frame)))
            : encodePlainFrame(frame),
        );
      },
      close() {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        socket?.end();
      },
    };
    const ready = () => {
      stage = "ready";
      settled = true;
      clearTimeout(timer);
      resolve(connection);
    };
    const dispatch = (frame: Frame) => {
      const message = decodeMessage(frame);
      if (message) handlers.onMessage(message);
    };

    const receive = (chunk: Uint8Array) => {
      if (!handshake) {
        for (const frame of plainReader.push(chunk)) dispatch(frame);
        return;
      }
      for (const payload of noiseReader.push(chunk)) {
        if (stage === "hello") {
          // Server hello: the chosen protocol (0x01 is Noise), then the device's name.
          if (payload[0] !== 0x01)
            throw new Error("the device chose an unknown encryption protocol");
          stage = "handshake";
        } else if (stage === "handshake") {
          if (payload[0] !== 0x00) {
            const reason = new TextDecoder().decode(payload.subarray(1));
            throw new Error(
              /mac failure/i.test(reason)
                ? "the encryption key is wrong"
                : `handshake rejected: ${reason}`,
            );
          }
          handshake.readSecond(payload.subarray(1));
          ciphers = handshake.split();
          ready();
        } else if (ciphers) {
          dispatch(unpackMessage(ciphers.receive.decrypt(payload)));
        }
      }
    };

    Bun.connect({
      hostname: opts.host,
      port: opts.port,
      socket: {
        open(s) {
          socket = s;
          if (!handshake) return ready();
          write(encodeNoiseFrame(new Uint8Array(0))); // client hello
          write(encodeNoiseFrame(concat(Uint8Array.of(0x00), handshake.writeFirst())));
        },
        data(_s, chunk) {
          try {
            receive(chunk);
          } catch (err) {
            fail(err instanceof Error ? err : new Error(String(err)));
          }
        },
        drain: flush,
        close() {
          // A plaintext device hangs up on the first encrypted frame without a word.
          const during = handshake && stage !== "ready";
          fail(
            new Error(
              during
                ? `${opts.host} closed the connection during the encryption handshake; it may not use encryption`
                : `${where} closed the connection`,
            ),
          );
        },
        error(_s, err) {
          fail(err);
        },
        connectError(_s, err) {
          fail(new Error(`cannot connect to ${where}: ${err.message}`));
        },
      },
    }).catch((err: unknown) => {
      fail(
        new Error(
          `cannot connect to ${where}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    });
  });
}
