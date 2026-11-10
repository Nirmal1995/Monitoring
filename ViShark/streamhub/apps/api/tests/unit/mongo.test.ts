import { describe, expect, it } from 'vitest';
import { redactMongoUrl } from '../../src/database/mongo.ts';

describe('redactMongoUrl', () => {
  it('removes username and password', () => {
    const out = redactMongoUrl(
      'mongodb://app:topsecret@127.0.0.1:27017/streamhub?authSource=streamhub',
    );
    expect(out).toBe('mongodb://***:***@127.0.0.1:27017/streamhub?authSource=streamhub');
    expect(out).not.toContain('topsecret');
  });

  it('handles SRV URLs and URLs without credentials', () => {
    expect(redactMongoUrl('mongodb+srv://u:p@cluster0.example.net/db')).toBe(
      'mongodb+srv://***:***@cluster0.example.net/db',
    );
    expect(redactMongoUrl('mongodb://127.0.0.1:27017/db')).toBe('mongodb://127.0.0.1:27017/db');
  });
});
