import { test } from "node:test";
import assert from "node:assert/strict";
import { currencyExponent, isSupportedCountry, isSupportedCurrency, isValidRegion } from "../../src/gift-cards/money";

test("KWD/BHD/OMR exponent 3", () => {
  for (const code of ["KWD", "BHD", "OMR"]) assert.equal(currencyExponent(code), 3);
});

test("CAD exponent 2", () => {
  for (const code of ["CAD", "USD", "AED", "SAR", "QAR"]) assert.equal(currencyExponent(code), 2);
});

test("unsupported currency rejected", () => {
  for (const code of ["EUR", "cad", "", "toString", "__proto__", "JPY"]) {
    assert.equal(isSupportedCurrency(code), false, code);
    assert.equal(currencyExponent(code), null, code);
  }
});

test("countries come from the known list", () => {
  for (const code of ["CA", "AE", "SA", "KW", "BH", "OM", "QA"]) assert.ok(isSupportedCountry(code));
  for (const code of ["US", "ca", "CAN", ""]) assert.ok(!isSupportedCountry(code));
});

test("region must be ISO 3166-2 shaped within the country", () => {
  assert.ok(isValidRegion("CA-ON", "CA"));
  assert.ok(isValidRegion("AE-AZ", "AE"));
  assert.ok(!isValidRegion("CA-ON", "AE"));
  assert.ok(!isValidRegion("CA-", "CA"));
  assert.ok(!isValidRegion("CA-ONTA", "CA"));
  assert.ok(!isValidRegion("ca-on", "CA"));
});
