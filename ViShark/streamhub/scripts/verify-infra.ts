/**
 * Verifies that every local infrastructure service is reachable from the host
 * using the same client libraries and credentials the application will use,
 * and that the security boundaries we configured actually hold.
 *
 * Run with: pnpm infra:verify   (loads .env)
 */
import { randomUUID } from 'node:crypto';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Redis } from 'ioredis';
import { MongoClient } from 'mongodb';
import nodemailer from 'nodemailer';

type Result = { name: string; ok: boolean; detail: string };
const results: Result[] = [];

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name} (did you run pnpm env:init?)`);
  return value;
}

async function check(name: string, fn: () => Promise<string>): Promise<void> {
  const started = performance.now();
  try {
    const detail = await fn();
    results.push({
      name,
      ok: true,
      detail: `${detail} (${Math.round(performance.now() - started)} ms)`,
    });
  } catch (err) {
    results.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
  }
}

async function expectRejected(promise: Promise<unknown>, expected: RegExp): Promise<string> {
  try {
    await promise;
  } catch (err) {
    const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    if (expected.test(text)) {
      // MongoDB echoes the whole refused command (session ids, cluster
      // signature) in authorization errors; keep only the meaningful part.
      const summary = (text.split('\n')[0] ?? text).replace(/ to execute command .*$/, '');
      return `rejected as expected (${summary.slice(0, 120)})`;
    }
    throw new Error(`rejected for an unexpected reason: ${text}`, { cause: err });
  }
  throw new Error('operation succeeded but should have been denied');
}

async function verifyMongo(): Promise<void> {
  const client = new MongoClient(env('MONGO_URL'), { serverSelectionTimeoutMS: 5000 });
  try {
    await check('mongo: connect + ping as app user', async () => {
      await client.connect();
      await client.db().command({ ping: 1 });
      return `connected to database "${client.db().databaseName}"`;
    });

    await check('mongo: replica set primary', async () => {
      const hello = await client.db().command({ hello: 1 });
      if (hello.setName !== 'rs0' || hello.isWritablePrimary !== true) {
        throw new Error(`unexpected topology: setName=${String(hello.setName)}`);
      }
      return 'rs0, writable primary';
    });

    await check('mongo: transaction commit', async () => {
      const coll = client.db().collection<{ _id: string; at: Date }>('_infra_check');
      const id = randomUUID();
      const session = client.startSession();
      try {
        await session.withTransaction(async () => {
          await coll.insertOne({ _id: id, at: new Date() }, { session });
        });
      } finally {
        await session.endSession();
      }
      const found = await coll.findOne({ _id: id });
      await coll.deleteOne({ _id: id });
      await client
        .db()
        .dropCollection('_infra_check')
        .catch(() => undefined);
      if (!found) throw new Error('document written in transaction was not found');
      return 'insert in transaction, read back, cleaned up';
    });

    // Note: listDatabases is NOT a valid denial test. MongoDB lets any
    // authenticated user run it and filters the result to databases the user
    // can access (authorizedDatabases), so it succeeds without leaking anything.
    await check('mongo: app user cannot read admin.system.users', () =>
      expectRejected(
        client.db('admin').collection('system.users').findOne({}),
        /not authorized|Unauthorized/i,
      ),
    );

    await check('mongo: app user cannot write to another database', () =>
      expectRejected(
        client.db('streamhub_other').collection('probe').insertOne({ at: new Date() }),
        /not authorized|Unauthorized/i,
      ),
    );
  } finally {
    await client.close();
  }
}

async function verifyRedis(): Promise<void> {
  const redis = new Redis(env('REDIS_URL'), {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 5000,
  });
  try {
    await check('redis: auth + ping', async () => {
      await redis.connect();
      const pong: string = await redis.ping();
      if (pong !== 'PONG') throw new Error(`unexpected reply ${pong}`);
      return 'PONG';
    });

    await check('redis: set/get with TTL', async () => {
      const key = `infra-check:${randomUUID()}`;
      await redis.set(key, 'ok', 'EX', 30);
      const value = await redis.get(key);
      await redis.del(key);
      if (value !== 'ok') throw new Error(`read back ${String(value)}`);
      return 'round trip ok';
    });

    await check('redis: maxmemory-policy is noeviction (BullMQ requirement)', async () => {
      const reply = await redis.config('GET', 'maxmemory-policy');
      if (reply[1] !== 'noeviction') throw new Error(`policy is ${String(reply[1])}`);
      return 'noeviction';
    });

    await check('redis: unauthenticated connection rejected', async () => {
      // ioredis 6 negotiates the protocol (HELLO) during connect, so without a
      // password Redis rejects the handshake itself, before any command runs.
      const url = new URL(env('REDIS_URL'));
      const anon = new Redis({
        host: url.hostname,
        port: Number(url.port),
        lazyConnect: true,
        maxRetriesPerRequest: 0,
        retryStrategy: () => null,
      });
      const errors: string[] = [];
      anon.on('error', (err: Error) => errors.push(err.message));
      try {
        await anon.connect();
        await anon.ping();
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      } finally {
        anon.disconnect();
      }
      if (errors.some((m) => /NOAUTH/i.test(m))) return 'rejected with NOAUTH';
      throw new Error(
        errors.length
          ? `unexpected error: ${errors.join(' | ')}`
          : 'unauthenticated PING succeeded',
      );
    });
  } finally {
    redis.disconnect();
  }
}

async function verifyStorage(): Promise<void> {
  const endpoint = env('S3_ENDPOINT');
  const s3 = new S3Client({
    endpoint,
    region: env('S3_REGION'),
    forcePathStyle: env('S3_FORCE_PATH_STYLE') === 'true',
    credentials: {
      accessKeyId: env('S3_ACCESS_KEY_ID'),
      secretAccessKey: env('S3_SECRET_ACCESS_KEY'),
    },
  });
  const buckets = [env('S3_BUCKET_UPLOADS'), env('S3_BUCKET_MEDIA')];

  for (const bucket of buckets) {
    await check(`storage: bucket "${bucket}" reachable with app credentials`, async () => {
      await s3.send(new HeadBucketCommand({ Bucket: bucket }));
      return 'exists';
    });
  }

  const bucket = buckets[0] ?? '';
  const key = `_infra-check/${randomUUID()}.txt`;
  await check('storage: put/get/delete object', async () => {
    await s3.send(
      new PutObjectCommand({ Bucket: bucket, Key: key, Body: 'hello', ContentType: 'text/plain' }),
    );
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = await res.Body?.transformToString();
    if (body !== 'hello') throw new Error(`read back ${String(body)}`);
    return 'round trip ok';
  });

  await check('storage: anonymous read denied (bucket is private)', async () => {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: 'secret' }));
    try {
      const res = await fetch(`${endpoint}/${bucket}/${key}`);
      if (res.status !== 403) throw new Error(`expected 403, got ${res.status}`);
      return '403 Forbidden';
    } finally {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    }
  });

  await check('storage: app user cannot create buckets (least privilege)', () =>
    expectRejected(
      s3.send(new CreateBucketCommand({ Bucket: `should-not-exist-${Date.now()}` })),
      /AccessDenied|Access Denied/i,
    ),
  );

  s3.destroy();
}

async function verifyMail(): Promise<void> {
  const subject = `infra-check ${randomUUID()}`;
  const apiUrl = env('MAILPIT_API_URL');

  await check('mail: send via SMTP and receive in Mailpit', async () => {
    const transport = nodemailer.createTransport({
      host: env('SMTP_HOST'),
      port: Number(env('SMTP_PORT')),
      secure: env('SMTP_SECURE') === 'true',
    });
    await transport.sendMail({
      from: env('MAIL_FROM'),
      to: 'infra-check@streamhub.local',
      subject,
      text: 'StreamHub infrastructure check',
    });
    transport.close();

    // Mailpit indexes asynchronously; poll briefly.
    for (let attempt = 0; attempt < 10; attempt++) {
      const res = await fetch(
        `${apiUrl}/api/v1/search?query=${encodeURIComponent(`subject:"${subject}"`)}`,
      );
      const data = (await res.json()) as { messages?: { ID: string }[] };
      const id = data.messages?.[0]?.ID;
      if (id) {
        await fetch(`${apiUrl}/api/v1/messages`, {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ IDs: [id] }),
        });
        return 'delivered and found via API, then deleted';
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error('message not found in Mailpit after 3s');
  });
}

async function main(): Promise<void> {
  await verifyMongo();
  await verifyRedis();
  await verifyStorage();
  await verifyMail();

  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width)}  ${r.detail}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
