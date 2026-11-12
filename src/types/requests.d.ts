import "fastify";
import "@fastify/jwt";
import { FastifyRequest } from "fastify";
import { DataSource } from "typeorm";
import { Role } from "../enums/roles";

export {};

declare module "@fastify/jwt" {
  interface FastifyJWT {
    // Access token claims
    payload: { sub: string; tid: number; role: Role; typ: string };
    // `request.user` after `request.jwtVerify()` (built by formatUser in src/plugins/jwt.ts)
    user: { id: number; tenantId: number; role: Role };
  }
}

declare module "fastify" {
  interface FastifyInstance {
    db: DataSource;
    authenticate: (request: FastifyRequest) => Promise<void>;
  }
}
