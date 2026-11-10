import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import mongoose from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryMailer, type MailMessage } from '../../src/infrastructure/mailer.ts';
import {
  EmailVerificationTokenModel,
  PasswordResetTokenModel,
} from '../../src/modules/auth/tokens.ts';
import { UserModel } from '../../src/modules/users/user.model.ts';
import {
  ORIGIN,
  PASSWORD,
  buildAuthApp,
  connectTestInfra,
  createUser,
  disconnectTestInfra,
  login,
  resetTestData,
} from './setup.ts';

let redis: Redis;
let app: ReturnType<typeof buildAuthApp>;
let sent: MailMessage[];

const NEW_PASSWORD = 'a brand new long passphrase';

/** Emails are sent in the background; wait until the expected one arrives. */
async function nextEmail(to: string, subject: RegExp, timeoutMs = 3000): Promise<MailMessage> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = sent.find((m) => m.to === to && subject.test(m.subject));
    if (found) {
      sent.splice(sent.indexOf(found), 1);
      return found;
    }
    if (Date.now() > deadline) throw new Error(`no email to ${to} matching ${String(subject)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const settle = () => new Promise((r) => setTimeout(r, 150));
const tokenFrom = (mail: MailMessage) => /#token=([A-Za-z0-9_-]{43})/.exec(mail.text)?.[1] ?? '';
const post = (path: string, body: object) =>
  request(app).post(`/api/v1/auth/${path}`).set('Origin', ORIGIN).send(body);

beforeAll(async () => {
  redis = await connectTestInfra();
});
beforeEach(async () => {
  await resetTestData();
  const memory = createMemoryMailer();
  sent = memory.sent;
  app = buildAuthApp({ redis, mailer: memory.mailer });
});
afterAll(disconnectTestInfra);

describe('email verification', () => {
  const register = () =>
    post('register', {
      email: 'new@example.com',
      password: PASSWORD,
      displayName: 'New <b>User</b>',
    });

  it('sends a link with the token in the URL fragment, stores only its hash, and verifies once', async () => {
    expect((await register()).status).toBe(202);
    const mail = await nextEmail('new@example.com', /Verify/);
    expect(mail.text).toContain(`${ORIGIN}/verify-email#token=`);
    expect(mail.html).toContain('New &lt;b&gt;User&lt;/b&gt;');
    const token = tokenFrom(mail);

    const stored = await EmailVerificationTokenModel.find().lean();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(JSON.stringify(stored)).not.toContain(token);

    expect(
      (await post('login', { email: 'new@example.com', password: PASSWORD })).body.error.code,
    ).toBe('EMAIL_NOT_VERIFIED');
    expect((await post('verify-email', { token })).status).toBe(200);
    expect((await post('login', { email: 'new@example.com', password: PASSWORD })).status).toBe(
      200,
    );

    const reuse = await post('verify-email', { token });
    expect(reuse.status).toBe(400);
    expect(reuse.body.error.code).toBe('INVALID_TOKEN');
  });

  it('rejects an expired token', async () => {
    await register();
    const token = tokenFrom(await nextEmail('new@example.com', /Verify/));
    await EmailVerificationTokenModel.updateMany(
      {},
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    expect((await post('verify-email', { token })).body.error.code).toBe('INVALID_TOKEN');
  });

  it('rejects malformed tokens and injection attempts at validation', async () => {
    expect((await post('verify-email', { token: { $ne: null } })).status).toBe(400);
    expect((await post('verify-email', { token: 'short' })).status).toBe(400);
  });

  it('only the most recent link works after a resend', async () => {
    await register();
    const first = tokenFrom(await nextEmail('new@example.com', /Verify/));
    expect((await post('resend-verification', { email: 'new@example.com' })).status).toBe(202);
    const second = tokenFrom(await nextEmail('new@example.com', /Verify/));
    expect(second).not.toBe(first);
    expect((await post('verify-email', { token: first })).status).toBe(400);
    expect((await post('verify-email', { token: second })).status).toBe(200);
  });

  it('answers resend identically for unknown and verified emails, without sending anything', async () => {
    await createUser({ email: 'verified@example.com' });
    const unknown = await post('resend-verification', { email: 'nobody@example.com' });
    const verified = await post('resend-verification', { email: 'verified@example.com' });
    expect(unknown.status).toBe(202);
    expect(verified.body).toEqual(unknown.body);
    await settle();
    expect(sent).toHaveLength(0);
  });

  it('caps emails per address per hour (no mail-bombing through the app)', async () => {
    await createUser({ email: 'victim@example.com', verified: false });
    for (let i = 0; i < 5; i++) {
      expect((await post('resend-verification', { email: 'victim@example.com' })).status).toBe(202);
    }
    await settle();
    expect(sent.filter((m) => m.to === 'victim@example.com')).toHaveLength(3);
  });
});

describe('duplicate registration', () => {
  it('notifies the existing owner instead of revealing the account to the requester', async () => {
    await createUser({ email: 'owner@example.com' });
    const res = await post('register', {
      email: 'owner@example.com',
      password: PASSWORD,
      displayName: 'Someone',
    });
    expect(res.status).toBe(202);
    const notice = await nextEmail('owner@example.com', /tried to register/);
    expect(notice.text).not.toMatch(/#token=/);
    expect(await UserModel.countDocuments()).toBe(1);
  });
});

describe('password policy', () => {
  it.each([
    ['a common password', 'password1234'],
    ['the email address itself', 'common@example.com'],
  ])('rejects %s at registration', async (_label, password) => {
    const res = await post('register', { email: 'common@example.com', password, displayName: 'X' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('WEAK_PASSWORD');
    expect(await UserModel.countDocuments()).toBe(0);
  });
});

describe('forgot and reset password', () => {
  it('answers identically for unknown emails and sends nothing', async () => {
    await createUser({ email: 'user@example.com' });
    const unknown = await post('forgot-password', { email: 'nobody@example.com' });
    const known = await post('forgot-password', { email: 'user@example.com' });
    expect(unknown.status).toBe(202);
    expect(known.body).toEqual(unknown.body);
    await nextEmail('user@example.com', /Reset/);
    await settle();
    expect(sent).toHaveLength(0);
  });

  it('resets the password once, signs out every session and notifies the owner', async () => {
    await createUser({ email: 'user@example.com' });
    const before = await login(app);

    await post('forgot-password', { email: 'user@example.com' });
    const mail = await nextEmail('user@example.com', /Reset/);
    expect(mail.text).toContain(`${ORIGIN}/reset-password#token=`);
    const token = tokenFrom(mail);

    const res = await post('reset-password', { token, password: NEW_PASSWORD });
    expect(res.status).toBe(200);
    await nextEmail('user@example.com', /password was changed/);

    const stale = await before.agent.get('/api/v1/users/me');
    expect(stale.status).toBe(401);
    expect(stale.body.error.code).toBe('SESSION_EXPIRED');

    expect((await post('login', { email: 'user@example.com', password: PASSWORD })).status).toBe(
      401,
    );
    expect(
      (await post('login', { email: 'user@example.com', password: NEW_PASSWORD })).status,
    ).toBe(200);
    expect(
      (await post('reset-password', { token, password: 'yet another long passphrase' })).status,
    ).toBe(400);
  });

  it('keeps the link usable when the new password is rejected', async () => {
    await createUser({ email: 'user@example.com' });
    await post('forgot-password', { email: 'user@example.com' });
    const token = tokenFrom(await nextEmail('user@example.com', /Reset/));
    expect(
      (await post('reset-password', { token, password: 'password1234' })).body.error.code,
    ).toBe('WEAK_PASSWORD');
    expect((await post('reset-password', { token, password: NEW_PASSWORD })).status).toBe(200);
  });

  it('lets only one of two simultaneous resets with the same token succeed', async () => {
    await createUser({ email: 'user@example.com' });
    await post('forgot-password', { email: 'user@example.com' });
    const token = tokenFrom(await nextEmail('user@example.com', /Reset/));
    const results = await Promise.all([
      post('reset-password', { token, password: 'first concurrent passphrase' }),
      post('reset-password', { token, password: 'second concurrent passphrase' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
  });

  it('rejects an expired reset token', async () => {
    await createUser({ email: 'user@example.com' });
    await post('forgot-password', { email: 'user@example.com' });
    const token = tokenFrom(await nextEmail('user@example.com', /Reset/));
    await PasswordResetTokenModel.updateMany(
      {},
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    expect((await post('reset-password', { token, password: NEW_PASSWORD })).body.error.code).toBe(
      'INVALID_TOKEN',
    );
  });

  it('verifies the email as a side effect (the user proved inbox ownership)', async () => {
    await createUser({ email: 'user@example.com', verified: false });
    await post('forgot-password', { email: 'user@example.com' });
    const token = tokenFrom(await nextEmail('user@example.com', /Reset/));
    await post('reset-password', { token, password: NEW_PASSWORD });
    expect(
      (await post('login', { email: 'user@example.com', password: NEW_PASSWORD })).status,
    ).toBe(200);
  });
});

describe('change password', () => {
  it('requires the current password', async () => {
    await createUser();
    const { agent, csrfToken } = await login(app);
    const res = await agent
      .post('/api/v1/auth/change-password')
      .set('X-CSRF-Token', csrfToken)
      .send({ currentPassword: 'not my password', newPassword: NEW_PASSWORD });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_CURRENT_PASSWORD');
  });

  it('requires the CSRF token', async () => {
    await createUser();
    const { agent } = await login(app);
    const res = await agent
      .post('/api/v1/auth/change-password')
      .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(403);
  });

  it('rotates this session, signs out other devices and notifies the owner', async () => {
    await createUser();
    const laptop = await login(app);
    const phone = await login(app);

    const res = await laptop.agent
      .post('/api/v1/auth/change-password')
      .set('X-CSRF-Token', laptop.csrfToken)
      .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data.csrfToken).not.toBe(laptop.csrfToken);
    await nextEmail('user@example.com', /password was changed/);

    expect((await laptop.agent.get('/api/v1/users/me')).status).toBe(200);
    expect((await phone.agent.get('/api/v1/users/me')).body.error.code).toBe('SESSION_EXPIRED');
    // The old CSRF token died with the old session.
    expect(
      (
        await laptop.agent
          .patch('/api/v1/users/me')
          .set('X-CSRF-Token', laptop.csrfToken)
          .send({ displayName: 'x' })
      ).status,
    ).toBe(403);
    expect(
      (await post('login', { email: 'user@example.com', password: NEW_PASSWORD })).status,
    ).toBe(200);
  });
});

describe('account deactivation', () => {
  it('requires the password, signs out everywhere and blocks future logins', async () => {
    await createUser();
    const laptop = await login(app);
    const phone = await login(app);
    const wrong = await laptop.agent
      .post('/api/v1/users/me/deactivate')
      .set('X-CSRF-Token', laptop.csrfToken)
      .send({ password: 'not my password' });
    expect(wrong.status).toBe(400);

    const res = await laptop.agent
      .post('/api/v1/users/me/deactivate')
      .set('X-CSRF-Token', laptop.csrfToken)
      .send({ password: PASSWORD });
    expect(res.status).toBe(204);
    await nextEmail('user@example.com', /deactivated/);
    expect((await phone.agent.get('/api/v1/users/me')).status).toBe(401);
    expect(await mongoose.connection.collection('sessions').countDocuments()).toBe(0);
    expect(
      (await post('login', { email: 'user@example.com', password: PASSWORD })).body.error.code,
    ).toBe('ACCOUNT_DEACTIVATED');
  });
});

describe('session expiry signal', () => {
  it('says SESSION_EXPIRED for a dead session cookie, but UNAUTHENTICATED with no cookie', async () => {
    await createUser();
    const { agent, csrfToken } = await login(app);
    await agent.delete('/api/v1/auth/sessions').set('X-CSRF-Token', csrfToken);
    await mongoose.connection.collection('sessions').deleteMany({});
    expect((await agent.get('/api/v1/users/me')).body.error.code).toBe('SESSION_EXPIRED');
    expect((await request(app).get('/api/v1/users/me')).body.error.code).toBe('UNAUTHENTICATED');
  });
});
