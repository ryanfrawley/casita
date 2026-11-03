// La Marzocco's request signing, as its app does it (worked out by pylamarzocco). Each
// installation has a P-256 key pair registered once with the cloud; every request then
// carries a nonce, a timestamp, a keyed "proof" of the two, and an ECDSA signature over it all.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomUUID,
  sign,
} from "node:crypto";

const sha256 = (data: string | Uint8Array): Buffer => createHash("sha256").update(data).digest();
const b64 = (data: Uint8Array): string => Buffer.from(data).toString("base64");

/** What is kept in storage: enough to rebuild the key, and whether the cloud knows it. */
export interface StoredInstallation {
  installationId: string;
  /** PKCS#8 DER, base64. */
  privateKey: string;
  registered: boolean;
}

export class Installation {
  readonly id: string;
  private readonly key: KeyObject;
  /** SubjectPublicKeyInfo DER of the public half. */
  readonly publicKeyDer: Buffer;
  /** 32 bytes the proofs are keyed with, derived from the id and the public key. */
  readonly secret: Buffer;

  constructor(stored: Pick<StoredInstallation, "installationId" | "privateKey">) {
    this.id = stored.installationId;
    this.key = createPrivateKey({
      key: Buffer.from(stored.privateKey, "base64"),
      format: "der",
      type: "pkcs8",
    });
    this.publicKeyDer = createPublicKey(this.key).export({ format: "der", type: "spki" });
    this.secret = deriveSecret(this.id, this.publicKeyDer);
  }

  /** A fresh id and key pair; registered with the cloud before first use. */
  static generate(): StoredInstallation {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    return {
      installationId: randomUUID(),
      privateKey: b64(privateKey.export({ format: "der", type: "pkcs8" })),
      registered: false,
    };
  }

  /** The body and headers of `POST /auth/init`, which registers this installation. */
  registration(): { headers: Record<string, string>; body: { pk: string } } {
    const base = `${this.id}.${b64(sha256(this.publicKeyDer))}`;
    return {
      headers: {
        "X-App-Installation-Id": this.id,
        "X-Request-Proof": requestProof(base, this.secret),
      },
      body: { pk: b64(this.publicKeyDer) },
    };
  }

  /** The headers every other request carries. */
  headers(now = Date.now(), nonce: string = randomUUID()): Record<string, string> {
    const timestamp = String(Math.floor(now));
    const input = `${this.id}.${nonce.toLowerCase()}.${timestamp}`;
    const proof = requestProof(input, this.secret);
    // DER-encoded, as the cloud expects (node's default for EC keys).
    const signature = sign("sha256", Buffer.from(`${input}.${proof}`), this.key);
    return {
      "X-App-Installation-Id": this.id,
      "X-Timestamp": timestamp,
      "X-Nonce": nonce.toLowerCase(),
      "X-Request-Signature": b64(signature),
    };
  }
}

export function deriveSecret(installationId: string, publicKeyDer: Uint8Array): Buffer {
  return sha256(`${installationId}.${b64(publicKeyDer)}.${b64(sha256(installationId))}`);
}

/** The app's keyed digest: each input byte is folded into a copy of the secret, then hashed. */
export function requestProof(input: string, secret: Uint8Array): string {
  if (secret.length !== 32) throw new Error("the secret must be 32 bytes");
  const work = Uint8Array.from(secret);
  for (const byte of new TextEncoder().encode(input)) {
    const index = byte % 32;
    const shift = (work[(index + 1) % 32] ?? 0) & 7;
    const mixed = byte ^ (work[index] ?? 0);
    work[index] = ((mixed << shift) | (mixed >> (8 - shift))) & 0xff;
  }
  return b64(sha256(work));
}
