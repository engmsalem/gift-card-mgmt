import { User } from "../entities/user";
import { AppDataSource } from "../data-source";
import { Role } from "../enums/roles";
import "reflect-metadata";

export async function createTestUser() {
  const user = new User();
  user.email = "m@m.com";
  user.passwordHash = "test";
  user.role = Role.REDEMPTION;
  user.tenantId = 1;

  const userRepository = AppDataSource.getRepository(User);

  await userRepository.save(user);
  console.log("User has been saved");

  const savedUsers = await userRepository.find();
  console.log("All users from the db: ", savedUsers);
}
