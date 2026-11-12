import { FastifyInstance } from "fastify";
import { CreateTenantInput, TenantService } from "../services/tenantService";
import { errorResponse, tenantResponse, userResponse } from "./schemas";

export default async function tenantRoutes(fastify: FastifyInstance) {
  const tenantService = new TenantService(fastify);

  // Public tenant signup: creates the tenant and its first admin in one transaction
  fastify.post<{ Body: CreateTenantInput }>(
    "/tenants",
    {
      // Public and bcrypt-heavy, so much stricter than the global limit
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: {
        body: {
          type: "object",
          required: ["tenant", "admin"],
          additionalProperties: false,
          properties: {
            tenant: {
              type: "object",
              required: ["name", "subdomain"],
              additionalProperties: false,
              properties: {
                name: { type: "string", minLength: 1, maxLength: 100 },
                subdomain: { type: "string", pattern: "^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$" },
              },
            },
            admin: {
              type: "object",
              required: ["name", "email", "password"],
              additionalProperties: false,
              properties: {
                name: { type: "string", minLength: 1, maxLength: 100 },
                email: { type: "string", maxLength: 254 },
                password: { type: "string", minLength: 8, maxLength: 72 },
              },
            },
          },
        },
        response: {
          201: {
            type: "object",
            properties: { tenant: tenantResponse, user: userResponse },
          },
          "4xx": errorResponse,
        },
      },
    },
    async (request, reply) => {
      const result = await tenantService.createTenant(request.body);
      return reply.status(201).send(result);
    }
  );
}
