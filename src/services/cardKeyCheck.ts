import { timingSafeEqual } from "node:crypto";
import type { DataSource } from "typeorm";
import type { CardCrypto } from "../gift-cards/card-crypto";

type Purpose = "encryption" | "lookup";

const VARIABLE: Record<Purpose, string> = {
  encryption: "CARD_ENCRYPTION_KEY",
  lookup: "CARD_LOOKUP_KEY",
};
const VARIABLE_ID: Record<Purpose, string> = {
  encryption: "CARD_ENCRYPTION_KEY_ID",
  lookup: "CARD_LOOKUP_KEY_ID",
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
 *
 * It also refuses a loaded key id when any card was written under a different id: those cards could
 * not be decrypted or looked up. Key rotation is not built, so the only remedy is the original key
 * and id.
 */
export async function verifyCardKeys(db: DataSource, cardCrypto: CardCrypto): Promise<void> {
  for (const { purpose, keyId, checkValue } of cardCrypto.keyCheckValues()) {
    const variable = VARIABLE[purpose];
    await refuseOrphanedKeyIds(db, purpose, keyId);
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
        `${variable} does not match the key recorded for key id ${keyId}; use the original key for this id (a new key id is only safe while no cards exist; key rotation is not built yet)`
      );
    }
  }
}

async function refuseOrphanedKeyIds(db: DataSource, purpose: Purpose, loadedId: number): Promise<void> {
  const column = CARD_KEY_COLUMN[purpose];
  // CARD_KEY_COLUMN is a fixed internal map, not input; the list is capped so the message stays short
  const rows: Record<string, number>[] = await db.query(
    `SELECT DISTINCT ${column} AS key_id FROM gift_cards WHERE ${column} <> $1 ORDER BY 1 LIMIT 10`,
    [loadedId]
  );
  if (rows.length > 0) {
    const ids = rows.map((r) => r.key_id).join(", ");
    throw new Error(
      `Cards exist with ${purpose} key id ${ids} but ${VARIABLE_ID[purpose]} is ${loadedId}; restore the original ${VARIABLE[purpose]} and ${VARIABLE_ID[purpose]} (key rotation is not built yet)`
    );
  }
}

async function readCheckValue(db: DataSource, purpose: Purpose, keyId: number): Promise<Buffer | null> {
  const rows: { check_value: Buffer }[] = await db.query(
    `SELECT check_value FROM gift_card_key_checks WHERE purpose = $1 AND key_id = $2`,
    [purpose, keyId]
  );
  return rows.length === 0 ? null : rows[0].check_value;
}
