import { describe, expect, it } from 'vitest';
import { mergeFindings, redactHeaders, redactText } from '../utils/redact.js';

describe('redactHeaders', () => {
  it('redacts bearer tokens and keeps the scheme', () => {
    const result = redactHeaders('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature\nAccept: application/json');
    expect(result.text).toContain('Authorization: Bearer [REDACTED:authorization]');
    expect(result.text).toContain('Accept: application/json');
    expect(result.text).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(result.findings).toEqual([{ field: 'headers', kind: 'authorization', count: 1 }]);
  });

  it('redacts cookies, api keys and basic auth', () => {
    const result = redactHeaders('Cookie: session=abc123\nX-Api-Key: super-secret-key\nProxy-Authorization: Basic dXNlcjpwYXNz');
    expect(result.text).not.toContain('abc123');
    expect(result.text).not.toContain('super-secret-key');
    expect(result.text).not.toContain('dXNlcjpwYXNz');
    expect(result.text).toContain('[REDACTED:cookie]');
    expect(result.text).toContain('[REDACTED:api-key]');
  });

  it('leaves non-sensitive headers untouched', () => {
    const raw = 'Content-Type: application/json\nX-Request-Id: 8f2c';
    expect(redactHeaders(raw).text).toBe(raw);
  });
});

describe('redactText', () => {
  it('redacts sensitive JSON fields structurally', () => {
    const raw = JSON.stringify({ username: 'ada', password: 'hunter2', access_token: 'abc.def.ghi', nested: { client_secret: 'shhh' } }, null, 2);
    const result = redactText(raw);
    expect(result.text).toContain('"username": "ada"');
    expect(result.text).toContain('"password": "[REDACTED:password]"');
    expect(result.text).toContain('"client_secret": "[REDACTED:password]"');
    expect(result.text).not.toContain('hunter2');
    expect(result.text).not.toContain('shhh');
  });

  it('redacts known token shapes in free text and logs', () => {
    const raw = 'error: invalid key sk-live_1234567890abcdefghij and github token ghp_abcdefghijklmnopqrstuvwx';
    const result = redactText(raw);
    expect(result.text).not.toContain('sk-live_1234567890abcdefghij');
    expect(result.text).not.toContain('ghp_abcdefghijklmnopqrstuvwx');
    expect(result.text).toContain('[REDACTED:api-key]');
  });

  it('redacts secrets in query strings', () => {
    const result = redactText('GET https://api.example.com/cb?code=xyz&access_token=secret-value&state=1');
    expect(result.text).not.toContain('secret-value');
    expect(result.text).toContain('access_token=[REDACTED:token]');
    expect(result.text).toContain('state=1');
  });

  it('redacts connection strings and private keys', () => {
    const raw = 'db=postgres://user:pass@db.internal:5432/app\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----';
    const result = redactText(raw);
    expect(result.text).not.toContain('user:pass@db.internal');
    expect(result.text).not.toContain('MIIEow');
    expect(result.text).toContain('[REDACTED:connection-string]');
    expect(result.text).toContain('[REDACTED:private-key]');
  });

  it('keeps empty values readable instead of flagging them', () => {
    const result = redactText('Authorization:\nX-Request-Id: 123');
    expect(result.findings).toHaveLength(0);
    expect(result.text).toContain('Authorization:');
  });

  it('is idempotent', () => {
    const once = redactText('Authorization: Bearer abcdefghijklmnop').text;
    const twice = redactText(once).text;
    expect(twice).toBe(once);
  });
});

describe('mergeFindings', () => {
  it('combines counts by field and kind', () => {
    const merged = mergeFindings(
      [{ field: 'headers', kind: 'authorization', count: 1 }],
      [{ field: 'headers', kind: 'authorization', count: 2 }],
      [{ field: 'content', kind: 'api-key', count: 1 }],
    );
    expect(merged).toEqual([
      { field: 'headers', kind: 'authorization', count: 3 },
      { field: 'content', kind: 'api-key', count: 1 },
    ]);
  });
});
