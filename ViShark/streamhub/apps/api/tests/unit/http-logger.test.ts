import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildTestApp, capturingLogger } from '../helpers.ts';

describe('request logging', () => {
  it('logs the full path for routes mounted under a prefix (regression)', async () => {
    const { logger, lines } = capturingLogger();
    const { app } = buildTestApp({ logger });
    await request(app).get('/api/docs/swagger-ui.css');
    const line = lines.find((l) => l.msg?.includes('swagger-ui.css'));
    expect(line?.msg).toMatch(/^GET \/api\/docs\/swagger-ui\.css 200 \d+ms$/);
    expect(line?.req).toMatchObject({ path: '/api/docs/swagger-ui.css' });
  });

  it('drops the query string (it can contain tokens)', async () => {
    const { logger, lines } = capturingLogger();
    const { app } = buildTestApp({ logger });
    await request(app).get('/api/v1?token=super-secret-reset-token');
    expect(JSON.stringify(lines)).not.toContain('super-secret-reset-token');
    expect(lines.some((l) => l.msg?.startsWith('GET /api/v1 200'))).toBe(true);
  });

  it('logs 4xx as warn with request and correlation IDs', async () => {
    const { logger, lines } = capturingLogger();
    const { app } = buildTestApp({ logger });
    const res = await request(app).get('/nope').set('X-Correlation-Id', 'action-1234567');
    const line = lines.find((l) => l.msg?.startsWith('GET /nope 404'));
    expect(line).toMatchObject({ level: 'warn', correlationId: 'action-1234567' });
    expect(line?.req).toMatchObject({ id: res.headers['x-request-id'] });
  });

  it('does not log health probes', async () => {
    const { logger, lines } = capturingLogger();
    const { app } = buildTestApp({ logger });
    await request(app).get('/health/live');
    expect(lines.filter((l) => l.msg?.includes('/health'))).toHaveLength(0);
  });

  it('redacts cookies, authorization headers and password fields', () => {
    const { logger, lines } = capturingLogger();
    logger.info(
      {
        req: { headers: { cookie: 'sid=abc', authorization: 'Bearer xyz' } },
        body: { password: 'hunter2' },
      },
      'manual',
    );
    expect(JSON.stringify(lines)).not.toMatch(/sid=abc|Bearer xyz|hunter2/);
    expect(JSON.stringify(lines)).toContain('[REDACTED]');
  });
});
