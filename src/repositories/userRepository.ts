import { EntityRepository, Repository } from "typeorm";
import { User } from "../entities/user";
import { Role } from "../enums/roles";

export class UserRepository extends Repository<User> {
  // Custom method to find a user by email
  async findByEmail(email: string): Promise<User | null> {
    return this.findOne({ where: { email } });
  }

  // Custom method to create a user
  async createUser(
    email: string,
    passwordHash: string,
    role: Role,
    tenantId: number
  ): Promise<User> {
    const user = this.create({ email, passwordHash, role, tenantId });
    return this.save(user);
  }
  /*
  // Custom method to update a user's role
  async updateRole(userId: number, role: Role): Promise<User> {
    const user = await this.findOne(userId);
    if (user) {
      user.role = role;
      return this.save(user);
    }
    throw new Error("User not found");
  }
*/

  // Custom method to delete a user by email
  async deleteByEmail(email: string): Promise<boolean> {
    const user = await this.findOne({ where: { email } });
    if (user) {
      await this.remove(user);
      return true;
    }
    return false;
  }
}
