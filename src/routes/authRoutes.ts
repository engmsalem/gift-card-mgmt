import { FastifyInstance } from "fastify";
import { AuthService } from "../services/authService"; // Auth service
import { UserService } from "../services/userService"; // Optional, for registration

export default async function authRoutes(fastify: FastifyInstance) {
  const authService = new AuthService(fastify); // Pass database instance
  const userService = new UserService(fastify); // For registration logic

  // User Registration
  fastify.post(
    "/auth/register",
    {
      schema: {
        body: {
          type: "object",
          required: ["name", "email", "password"],
          properties: {
            name: { type: "string" },
            email: { type: "string", format: "email" },
            password: { type: "string", minLength: 6 },
          },
        },
      },
    },
    async (request, reply) => {
      const { name, email, password } = request.body as {
        name: string;
        email: string;
        password: string;
      };

      try {
        const newUser = await userService.createUser(name, email);
        return reply.status(201).send(newUser);
      } catch (error: any) {
        return reply.status(400).send({ error: error.message });
      }
    }
  );

  // User Login
  fastify.post(
    "/auth/login",
    {
      schema: {
        body: {
          type: "object",
          required: ["email", "password"],
          properties: {
            email: { type: "string", format: "email" },
            password: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      const { email, password } = request.body as {
        email: string;
        password: string;
      };

      try {
        const token = await authService.login(email, password);
        return reply.send({ token });
      } catch (error: any) {
        return reply.status(401).send({ error: error.message });
      }
    }
  );

  // Token Refresh
  fastify.post("/auth/refresh", async (request, reply) => {
    const { refreshToken } = request.body as { refreshToken: string };

    try {
      const newToken = await authService.refreshToken(refreshToken);
      return reply.send({ token: newToken });
    } catch (error: any) {
      return reply.status(401).send({ error: error.message });
    }
  });

  // Logout
  fastify.post("/auth/logout", async (request, reply) => {
    const { refreshToken } = request.body as { refreshToken: string };

    try {
      await authService.logout(refreshToken);
      return reply.status(200).send({ message: "Logged out successfully" });
    } catch (error: any) {
      return reply.status(400).send({ error: error.message });
    }
  });
}
