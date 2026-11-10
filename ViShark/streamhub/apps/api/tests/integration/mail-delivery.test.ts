import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSmtpMailer } from '../../src/infrastructure/mailer.ts';
import { testConfig } from './setup.ts';

/** Real SMTP delivery into the local Mailpit, read back through its API. */
describe('SMTP mailer (Mailpit)', () => {
  it('delivers a message that Mailpit receives intact', async () => {
    const config = testConfig();
    const api = process.env.MAILPIT_API_URL ?? 'http://127.0.0.1:8025';
    const subject = `integration ${randomUUID()}`;
    await createSmtpMailer(config).send({
      to: 'mail-test@streamhub.local',
      subject,
      text: 'plain body',
      html: '<p>html body</p>',
    });

    let id: string | undefined;
    for (let i = 0; i < 20 && !id; i++) {
      const res = await fetch(
        `${api}/api/v1/search?query=${encodeURIComponent(`subject:"${subject}"`)}`,
      );
      id = ((await res.json()) as { messages?: { ID: string }[] }).messages?.[0]?.ID;
      if (!id) await new Promise((r) => setTimeout(r, 200));
    }
    expect(id).toBeDefined();
    const message = (await (await fetch(`${api}/api/v1/message/${id}`)).json()) as {
      From: { Address: string };
      Text: string;
      HTML: string;
    };
    expect(message.From.Address).toBe('no-reply@streamhub.local');
    expect(message.Text.trim()).toBe('plain body');
    expect(message.HTML).toContain('html body');
    await fetch(`${api}/api/v1/messages`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ IDs: [id] }),
    });
  });
});
