import { FastifyInstance } from "fastify";
import { Repository } from "typeorm";
import { User } from "../entities/user";
import { Role } from "../enums/roles";
import { ConflictError, NotFoundError } from "../errors";
import { assertPasswordFitsBcrypt, assertValidEmail, hashPassword, normalizeEmail } from "../credentials";

export interface CreateUserInput {
  name: string;
  email: string;
  password: string;
  role?: Role;
}

export class UserService {
  private userRepository: Repository<User>;

  constructor(app: FastifyInstance) {
    this.userRepository = app.db.getRepository(User);
  }

  /** The tenant always comes from the caller's token, never from the request body. */
  async createUser(tenantId: string, input: CreateUserInput) {
    const email = normalizeEmail(input.email);
    assertValidEmail(email);
    assertPasswordFitsBcrypt(input.password);

    if (await this.userRepository.existsBy({ email })) {
      throw new ConflictError("Email already registered");
    }

    const passwordHash = await hashPassword(input.password);
    return this.userRepository.save(
      this.userRepository.create({
        tenantId,
        name: input.name,
        email,
        passwordHash,
        role: input.role ?? Role.STAFF,
      })
    );
  }

  listUsers(tenantId: string): Promise<User[]> {
    return this.userRepository.find({ where: { tenantId }, order: { createdAt: "ASC", id: "ASC" } });
  }

  async getUser(tenantId: string, id: string): Promise<User> {
    const user = await this.userRepository.findOneBy({ id, tenantId });
    if (!user) throw new NotFoundError("User not found");
    return user;
  }
}
