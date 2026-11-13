// Amounts are integer minor units; the exponent says how many decimal places a major unit has.
export const CURRENCY_EXPONENTS = {
  CAD: 2,
  USD: 2,
  AED: 2,
  SAR: 2,
  QAR: 2,
  KWD: 3,
  BHD: 3,
  OMR: 3,
} as const;

export type SupportedCurrency = keyof typeof CURRENCY_EXPONENTS;

// A known list rather than a regex: adding a market is a deliberate change that follows legal review
export const SUPPORTED_COUNTRIES = ["CA", "AE", "SA", "KW", "BH", "OM", "QA"] as const;

const REGION_PATTERN = /^[A-Z]{2}-[A-Z0-9]{1,3}$/;

export function isSupportedCurrency(code: string): code is SupportedCurrency {
  return Object.prototype.hasOwnProperty.call(CURRENCY_EXPONENTS, code);
}

/** Decimal places of the currency, or null if it is not supported. */
export function currencyExponent(code: string): number | null {
  return isSupportedCurrency(code) ? CURRENCY_EXPONENTS[code] : null;
}

export function isSupportedCountry(code: string): boolean {
  return (SUPPORTED_COUNTRIES as readonly string[]).includes(code);
}

/** ISO 3166-2 shape, and its country part must equal `country`. No subdivision list is kept. */
export function isValidRegion(region: string, country: string): boolean {
  return REGION_PATTERN.test(region) && region.slice(0, 2) === country;
}
