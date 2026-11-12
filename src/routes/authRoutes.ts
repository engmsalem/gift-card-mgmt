import { FastifyInstance } from "fastify";
import { AuthService } from "../services/authService";
import { errorResponse, tokenPairResponse } from "./schemas";

const refreshTokenBody = {
  type: "object",
  required: ["refreshToken"],
  additionalProperties: false,
  properties: { refreshToken: { type: "string", minLength: 1, maxLength: 200 } },
} as const;

export default async function authRoutes(fastify: FastifyInstance) {
  const authService = new AuthService(fastify);

  fastify.post<{ Body: { email: string; password: string } }>(
    "/auth/login",
    {
      // Stricter than the global limit: this route is the password-guessing target
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        body: {
          type: "object",
          required: ["email", "password"],
          additionalProperties: false,
          properties: {
            email: { type: "string", maxLength: 254 },
            password: { type: "string", maxLength: 128 },
          },
        },
        response: { 200: tokenPairResponse, "4xx": errorResponse },
      },
    },
    async (request) => authService.login(request.body.email, request.body.password)
  );

  fastify.post<{ Body: { refreshToken: string } }>(
    "/auth/refresh",
    {
      schema: {
        body: refreshTokenBody,
        response: { 200: tokenPairResponse, "4xx": errorResponse },
      },
    },
    async (request) => authService.refresh(request.body.refreshToken)
  );

  fastify.post<{ Body: { refreshToken: string } }>(
    "/auth/logout",
    { schema: { body: refreshTokenBody } },
    async (request, reply) => {
      await authService.logout(request.body.refreshToken);
      return reply.status(204).send();
    }
  );
}
