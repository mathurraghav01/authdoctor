import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Configure before importing the module under test: config.ts reads the
// environment once at import time.
process.env.AI_BASE_URL = 'http://model.test/v1';
process.env.AI_MODEL = 'test-model';
process.env.AI_API_KEY = 'test-key';
process.env.AI_TIMEOUT_MS = '5000';

const { AiError, diagnoseWithModel } = await import('../services/ai.js');

const validDiagnosis = {
  title: '401 Unauthorized - the bearer token has expired',
  summary:
    'The API rejected the request because the supplied access token expired before the call was made. Refresh the credential and retry.',
  likelyCause: { cause: 'The bearer token passed its exp claim.', confidence: 'high', rationale: 'The decoded exp claim is in the past.' },
  confidence: 0.94,
  evidence: [
    { source: 'token', detail: 'exp claim is in the past', verified: true },
    { source: 'status', detail: 'Response status is 401 Unauthorized.', verified: true },
  ],
  alternatives: [{ cause: 'Clock skew on the client', likelihood: 'low', note: 'Would produce a near-boundary expiry.' }],
  steps: [
    { title: 'Refresh the token', detail: 'Request a new access token.' },
    { title: 'Retry the request', detail: 'Replay the call and confirm a 200.' },
  ],
  fix: { summary: 'Refresh before expiry.', code: { language: 'typescript', content: 'const token = await refresh();' }, notes: [] },
  curl: "curl -i 'https://api.example.com/x' -H 'Authorization: Bearer $ACCESS_TOKEN'",
  securityRisks: [{ risk: 'Token lifetime too short', severity: 'low', detail: 'Consider a refresh flow.' }],
  verifiedFindings: ['exp claim is in the past'],
  likelyFindings: ['Clock skew'],
  needsMoreInfo: [],
};

const input = {
  method: 'POST',
  url: 'https://api.acme.dev/v1/invoices/8412/approve',
  statusCode: 401,
  requestHeaders: 'Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE3NjE1NDAwMDB9.sig\nX-Api-Key: sk-live-FAKEFAKEFAKEFAKEFAKE1234',
  requestBody: '{"amount_cents":24900}',
  responseBody: '{"error":"invalid_token"}',
  errorMessage: 'Request failed with status code 401',
  logs: '',
};

function completion(content: string) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('model diagnosis', () => {
  it('returns a schema-valid diagnosis with the model name', async () => {
    fetchMock.mockResolvedValueOnce(completion(JSON.stringify(validDiagnosis)));
    const result = await diagnoseWithModel(input);
    expect(result.model).toBe('test-model');
    expect(result.diagnosis.title).toMatch(/expired/i);
    expect(result.notes.some((note) => note.includes('repaired'))).toBe(false);
  });

  it('recovers JSON wrapped in markdown fences or prose', async () => {
    fetchMock.mockResolvedValueOnce(completion('```json\n' + JSON.stringify(validDiagnosis) + '\n```'));
    const fenced = await diagnoseWithModel(input);
    expect(fenced.diagnosis.confidence).toBeGreaterThan(0);

    fetchMock.mockResolvedValueOnce(completion('Sure, here it is:\n' + JSON.stringify(validDiagnosis) + '\nHope that helps.'));
    const prose = await diagnoseWithModel(input);
    expect(prose.diagnosis.title).toMatch(/expired/i);
  });

  it('repairs once when the first response fails the schema', async () => {
    fetchMock
      .mockResolvedValueOnce(completion(JSON.stringify({ title: 'broken', summary: 'too short' })))
      .mockResolvedValueOnce(completion(JSON.stringify(validDiagnosis)));

    const result = await diagnoseWithModel(input);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.notes.some((note) => /repaired/i.test(note))).toBe(true);
    expect(result.diagnosis.title).toMatch(/expired/i);
  });

  it('throws invalid_output when the repair also fails', async () => {
    fetchMock.mockImplementation(() => completion(JSON.stringify({ title: 'broken', summary: 'too short' })));
    await expect(diagnoseWithModel(input)).rejects.toMatchObject({ code: 'invalid_output' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('maps a provider HTTP error to an upstream failure', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'model exploded' } }), { status: 500 }),
    );
    await expect(diagnoseWithModel(input)).rejects.toMatchObject({ code: 'upstream' });
  });

  it('maps a missing completion to an upstream failure', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ choices: [] }), { status: 200 }));
    await expect(diagnoseWithModel(input)).rejects.toBeInstanceOf(AiError);
  });

  it('reports an aborted request as a timeout', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    fetchMock.mockRejectedValueOnce(abort);
    await expect(diagnoseWithModel(input)).rejects.toMatchObject({ code: 'timeout' });
  });

  it('never sends credentials to the model', async () => {
    fetchMock.mockResolvedValueOnce(completion(JSON.stringify(validDiagnosis)));
    await diagnoseWithModel(input);

    const sent = JSON.stringify(fetchMock.mock.calls[0][1].body);
    expect(sent).not.toContain('eyJhbGciOiJSUzI1NiIs');
    expect(sent).not.toContain('sk-live-FAKE');
    expect(sent).toContain('[REDACTED:authorization]');
    expect(sent).toContain('[REDACTED:api-key]');
  });

  it('caps confidence when the model claims certainty without evidence', async () => {
    fetchMock.mockResolvedValueOnce(
      completion(JSON.stringify({ ...validDiagnosis, confidence: 0.99, evidence: [{ source: 'status', detail: 'status is 401', verified: false }, { source: 'request', detail: 'no headers supplied', verified: false }] })),
    );
    const result = await diagnoseWithModel(input);
    expect(result.diagnosis.confidence).toBeLessThanOrEqual(0.6);
  });

  it('strips a literal token from a model-generated curl command', async () => {
    const leaked = 'curl -i https://x -H \'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123\'';
    fetchMock.mockResolvedValueOnce(completion(JSON.stringify({ ...validDiagnosis, curl: leaked })));
    const result = await diagnoseWithModel(input);
    expect(result.diagnosis.curl).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(result.diagnosis.curl).toContain('$ACCESS_TOKEN');
  });
});