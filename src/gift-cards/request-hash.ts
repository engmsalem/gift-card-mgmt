import { createHash } from "node:crypto";

// sha256(utf8(JSON.stringify(["v1", ...fields]))). A JSON array cannot be made to collide by
// moving separator characters between fields. Absent fields are null; amounts are integers.
function fingerprint(...fields: (string | number | null)[]): Buffer {
  return createHash("sha256").update(JSON.stringify(["v1", ...fields]), "utf8").digest();
}

export function requestHashRedeem(input: {
  hmac: Buffer;
  amount: number;
  externalReference?: string | null;
}): Buffer {
  return fingerprint("redeem", input.hmac.toString("hex"), input.amount, input.externalReference ?? null);
}

export function requestHashIssue(input: {
  actorUserId: string;
  programId: string;
  amount: number;
  recipientEmail: string; // already normalized by the caller
  recipientName: string;
  senderName: string;
  message?: string | null;
  sendAt?: string | null;
}): Buffer {
  return fingerprint(
    "issue",
    input.actorUserId,
    input.programId,
    input.amount,
    input.recipientEmail,
    input.recipientName,
    input.senderName,
    input.message ?? null,
    input.sendAt === undefined || input.sendAt === null ? null : new Date(input.sendAt).toISOString()
  );
}

export function requestHashRefund(input: { transactionId: string; amount: number }): Buffer {
  return fingerprint("refund", input.transactionId, input.amount);
}
