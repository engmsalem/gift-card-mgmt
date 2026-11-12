// Shared JSON schemas. Response schemas list the fields that may leave the API; anything
// else (e.g. passwordHash) is stripped by the serializer even if a handler returns it.
export const userResponse = {
  type: "object",
  properties: {
    id: { type: "integer" },
    tenantId: { type: "integer" },
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
    id: { type: "integer" },
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
