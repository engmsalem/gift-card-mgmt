import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { requestHashIssue, requestHashRedeem, requestHashRefund } from "../../src/gift-cards/request-hash";

const hmac = Buffer.alloc(32, 7);
const issue = {
  actorUserId: "u1",
  programId: "p1",
  amount: 5000,
  recipientEmail: "a@example.com",
  recipientName: "Ann",
  senderName: "Bob",
  message: "hi",
  sendAt: "2030-01-01T00:00:00Z",
};

test("stable", () => {
  assert.deepEqual(requestHashIssue(issue), requestHashIssue({ ...issue }));
  assert.equal(requestHashIssue(issue).length, 32);
  assert.deepEqual(
    requestHashRefund({ transactionId: "t1", amount: 5 }),
    createHash("sha256").update('["v1","refund","t1",5]').digest()
  );
  assert.deepEqual(
    requestHashRedeem({ hmac, amount: 3, externalReference: "ref" }),
    createHash("sha256").update(JSON.stringify(["v1", "redeem", hmac.toString("hex"), 3, "ref"])).digest()
  );
  // sendAt is canonicalized to an ISO instant
  assert.deepEqual(
    requestHashIssue({ ...issue, sendAt: "2030-01-01T02:00:00+02:00" }),
    requestHashIssue({ ...issue, sendAt: "2030-01-01T00:00:00.000Z" })
  );
});

test("differs on each field (incl. actorUserId)", () => {
  const base = requestHashIssue(issue);
  const variants = [
    { actorUserId: "u2" },
    { programId: "p2" },
    { amount: 5001 },
    { recipientEmail: "b@example.com" },
    { recipientName: "Anna" },
    { senderName: "Rob" },
    { message: "hello" },
    { sendAt: "2030-01-02T00:00:00Z" },
  ];
  for (const change of variants) {
    assert.notDeepEqual(requestHashIssue({ ...issue, ...change }), base, JSON.stringify(change));
  }
  const redeem = requestHashRedeem({ hmac, amount: 3, externalReference: "ref" });
  assert.notDeepEqual(requestHashRedeem({ hmac: Buffer.alloc(32, 8), amount: 3, externalReference: "ref" }), redeem);
  assert.notDeepEqual(requestHashRedeem({ hmac, amount: 4, externalReference: "ref" }), redeem);
  assert.notDeepEqual(requestHashRedeem({ hmac, amount: 3, externalReference: "other" }), redeem);
  const refund = requestHashRefund({ transactionId: "t1", amount: 5 });
  assert.notDeepEqual(requestHashRefund({ transactionId: "t2", amount: 5 }), refund);
  assert.notDeepEqual(requestHashRefund({ transactionId: "t1", amount: 6 }), refund);
});

test("separator characters cannot collide", () => {
  assert.notDeepEqual(
    requestHashIssue({ ...issue, recipientName: "a", senderName: "b" }),
    requestHashIssue({ ...issue, recipientName: 'a","b', senderName: "" })
  );
  assert.notDeepEqual(
    requestHashIssue({ ...issue, recipientName: "a,b", senderName: "c" }),
    requestHashIssue({ ...issue, recipientName: "a", senderName: "b,c" })
  );
});

test("absent vs empty differ", () => {
  assert.notDeepEqual(requestHashIssue({ ...issue, message: null }), requestHashIssue({ ...issue, message: "" }));
  assert.deepEqual(requestHashIssue({ ...issue, message: undefined }), requestHashIssue({ ...issue, message: null }));
  assert.notDeepEqual(requestHashIssue({ ...issue, sendAt: null }), requestHashIssue(issue));
  assert.deepEqual(requestHashIssue({ ...issue, sendAt: undefined }), requestHashIssue({ ...issue, sendAt: null }));
  assert.notDeepEqual(
    requestHashRedeem({ hmac, amount: 3, externalReference: null }),
    requestHashRedeem({ hmac, amount: 3, externalReference: "" })
  );
});

test("operations do not collide with each other", () => {
  assert.notDeepEqual(
    requestHashRefund({ transactionId: "x", amount: 1 }),
    requestHashRedeem({ hmac, amount: 1, externalReference: null })
  );
});
