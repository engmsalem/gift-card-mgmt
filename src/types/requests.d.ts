import { JWT } from "@fastify/jwt";

export {};
declare module "fastify" {
  interface FastifyRequest {
    user?: {
      id: number;
      email: string;
      role: string;
    };
    jwtVerify: JWT["verify"];
  }
}
