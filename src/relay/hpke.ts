import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createPrivateKey,
  decapsulate,
  encapsulate,
} from "node:crypto";
import { publicKeyObject } from "./pairing-checks.ts";

const suite = Buffer.concat([
  Buffer.from("HPKE"),
  Buffer.from([0x00, 0x10, 0x00, 0x01, 0x00, 0x02]),
]);
const version = Buffer.from("HPKE-v1");
const encapsulatedBytes = 65;
const tagBytes = 16;

export interface HpkeSchedule {
  readonly key: Buffer;
  readonly baseNonce: Buffer;
}

export interface SealedMessage {
  readonly info: Buffer;
  readonly aad: Buffer;
}

function labeledExtract(
  salt: Buffer,
  input: { readonly label: string; readonly material: Buffer },
): Buffer {
  return createHmac("sha256", salt.length === 0 ? Buffer.alloc(32) : salt)
    .update(
      Buffer.concat([version, suite, Buffer.from(input.label), input.material]),
    )
    .digest();
}

function labeledExpand(
  secret: Buffer,
  input: {
    readonly label: string;
    readonly context: Buffer;
    readonly length: number;
  },
): Buffer {
  const length = Buffer.alloc(2);
  length.writeUInt16BE(input.length);
  return createHmac("sha256", secret)
    .update(
      Buffer.concat([
        length,
        version,
        suite,
        Buffer.from(input.label),
        input.context,
        Buffer.from([1]),
      ]),
    )
    .digest()
    .subarray(0, input.length);
}

export function keySchedule(sharedSecret: Buffer, info: Buffer): HpkeSchedule {
  const empty = Buffer.alloc(0);
  const context = Buffer.concat([
    Buffer.from([0]),
    labeledExtract(empty, { label: "psk_id_hash", material: empty }),
    labeledExtract(empty, { label: "info_hash", material: info }),
  ]);
  const secret = labeledExtract(sharedSecret, {
    label: "secret",
    material: empty,
  });
  return {
    key: labeledExpand(secret, { label: "key", context, length: 32 }),
    baseNonce: labeledExpand(secret, {
      label: "base_nonce",
      context,
      length: 12,
    }),
  };
}

function nonce(schedule: HpkeSchedule, sequence: number): Buffer {
  const value = Buffer.alloc(12);
  value.writeUIntBE(sequence, 6, 6);
  for (const [index, byte] of schedule.baseNonce.entries())
    value.writeUInt8(byte ^ value.readUInt8(index), index);
  return value;
}

export function sealAt(
  schedule: HpkeSchedule,
  message: {
    readonly sequence: number;
    readonly aad: Buffer;
    readonly plaintext: Buffer;
  },
): Buffer {
  const cipher = createCipheriv(
    "aes-256-gcm",
    schedule.key,
    nonce(schedule, message.sequence),
  );
  cipher.setAAD(message.aad);
  return Buffer.concat([
    cipher.update(message.plaintext),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
}

export function openAt(
  schedule: HpkeSchedule,
  message: {
    readonly sequence: number;
    readonly aad: Buffer;
    readonly ciphertext: Buffer;
  },
): Buffer {
  const { ciphertext } = message;
  if (ciphertext.length < tagBytes)
    throw new Error("hpke-open-failed: The sealed text is too short.");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    schedule.key,
    nonce(schedule, message.sequence),
  );
  decipher.setAAD(message.aad);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - tagBytes));
  return Buffer.concat([
    decipher.update(ciphertext.subarray(0, ciphertext.length - tagBytes)),
    decipher.final(),
  ]);
}

export function sealTo(
  publicKey: string,
  message: SealedMessage & { readonly plaintext: Buffer },
): Buffer {
  const recipient = publicKeyObject(publicKey);
  if (recipient === undefined)
    throw new Error("hpke-seal-failed: The public key is not a P-256 point.");
  const { sharedKey, ciphertext } = encapsulate(recipient);
  const schedule = keySchedule(sharedKey, message.info);
  return Buffer.concat([
    ciphertext,
    sealAt(schedule, {
      sequence: 0,
      aad: message.aad,
      plaintext: message.plaintext,
    }),
  ]);
}

export function openFrom(
  privateKey: string,
  message: SealedMessage & { readonly sealed: Buffer },
): Buffer {
  const { sealed } = message;
  if (sealed.length < encapsulatedBytes + tagBytes)
    throw new Error("hpke-open-failed: The sealed text is too short.");
  const key = createPrivateKey({
    key: Buffer.from(privateKey, "base64url"),
    format: "der",
    type: "pkcs8",
  });
  const sharedSecret = decapsulate(key, sealed.subarray(0, encapsulatedBytes));
  return openAt(keySchedule(sharedSecret, message.info), {
    sequence: 0,
    aad: message.aad,
    ciphertext: sealed.subarray(encapsulatedBytes),
  });
}
