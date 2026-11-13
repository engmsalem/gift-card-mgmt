// Shared JSON schemas. Response schemas list the fields that may leave the API; anything
// else (e.g. passwordHash) is stripped by the serializer even if a handler returns it.
export const userResponse = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    tenantId: { type: "string", format: "uuid" },
    name: { type: "string" },
    email: { type: "string" },
    role: { type: "string", enum: ["admin", "staff"] },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
} as const;

export const tenantResponse = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    name: { type: "string" },
    subdomain: { type: "string" },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
} as const;

export const errorResponse = {
  type: "object",
  properties: { error: { type: "string" } },
} as const;

export const tokenPairResponse = {
  type: "object",
  properties: {
    accessToken: { type: "string" },
    refreshToken: { type: "string" },
    expiresIn: { type: "integer" },
  },
} as const;

export const giftCardProgramResponse = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    name: { type: "string" },
    cardType: { type: "string", enum: ["paid", "promotional"] },
    currency: { type: "string" },
    currencyExponent: { type: "integer" },
    country: { type: "string" },
    region: { type: ["string", "null"] },
    cardNumberPrefix: { type: "string" },
    cardNumberLength: { type: "integer" },
    pinRequired: { type: "boolean" },
    maxValue: { type: "integer" },
    expiryMonths: { type: ["integer", "null"] },
    staffDailyIssueLimit: { type: ["integer", "null"] },
    status: { type: "string", enum: ["active", "retired"] },
    hasIssuedCards: { type: "boolean" },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
} as const;
