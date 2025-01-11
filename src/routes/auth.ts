import fastify, {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";
import bcrypt from "bcrypt";
import jwt from "@fastify/jwt";
import { AppDataSource } from "../data-source";
import { User } from "../entity/user";
import { UserRepository } from "../repositories/user.repository";

// Define the type for the request body
interface RegisterRequestBody {
  email: string;
  password: string;
}

export default async function authRoutes(fastify: FastifyInstance) {
  // Register the JWT plugin correctly
  fastify.register(jwt, {
    secret: process.env.JWT_SECRET || "your-secret-key", // Make sure to use a secret key
  });

  // Register Schema for Register Route
  const registerSchema = {
    body: {
      type: "object",
      required: ["email", "password"],
      properties: {
        email: { type: "string", format: "email" },
        password: { type: "string", minLength: 6 },
      },
    },
  };

  fastify.post<{ Body: RegisterRequestBody }>(
    "/register",
    { schema: registerSchema },
    async (
      request: FastifyRequest<{ Body: RegisterRequestBody }>,
      reply: FastifyReply
    ) => {
      const { email, password } = request.body;

      // Use your custom repository to check if the user exists
      const existingUser = await UserRepository.findByEmail(email);
      if (existingUser) {
        return reply.status(400).send({ message: "User already exists" });
      }

      // Hash the password and create a new user
      const hashedPassword = await bcrypt.hash(password, 10);
      await UserRepository.createUser(email, hashedPassword);

      return reply
        .status(201)
        .send({ message: "User registered successfully" });
    }
  );

  // Register Schema for Login Route
  const loginSchema = {
    body: {
      type: "object",
      required: ["email", "password"],
      properties: {
        email: { type: "string", format: "email" },
        password: { type: "string", minLength: 6 },
      },
    },
  };

  fastify.post<{ Body: { email: string; password: string } }>(
    "/login",
    { schema: loginSchema },
    async (
      request: FastifyRequest<{ Body: { email: string; password: string } }>,
      reply: FastifyReply
    ) => {
      const { email, password } = request.body;

      // Find user by email from the database
      const userRepository = AppDataSource.getRepository(User);
      const user = await userRepository.findOne({ where: { email } });

      if (!user) {
        return reply.status(401).send({ message: "Invalid credentials" });
      }

      // Compare password hash with stored hash
      const validPassword = await bcrypt.compare(password, user.passwordHash);
      if (!validPassword) {
        return reply.status(401).send({ message: "Invalid credentials" });
      }

      // Create JWT token and send it to the client
      const token = fastify.jwt.sign({ id: user.id });
      return reply.send({ token });
    }
  );
}
