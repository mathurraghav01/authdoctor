import { describe, expect, it } from 'vitest';
import { extractJsonObject } from '../services/ai.js';
import { detectIntent, runLocalAssistant } from '../services/assistant.js';
import { diagnosisInputSchema } from '../schema.js';

describe('extractJsonObject', () => {
  it('parses plain JSON', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it('strips markdown fences', () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('recovers JSON surrounded by prose', () => {
    expect(extractJsonObject('Here is the diagnosis:\n{"a":{"b":"}"}}\nHope that helps.')).toEqual({ a: { b: '}' } });
  });

  it('throws on truncated JSON', () => {
    expect(() => extractJsonObject('{"a": {')).toThrow(/truncated|no JSON/i);
  });
});

describe('assistant intent routing', () => {
  it('routes natural commands to workspace actions', () => {
    expect(detectIntent('Diagnose this 401 error.')).toBe('diagnose');
    expect(detectIntent('Generate a corrected curl command')).toBe('curl');
    expect(detectIntent('Show me the difference between 401 and 403')).toBe('compare');
    expect(detectIntent('What should I check next?')).toBe('next-steps');
    expect(detectIntent('Is it safe to paste this token?')).toBe('redaction');
  });

  it('answers status comparison without a loaded request', () => {
    const result = runLocalAssistant('What is the difference between 401 and 403?', null, null);
    expect(result.reply).toContain('401');
    expect(result.reply).toContain('403');
    expect(result.reply).toContain('refresh');
  });

  it('asks for input when there is nothing to diagnose', () => {
    const result = runLocalAssistant('Diagnose this 401 error.', null, null);
    expect(result.reply.toLowerCase()).toContain('nothing to diagnose');
    expect(result.diagnosis).toBeNull();
  });

  it('produces a curl command from the loaded request', () => {
    const context = diagnosisInputSchema.parse({
      method: 'POST',
      url: 'https://api.example.com/v1/invoices',
      statusCode: 401,
      requestHeaders: 'Authorization: Bearer expired-token-value\nContent-Type: application/json',
      requestBody: '{"amount":100}',
    });
    const result = runLocalAssistant('generate a corrected curl command', context, null);
    expect(result.reply).toContain('curl');
    expect(result.reply).toContain('$ACCESS_TOKEN');
    expect(result.reply).toContain('--data-raw');
    expect(result.reply).not.toContain('expired-token-value');
  });

  it('reports redactions from the loaded context', () => {
    const context = diagnosisInputSchema.parse({
      statusCode: 401,
      requestHeaders: 'Authorization: Bearer abcdefghijklmnop',
    });
    const result = runLocalAssistant('show me the redaction report', context, null);
    expect(result.reply).toContain('[REDACTED:authorization]');
    expect(result.reply).toContain('authorization');
  });
});

describe('assistant status explanation', () => {
  it('explains the code the user asked about, even when another request is loaded', () => {
    const loaded = diagnosisInputSchema.parse({
      method: 'POST',
      url: 'https://api.acme.dev/v1/invoices/8412/approve',
      statusCode: 401,
      requestHeaders: 'Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.eyJleHAiOjE3NjE1NDAwMDB9.sig',
      responseBody: '{"error":"invalid_token"}',
      errorMessage: '401',
    });
    const result = runLocalAssistant('What does 429 mean?', loaded, null);
    expect(result.actions.map((action) => action.name)).toContain('explain');
    expect(result.reply).toContain('429');
    expect(result.reply).not.toMatch(/401 Unauthorized —/);
  });
});
