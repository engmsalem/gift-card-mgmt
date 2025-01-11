import { BaseEntity, BeforeInsert, BeforeUpdate } from "typeorm";
import { validateOrReject } from "class-validator";

class ExtendedBaseEntity extends BaseEntity {
  @BeforeInsert()
  async validate() {
    await validateOrReject(this);
  }
  @BeforeUpdate()
  async validateUpdate() {
    await validateOrReject(this, { skipMissingProperties: true });
  }
}

export default ExtendedBaseEntity;
