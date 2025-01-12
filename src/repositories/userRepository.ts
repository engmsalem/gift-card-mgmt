import { Repository } from "typeorm";
import { User } from "../entities/user";
import { Role } from "../enums/roles";

export class UserRepository {
  constructor(private userRepository: Repository<User>) {}
  // Custom method to find a user by email
  async findByEmail(email: string): Promise<User | null> {
    return this.userRepository.findOne({ where: { email } });
  }

  // Custom method to create a user
  async createUser(
    email: string,
    passwordHash: string,
    role: Role,
    tenantId: number
  ): Promise<User> {
    const user = this.userRepository.create({
      email,
      passwordHash,
      role,
      tenantId,
    });
    return this.userRepository.save(user);
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
    const user = await this.userRepository.findOne({ where: { email } });
    if (user) {
      await this.userRepository.remove(user);
      return true;
    }
    return false;
  }
  // Function to get all users
  async getAllUsers(): Promise<User[]> {
    try {
      // Fetch all users from the database
      const users = await this.userRepository.find();
      return users;
    } catch (error) {
      console.error("Error fetching users:", error);
      throw new Error("Failed to fetch users");
    }
  }
}
