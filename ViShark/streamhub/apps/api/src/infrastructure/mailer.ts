import nodemailer from 'nodemailer';
import type { Logger } from 'pino';
import type { AppConfig } from '../config/env.ts';

export type MailMessage = { to: string; subject: string; text: string; html: string };

export type Mailer = { send: (message: MailMessage) => Promise<void> };

/** SMTP mailer: Mailpit locally, Amazon SES (or another SMTP relay) in production. */
export function createSmtpMailer(
  config: Pick<
    AppConfig,
    'SMTP_HOST' | 'SMTP_PORT' | 'SMTP_SECURE' | 'SMTP_USER' | 'SMTP_PASSWORD' | 'MAIL_FROM'
  >,
): Mailer {
  const transport = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    ...(config.SMTP_USER
      ? { auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD ?? '' } }
      : {}),
  });
  return {
    async send(message) {
      await transport.sendMail({ from: config.MAIL_FROM, ...message });
    },
  };
}

/** In-memory mailer for tests. */
export function createMemoryMailer() {
  const sent: MailMessage[] = [];
  const mailer: Mailer = {
    send(message) {
      sent.push(message);
      return Promise.resolve();
    },
  };
  return { mailer, sent };
}

/**
 * Sends an email without making the HTTP response wait for SMTP.
 *
 * This is a security property as much as a speed one: "forgot password" must
 * answer equally fast whether or not the account exists. If the response
 * waited for an email that is only sent for real accounts, timing would
 * reveal which emails are registered.
 *
 * Failures are logged, not retried. Phase 6 moves email onto the BullMQ queue
 * for retries and durability.
 */
export function sendInBackground(
  mailer: Mailer,
  message: MailMessage,
  logger: Logger,
  event: string,
): void {
  void mailer.send(message).then(
    () => logger.info({ event: `${event}.sent` }, 'email sent'),
    (err: unknown) => logger.error({ event: `${event}.failed`, err }, 'email delivery failed'),
  );
}
