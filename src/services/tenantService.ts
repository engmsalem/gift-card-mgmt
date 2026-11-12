import { FastifyInstance } from "fastify";
import { EntityManager } from "typeorm";
import { Tenant } from "../entities/tenant";
import { User } from "../entities/user";
import { Role } from "../enums/roles";
import { ConflictError } from "../errors";
import { assertPasswordFitsBcrypt, assertValidEmail, hashPassword, normalizeEmail } from "../credentials";

export interface CreateTenantInput {
  tenant: { name: string; subdomain: string };
  admin: { name: string; email: string; password: string };
}

export class TenantService {
  constructor(private app: FastifyInstance) {}

  /** Creates a tenant and its first admin user atomically. */
  async createTenant(input: CreateTenantInput) {
    const email = normalizeEmail(input.admin.email);
    assertValidEmail(email);
    assertPasswordFitsBcrypt(input.admin.password);

    // Cheap reads first, so a doomed signup never pays for bcrypt. The checks are repeated
    // inside the transaction (and the unique constraints back them) to cover races.
    await this.assertAvailable(this.app.db.manager, input.tenant.subdomain, email);
    const passwordHash = await hashPassword(input.admin.password);

    return this.app.db.transaction(async (em) => {
      await this.assertAvailable(em, input.tenant.subdomain, email);

      const tenant = await em.save(
        em.create(Tenant, { name: input.tenant.name, subdomain: input.tenant.subdomain })
      );
      const user = await em.save(
        em.create(User, {
          tenantId: tenant.id,
          name: input.admin.name,
          email,
          passwordHash,
          role: Role.ADMIN,
        })
      );
      return { tenant, user };
    });
  }

  private async assertAvailable(em: EntityManager, subdomain: string, email: string): Promise<void> {
    if (await em.existsBy(Tenant, { subdomain })) {
      throw new ConflictError("Subdomain already taken");
    }
    if (await em.existsBy(User, { email })) {
      throw new ConflictError("Email already registered");
    }
  }
}
