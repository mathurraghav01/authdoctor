import type { ChatResponse, DiagnosisResponse, ProviderStatus, RequestDraft } from './types';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details?: string[],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit, timeoutMs = 60_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(path, {
      ...init,
      headers: { 'content-type': 'application/json', ...init?.headers },
      signal: controller.signal,
    });

    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new ApiError('The server returned a non-JSON response.', response.status);
      }
    }

    if (!response.ok) {
      const body = (payload ?? {}) as { error?: string; details?: string[] };
      throw new ApiError(body.error ?? `Request failed with status ${response.status}.`, response.status, body.details);
    }

    return payload as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ApiError('The request timed out. The model may be slow — try again.', 0);
    }
    throw new ApiError(
      'Could not reach the AuthDoctor API. Is the server running on port 8787?',
      0,
    );
  } finally {
    clearTimeout(timer);
  }
}

export function draftToPayload(draft: RequestDraft) {
  const code = draft.statusCode.trim();
  return {
    method: draft.method,
    url: draft.url,
    statusCode: code === '' ? null : Number(code),
    requestHeaders: draft.requestHeaders,
    requestBody: draft.requestBody,
    responseBody: draft.responseBody,
    errorMessage: draft.errorMessage,
    logs: draft.logs,
  };
}

export function diagnose(draft: RequestDraft) {
  return request<DiagnosisResponse>('/api/diagnose', {
    method: 'POST',
    body: JSON.stringify(draftToPayload(draft)),
  });
}

export function sendChat(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  draft: RequestDraft | null,
  diagnosis: DiagnosisResponse | null,
) {
  return request<ChatResponse>(
    '/api/chat',
    {
      method: 'POST',
      body: JSON.stringify({
        messages,
        context: draft ? draftToPayload(draft) : undefined,
        diagnosis: diagnosis?.diagnosis ?? null,
      }),
    },
    90_000,
  );
}

export function getProvider() {
  return request<{ provider: ProviderStatus }>('/api/health', { method: 'GET' }, 8_000).then((health) => health.provider);
}
