import { describe, expect, it } from 'vitest';
import { diagnosisInputSchema } from '../schema.js';
import { runLocalDiagnosis } from '../services/localEngine.js';
import { analyzeAuthorization, parseHeaders } from '../utils/request.js';
import { redactInput } from '../utils/redact.js';

const NOW = new Date('2026-10-26T12:00:00Z').getTime();

function makeJwt(payload: Record<string, unknown>, header: Record<string, unknown> = { alg: 'HS256', typ: 'JWT' }) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode(header)}.${encode(payload)}.signature`;
}

function input(overrides: Record<string, unknown>) {
  return diagnosisInputSchema.parse(overrides);
}

describe('JWT analysis', () => {
  it('detects an expired token from the exp claim', () => {
    const token = makeJwt({ sub: 'user_1', exp: Math.floor(NOW / 1000) - 3600, iss: 'https://auth.example.com' });
    const result = analyzeAuthorization(parseHeaders(`Authorization: Bearer ${token}`), NOW);
    expect(result.present).toBe(true);
    expect(result.expired).toBe(true);
    expect(result.secondsUntilExpiry).toBeLessThan(0);
    expect(result.issuer).toBe('https://auth.example.com');
  });

  it('reports a valid token as not expired', () => {
    const token = makeJwt({ sub: 'user_1', exp: Math.floor(NOW / 1000) + 3600 });
    expect(analyzeAuthorization(parseHeaders(`Authorization: Bearer ${token}`), NOW).expired).toBe(false);
  });

  it('flags malformed and opaque values', () => {
    expect(analyzeAuthorization(parseHeaders('Authorization: Bearer abc.def.ghi'), NOW).malformed).toBe(true);
    expect(analyzeAuthorization(parseHeaders('Authorization: Bearer opaque-token-value'), NOW).opaque).toBe(true);
    expect(analyzeAuthorization(parseHeaders('Accept: */*'), NOW).present).toBe(false);
  });

  it('extracts scopes from a space-delimited scope claim', () => {
    const token = makeJwt({ exp: Math.floor(NOW / 1000) + 60, scope: 'invoices.read invoices.write' });
    expect(analyzeAuthorization(parseHeaders(`Authorization: Bearer ${token}`), NOW).scopes).toEqual(['invoices.read', 'invoices.write']);
  });
});

describe('local diagnosis engine', () => {
  it('diagnoses an expired 401 and verifies the expiry locally', () => {
    const token = makeJwt({ sub: 'user_1', exp: Math.floor(NOW / 1000) - 60 });
    const parsed = input({
      method: 'POST',
      url: 'https://api.example.com/v1/invoices',
      statusCode: 401,
      requestHeaders: `Authorization: Bearer ${token}\nContent-Type: application/json`,
      responseBody: JSON.stringify({ error: 'invalid_token', message: 'The access token expired' }),
    });
    const diagnosis = runLocalDiagnosis(parsed, NOW);
    expect(diagnosis.title).toContain('401');
    expect(diagnosis.likelyCause.cause.toLowerCase()).toContain('expired');
    expect(diagnosis.confidence).toBeGreaterThan(0.9);
    expect(diagnosis.evidence.some((item) => item.source === 'token' && item.verified)).toBe(true);
    expect(diagnosis.verifiedFindings.join(' ')).toContain('exp');
    expect(diagnosis.curl).toContain('$ACCESS_TOKEN');
    expect(diagnosis.curl).not.toContain('eyJ');
  });

  it('distinguishes 403 from 401 and never tells the user to refresh the token', () => {
    const token = makeJwt({ exp: Math.floor(NOW / 1000) + 600, scope: 'invoices.read' });
    const parsed = input({
      method: 'GET',
      url: 'https://api.example.com/v1/invoices/42',
      statusCode: 403,
      requestHeaders: `Authorization: Bearer ${token}`,
      responseBody: JSON.stringify({ error: 'insufficient_scope', required: 'invoices.write' }),
    });
    const diagnosis = runLocalDiagnosis(parsed, NOW);
    expect(diagnosis.title).toContain('403');
    expect(diagnosis.likelyCause.cause).toContain('scope');
    expect(diagnosis.fix.summary.toLowerCase()).not.toContain('refresh the token');
    expect(diagnosis.evidence.some((item) => item.detail.includes('invoices.read'))).toBe(true);
  });

  it('uses Retry-After evidence for 429', () => {
    const parsed = input({
      statusCode: 429,
      requestHeaders: 'Retry-After: 30\nX-RateLimit-Remaining: 0',
      responseBody: '{"error":"rate_limited"}',
    });
    const diagnosis = runLocalDiagnosis(parsed, NOW);
    expect(diagnosis.likelyCause.cause).toContain('rate');
    expect(diagnosis.summary).toContain('30 seconds');
    expect(diagnosis.evidence.some((item) => item.detail.includes('Retry-After'))).toBe(true);
  });

  it('stays low confidence for a bare 500 without logs', () => {
    const parsed = input({ statusCode: 500, responseBody: 'Internal Server Error' });
    const diagnosis = runLocalDiagnosis(parsed, NOW);
    expect(diagnosis.confidence).toBeLessThan(0.6);
    expect(diagnosis.needsMoreInfo.length).toBeGreaterThan(0);
    expect(diagnosis.summary.toLowerCase()).toContain('server');
  });

  it('detects timeouts instead of inventing a status code', () => {
    const parsed = input({ url: 'https://api.example.com/slow', errorMessage: 'request timed out after 10000ms (ETIMEDOUT)' });
    const diagnosis = runLocalDiagnosis(parsed, NOW);
    expect(diagnosis.title.toLowerCase()).toContain('timeout');
    expect(diagnosis.evidence[0]?.source).toBe('network');
  });

  it('handles a missing Authorization header', () => {
    const parsed = input({ statusCode: 401, url: 'https://api.example.com/me', responseBody: '{"message":"Unauthorized"}' });
    const diagnosis = runLocalDiagnosis(parsed, NOW);
    expect(diagnosis.likelyCause.cause).toContain('no Authorization header');
    expect(diagnosis.steps.some((step) => step.title.toLowerCase().includes('add the authorization header'))).toBe(true);
  });

  it('always returns a schema-valid diagnosis', () => {
    const parsed = input({ statusCode: 418, responseBody: 'teapot' });
    const diagnosis = runLocalDiagnosis(parsed, NOW);
    expect(diagnosis.steps.length).toBeGreaterThanOrEqual(2);
    expect(diagnosis.evidence.length).toBeGreaterThanOrEqual(1);
    expect(diagnosis.confidence).toBeGreaterThan(0);
    expect(diagnosis.confidence).toBeLessThanOrEqual(1);
  });
});

describe('redactInput', () => {
  it('redacts every field and reports findings', () => {
    const parsed = input({
      statusCode: 401,
      requestHeaders: 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjF9.sig',
      requestBody: '{"password":"hunter2"}',
      responseBody: '{"error":"invalid_token"}',
      errorMessage: 'request failed with sk-live_abcdefghijklmnop',
      logs: 'cookie=session-abc',
    });
    const { input: redacted, findings } = redactInput(parsed);
    expect(redacted.requestHeaders).not.toContain('eyJ');
    expect(redacted.requestBody).not.toContain('hunter2');
    expect(redacted.errorMessage).not.toContain('sk-live_abcdefghijklmnop');
    expect(findings.length).toBeGreaterThanOrEqual(3);
  });
});

describe('diagnosis precedence', () => {
  it('keeps a 500 as a server error even when logs mention a dependency timeout', () => {
    const parsed = input({
      statusCode: 500,
      responseBody: '{"error":"internal_error"}',
      logs: [
        "TypeError: Cannot read properties of null (reading 'currency')",
        '    at capturePayment (/srv/app/src/payments/capture.ts:84:31)',
        'Caused by: RedisError: Connection timeout (cache.internal:6379, 5000ms)',
      ].join('\n'),
    });
    const diagnosis = runLocalDiagnosis(parsed, NOW);
    expect(diagnosis.title).toContain('500');
    expect(diagnosis.title.toLowerCase()).not.toContain('timeout');
    expect(diagnosis.evidence.some((item) => item.source === 'logs')).toBe(true);
  });

  it('still treats a missing status with a timeout message as a transport failure', () => {
    const parsed = input({ errorMessage: 'read ETIMEDOUT' });
    const diagnosis = runLocalDiagnosis(parsed, NOW);
    expect(diagnosis.title.toLowerCase()).toContain('timeout');
  });
});
