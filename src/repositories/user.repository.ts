import { AppDataSource } from "../data-source";
import { User } from "../entity/user";

export const UserRepository = AppDataSource.getRepository(User).extend({
  async findByEmail(email: string) {
    return this.findOne({ where: { email } });
  },

  async createUser(email: string, passwordHash: string) {
    const user = this.create({ email, passwordHash });
    return this.save(user);
  },
});
