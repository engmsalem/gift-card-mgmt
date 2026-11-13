import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateCardNumber,
  generatePin,
  generateReferenceNumber,
  isLuhnValid,
  luhnCheckDigit,
  normalizeCardNumber,
  normalizeReferenceNumber,
  programNumberingProblems,
} from "../../src/gift-cards/card-number";

test("luhn: known vectors", () => {
  assert.equal(luhnCheckDigit("7992739871"), 3);
  assert.ok(isLuhnValid("79927398713"));
  assert.ok(isLuhnValid("4539578763621486"));
  assert.ok(isLuhnValid("378282246310005"));
  assert.ok(!isLuhnValid("79927398714"));
  assert.ok(!isLuhnValid("4539578763621487"));
  assert.ok(!isLuhnValid("4539x78763621486"));
  assert.ok(!isLuhnValid(""));
});

test("generate: length/prefix/Luhn for 16-19", () => {
  for (let length = 16; length <= 19; length++) {
    for (const prefix of ["7000", "830000", "9000"]) {
      const number = generateCardNumber(prefix, length);
      assert.equal(number.length, length);
      assert.ok(number.startsWith(prefix));
      assert.match(number, /^[0-9]+$/);
      assert.ok(isLuhnValid(number));
    }
  }
});

test("generate: uses injected randomInt only", () => {
  const calls: number[] = [];
  const number = generateCardNumber("7000", 16, (max) => {
    calls.push(max);
    return calls.length % 10;
  });
  assert.equal(calls.length, 11); // 16 - 4 prefix - 1 check digit
  assert.ok(calls.every((max) => max === 10));
  assert.equal(number.slice(0, 15), "700012345678901");
  assert.ok(isLuhnValid(number));
  assert.throws(() => generateCardNumber("70a0", 16, () => 0), RangeError);
  assert.throws(() => generateCardNumber("7000", 5, () => 0), RangeError);
});

test("prefix: rejects first digit 0-6", () => {
  for (const first of ["0", "1", "2", "3", "4", "5", "6"]) {
    assert.ok(programNumberingProblems(first + "000", 19, false).length > 0, first);
  }
  for (const prefix of ["7000", "8300", "9000"]) {
    assert.deepEqual(programNumberingProblems(prefix, 19, false), [], prefix);
  }
});

test("prefix: rejects 81/82/9792", () => {
  for (const prefix of ["8100", "8200", "812345", "9792", "979200"]) {
    assert.match(programNumberingProblems(prefix, 19, false).join(), /payment network/, prefix);
  }
  assert.deepEqual(programNumberingProblems("9791", 19, false), []);
});

test("prefix: rejects length 3 and 7", () => {
  assert.ok(programNumberingProblems("700", 19, false).length > 0);
  assert.ok(programNumberingProblems("7000000", 19, false).length > 0);
  assert.ok(programNumberingProblems("70a0", 19, false).length > 0);
  assert.deepEqual(programNumberingProblems("700000", 19, false), []);
});

test("card number length is 16 to 19", () => {
  assert.ok(programNumberingProblems("7000", 15, true).length > 0);
  assert.ok(programNumberingProblems("7000", 20, true).length > 0);
  assert.ok(programNumberingProblems("7000", 16.5, true).length > 0);
  for (const length of [16, 17, 18, 19]) assert.deepEqual(programNumberingProblems("7000", length, true), []);
});

test("pinless requires 19", () => {
  assert.match(programNumberingProblems("7000", 16, false).join(), /19/);
  assert.deepEqual(programNumberingProblems("7000", 19, false), []);
  assert.deepEqual(programNumberingProblems("7000", 16, true), []);
});

test("normalize: strips spaces and hyphens", () => {
  const number = generateCardNumber("7000", 16);
  const spaced = number.replace(/(.{4})/g, "$1 ").trim();
  const hyphenated = number.replace(/(.{4})/g, "$1-").replace(/-$/, "");
  assert.equal(normalizeCardNumber(spaced), number);
  assert.equal(normalizeCardNumber(hyphenated), number);
  assert.equal(normalizeCardNumber(number), number);
});

test("normalize: rejects Luhn failure, 15/20 digits, letters", () => {
  const valid = generateCardNumber("7000", 16);
  const wrongCheck = valid.slice(0, 15) + String((Number(valid[15]) + 1) % 10);
  assert.equal(normalizeCardNumber(wrongCheck), null);
  assert.equal(normalizeCardNumber("378282246310005"), null); // 15 digits, Luhn-valid
  const nineteen = "7".repeat(19);
  const twenty = nineteen + luhnCheckDigit(nineteen);
  assert.equal(twenty.length, 20);
  assert.equal(normalizeCardNumber(twenty), null);
  assert.equal(normalizeCardNumber(valid.slice(0, 15) + "x"), null);
  assert.equal(normalizeCardNumber(""), null);
  assert.equal(normalizeCardNumber(valid + "\n"), null);
});

test("reference: alphabet, length, O/I/L", () => {
  for (let i = 0; i < 50; i++) assert.match(generateReferenceNumber(), /^[0-9A-HJKMNP-TV-Z]{12}$/);
  assert.equal(generateReferenceNumber(() => 0), "000000000000");
  assert.equal(generateReferenceNumber(() => 31), "ZZZZZZZZZZZZ");
  assert.equal(normalizeReferenceNumber("abcd-efgh-jkmn"), "ABCDEFGHJKMN");
  assert.equal(normalizeReferenceNumber("OOOO-IIII-LLLL"), "000011111111");
  assert.equal(normalizeReferenceNumber("ABCD-EFGH-JKMU"), null); // U is not in the alphabet
  assert.equal(normalizeReferenceNumber("ABCD"), null);
});

test("pin: 6 digits from the injected randomInt", () => {
  assert.match(generatePin(), /^[0-9]{6}$/);
  let n = 0;
  assert.equal(generatePin(() => n++), "012345");
});
