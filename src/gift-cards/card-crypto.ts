import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes as cryptoRandomBytes,
  timingSafeEqual,
} from "node:crypto";

export interface CardKey {
  id: number; // 1..32767
  key: Buffer; // 32 bytes
}
export type SecretPurpose = "number" | "pin";

/** Messages are fixed strings: they never carry keys, plaintext, ciphertext or row data. */
export class CardCryptoError extends Error {
  /** The card whose secret failed to decrypt, when known: the only identifier that is safe to log. */
  constructor(
    message: string,
    readonly cardId?: string
  ) {
    super(message);
    this.name = "CardCryptoError";
  }
}

const BLOB_VERSION = 0x01;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const MAX_KEY_ID = 32767;
const KCV_LENGTH = 16;

function assertKey(candidate: CardKey): void {
  if (!Buffer.isBuffer(candidate.key) || candidate.key.length !== KEY_LENGTH) {
    throw new CardCryptoError("Card keys must be 32 bytes");
  }
  if (!Number.isInteger(candidate.id) || candidate.id < 1 || candidate.id > MAX_KEY_ID) {
    throw new CardCryptoError("Card key ids must be integers from 1 to 32767");
  }
}

export class CardCrypto {
  readonly encryptionKeyId: number;
  readonly lookupKeyId: number;
  // Keyed by id so that rotation can add retired keys for decryption
  private readonly encryptionKeys = new Map<number, Buffer>();
  private readonly lookupKey: Buffer;

  constructor(
    keys: { encryption: CardKey; lookup: CardKey },
    private readonly randomBytes: (n: number) => Buffer = cryptoRandomBytes
  ) {
    assertKey(keys.encryption);
    assertKey(keys.lookup);
    if (timingSafeEqual(keys.encryption.key, keys.lookup.key)) {
      throw new CardCryptoError("The encryption and lookup keys must differ");
    }
    this.encryptionKeyId = keys.encryption.id;
    this.lookupKeyId = keys.lookup.id;
    // Copies, so the caller zeroing or reusing its buffers cannot change ours
    this.encryptionKeys.set(keys.encryption.id, Buffer.from(keys.encryption.key));
    this.lookupKey = Buffer.from(keys.lookup.key);
  }

  /** Deterministic keyed hash of the normalized card number; backs the unique lookup index. */
  lookupHash(normalizedNumber: string): Buffer {
    return createHmac("sha256", this.lookupKey)
      .update("gift-card-number:v1:" + normalizedNumber, "utf8")
      .digest();
  }

  /** AES-256-GCM. Blob: 0x01 || IV(12) || tag(16) || ciphertext. */
  encrypt(purpose: SecretPurpose, ids: { tenantId: string; cardId: string }, plaintext: string): Buffer {
    const key = this.encryptionKeys.get(this.encryptionKeyId);
    if (key === undefined) throw new CardCryptoError("Unknown card key id");
    const iv = this.randomBytes(IV_LENGTH);
    if (iv.length !== IV_LENGTH) throw new CardCryptoError("Invalid IV length");
    const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_LENGTH });
    cipher.setAAD(aad(purpose, ids, this.encryptionKeyId));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return Buffer.concat([Buffer.of(BLOB_VERSION), iv, cipher.getAuthTag(), ciphertext]);
  }

  decrypt(
    purpose: SecretPurpose,
    ids: { tenantId: string; cardId: string },
    keyId: number,
    blob: Buffer
  ): string {
    const key = this.encryptionKeys.get(keyId);
    if (key === undefined) throw new CardCryptoError("Unknown card key id", ids.cardId);
    if (blob.length < 1 + IV_LENGTH + TAG_LENGTH || blob[0] !== BLOB_VERSION) {
      throw new CardCryptoError("Invalid ciphertext", ids.cardId);
    }
    const iv = blob.subarray(1, 1 + IV_LENGTH);
    const tag = blob.subarray(1 + IV_LENGTH, 1 + IV_LENGTH + TAG_LENGTH);
    const ciphertext = blob.subarray(1 + IV_LENGTH + TAG_LENGTH);
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_LENGTH });
      decipher.setAAD(aad(purpose, ids, keyId));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch {
      // Deliberately not chained: the underlying error must not carry anything about the data
      throw new CardCryptoError("Decryption failed", ids.cardId);
    }
  }

  /** Non-secret check values, stored per key id to detect a wrong key at startup. */
  keyCheckValues(): { purpose: "encryption" | "lookup"; keyId: number; checkValue: Buffer }[] {
    const encryptionKey = this.encryptionKeys.get(this.encryptionKeyId);
    if (encryptionKey === undefined) throw new CardCryptoError("Unknown card key id");
    return [
      { purpose: "encryption", keyId: this.encryptionKeyId, checkValue: keyCheckValue("encryption", encryptionKey, this.encryptionKeyId) },
      { purpose: "lookup", keyId: this.lookupKeyId, checkValue: keyCheckValue("lookup", this.lookupKey, this.lookupKeyId) },
    ];
  }
}

function aad(purpose: SecretPurpose, ids: { tenantId: string; cardId: string }, keyId: number): Buffer {
  return Buffer.from(`gift-card:v1:${purpose}:${ids.tenantId}:${ids.cardId}:${keyId}`, "utf8");
}

function keyCheckValue(purpose: "encryption" | "lookup", key: Buffer, keyId: number): Buffer {
  // hkdfSync returns an ArrayBuffer. The subkey keeps the check value from being HMAC(rawKey, label).
  const subkey = Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), "gift-card-key-check:v1:" + purpose, KEY_LENGTH));
  return createHmac("sha256", subkey).update("kcv:" + keyId, "utf8").digest().subarray(0, KCV_LENGTH);
}
