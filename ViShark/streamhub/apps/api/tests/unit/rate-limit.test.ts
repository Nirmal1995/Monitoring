import { describe, expect, it } from 'vitest';
import { clientKey } from '../../src/middleware/rate-limit.ts';

describe('clientKey', () => {
  it('uses IPv4 addresses as they are', () => {
    expect(clientKey('203.0.113.7')).toBe('203.0.113.7');
  });

  it('unwraps IPv4-mapped IPv6 addresses', () => {
    expect(clientKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('groups IPv6 addresses by /64 so rotating addresses does not evade the limit', () => {
    const a = clientKey('2001:db8:abcd:12::1');
    const b = clientKey('2001:0db8:abcd:0012:ffff:ffff:ffff:ffff');
    expect(a).toBe('2001:0db8:abcd:0012::/64');
    expect(b).toBe(a);
    expect(clientKey('2001:db8:abcd:13::1')).not.toBe(a);
  });

  it('handles loopback and missing values', () => {
    expect(clientKey('::1')).toBe('0000:0000:0000:0000::/64');
    expect(clientKey(undefined)).toBe('unknown');
  });
});
