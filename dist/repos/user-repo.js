"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createTestUser = void 0;
const user_1 = require("../entity/user");
const data_source_1 = require("../data-source");
const roles_1 = require("../enums/roles");
require("reflect-metadata");
async function createTestUser() {
    const user = new user_1.User();
    user.email = "m@m.com";
    user.passwordHash = "test";
    user.role = roles_1.Role.REDEMPTION;
    user.tenantId = 1;
    const userRepository = data_source_1.AppDataSource.getRepository(user_1.User);
    await userRepository.save(user);
    console.log("User has been saved");
    const savedUsers = await userRepository.find();
    console.log("All users from the db: ", savedUsers);
}
exports.createTestUser = createTestUser;
//# sourceMappingURL=user-repo.js.map