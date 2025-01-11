import "fastify";
import { JWT } from "@fastify/jwt";
import { DataSource } from "typeorm";
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
declare module "fastify" {
  interface FastifyInstance {
    db: DataSource; // Add your custom property here
  }
}
