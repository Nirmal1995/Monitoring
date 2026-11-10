import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MONGOOSE_SAFETY_SETTINGS } from '../../src/database/mongoose-settings.ts';
import { UserModel } from '../../src/modules/users/user.model.ts';
import { connectTestInfra, createUser, disconnectTestInfra, resetTestData } from './setup.ts';

beforeAll(async () => {
  await connectTestInfra();
});
beforeEach(resetTestData);
afterAll(disconnectTestInfra);

describe('integration tests run with production Mongoose settings', () => {
  it('has every safety setting active (regression guard)', () => {
    for (const [key, value] of Object.entries(MONGOOSE_SAFETY_SETTINGS)) {
      expect(mongoose.get(key as keyof typeof MONGOOSE_SAFETY_SETTINGS)).toBe(value);
    }
  });

  it('neutralises an operator injected as a filter value', async () => {
    await createUser({ email: 'victim@example.com' });
    // What a JSON body like {"email": {"$ne": null}} would become without validation.
    const injected = { $ne: null } as unknown as string;
    await expect(UserModel.findOne({ email: injected }).exec()).rejects.toThrow(
      /Cast to string failed/,
    );
  });

  it('still allows operators the code marks as trusted', async () => {
    await createUser({ email: 'a@example.com' });
    const found = await UserModel.find({
      createdAt: mongoose.trusted({ $lte: new Date() }) as unknown as Date,
    }).exec();
    expect(found).toHaveLength(1);
  });
});
