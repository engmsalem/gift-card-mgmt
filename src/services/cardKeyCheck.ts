import { timingSafeEqual } from "node:crypto";
import type { DataSource } from "typeorm";
import type { CardCrypto } from "../gift-cards/card-crypto";

type Purpose = "encryption" | "lookup";

const VARIABLE: Record<Purpose, string> = {
  encryption: "CARD_ENCRYPTION_KEY",
  lookup: "CARD_LOOKUP_KEY",
};
// Which gift_cards column records the key id each purpose was used with
const CARD_KEY_COLUMN: Record<Purpose, string> = {
  encryption: "encryption_key_id",
  lookup: "lookup_key_id",
};

/**
 * Refuses a configured card key that does not match the check value recorded for its id, and a key
 * id that cards already use but that has no recorded check value. The first boot with a key id
 * records its check value (two first boots at once converge: the first writer wins). Only check
 * values are stored, never keys. Messages name the variable and id, never a value.
 */
export async function verifyCardKeys(db: DataSource, cardCrypto: CardCrypto): Promise<void> {
  for (const { purpose, keyId, checkValue } of cardCrypto.keyCheckValues()) {
    const variable = VARIABLE[purpose];
    let stored = await readCheckValue(db, purpose, keyId);

    if (stored === null) {
      // CARD_KEY_COLUMN is a fixed internal map, not input
      const used: unknown[] = await db.query(
        `SELECT 1 FROM gift_cards WHERE ${CARD_KEY_COLUMN[purpose]} = $1 LIMIT 1`,
        [keyId]
      );
      if (used.length > 0) {
        throw new Error(
          `No key check recorded for ${variable} id ${keyId} although cards use it; restore gift_card_key_checks or follow the README key-check reset procedure`
        );
      }
      await db.query(
        `INSERT INTO gift_card_key_checks (purpose, key_id, check_value) VALUES ($1, $2, $3)
         ON CONFLICT (purpose, key_id) DO NOTHING`,
        [purpose, keyId, checkValue]
      );
      // Re-read: if another instance won the race, compare against what it recorded
      stored = await readCheckValue(db, purpose, keyId);
    }

    if (stored === null || stored.length !== checkValue.length || !timingSafeEqual(stored, checkValue)) {
      throw new Error(
        `${variable} does not match the key recorded for key id ${keyId}; use the original key or a new key id`
      );
    }
  }
}

async function readCheckValue(db: DataSource, purpose: Purpose, keyId: number): Promise<Buffer | null> {
  const rows: { check_value: Buffer }[] = await db.query(
    `SELECT check_value FROM gift_card_key_checks WHERE purpose = $1 AND key_id = $2`,
    [purpose, keyId]
  );
  return rows.length === 0 ? null : rows[0].check_value;
}
