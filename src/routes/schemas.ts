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

export const giftCardResponse = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    programId: { type: "string", format: "uuid" },
    referenceNumber: { type: "string" },
    last4: { type: "string" },
    currency: { type: "string" },
    currencyExponent: { type: "integer" },
    initialAmount: { type: "integer" },
    balance: { type: "integer" },
    status: { type: "string", enum: ["active", "suspended", "depleted", "voided", "expired"] },
    hasPin: { type: "boolean" },
    expiresAt: { type: ["string", "null"], format: "date-time" },
    pinLocked: { type: "boolean" },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
} as const;

export const giftCardDeliveryResponse = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    recipientName: { type: "string" },
    recipientEmail: { type: "string" },
    senderName: { type: "string" },
    message: { type: ["string", "null"] },
    sendAt: { type: "string", format: "date-time" },
    status: { type: "string", enum: ["scheduled", "sending", "sent", "failed", "cancelled"] },
    attempts: { type: "integer" },
    sentAt: { type: ["string", "null"], format: "date-time" },
    openedAt: { type: ["string", "null"], format: "date-time" },
    revealCount: { type: "integer" },
    lastRevealedAt: { type: ["string", "null"], format: "date-time" },
  },
} as const;

export const giftCardWithDeliveryResponse = {
  type: "object",
  properties: { card: giftCardResponse, delivery: giftCardDeliveryResponse },
} as const;

export const giftCardTransactionResponse = {
  type: "object",
  properties: {
    id: { type: "string", format: "uuid" },
    giftCardId: { type: "string", format: "uuid" },
    type: { type: "string", enum: ["issue", "redeem", "refund", "void"] },
    amount: { type: "integer" },
    currency: { type: "string" },
    balanceAfter: { type: "integer" },
    relatedTransactionId: { type: ["string", "null"], format: "uuid" },
    externalReference: { type: ["string", "null"] },
    actorUserId: { type: "string", format: "uuid" },
    createdAt: { type: "string", format: "date-time" },
  },
} as const;
