import { config } from '../config.js';
import { diagnosisSchema, type Diagnosis, type DiagnosisInput } from '../schema.js';
import { statusText } from './localEngine.js';

export class AiError extends Error {
  constructor(
    message: string,
    readonly code: 'not_configured' | 'timeout' | 'upstream' | 'invalid_output',
  ) {
    super(message);
    this.name = 'AiError';
  }
}

const SYSTEM_PROMPT = `You are AuthDoctor, a senior backend engineer who debugs failed HTTP API requests.

You receive a redacted HTTP request/response bundle. Credentials appear as [REDACTED:...] placeholders — never invent their values.

Rules:
- Reply with ONE JSON object only. No markdown fences, no prose outside the JSON.
- Diagnose from the supplied evidence. Do not invent headers, logs or server behaviour that were not supplied.
- Mark evidence.verified = true ONLY for facts directly visible in the supplied material (status code, header, error code, log line, decoded token claim). Anything inferred must be verified = false.
- The "likelyCause" is a hypothesis. Confidence must reflect missing evidence: without logs or a response body, confidence must not exceed 0.6.
- Distinguish authentication (401) from authorization (403) precisely.
- "steps" are ordered debugging actions a developer can perform. Include a shell command only when it is safe and directly useful.
- "fix" explains the change; optional code must be reviewable. NEVER claim a fix was applied or tested — you cannot execute requests.
- "curl" must use environment variables ($ACCESS_TOKEN, $API_KEY) for credentials, never a literal secret.
- "securityRisks" covers credential handling, over-broad scopes, token lifetime, exposed stack traces, disabled TLS verification.
- If the supplied material is insufficient, say so in "needsMoreInfo" instead of guessing.

JSON shape:
{
  "title": "short headline, max 120 chars",
  "summary": "2-4 sentences explaining the failure",
  "likelyCause": { "cause": "one sentence", "confidence": "high|medium|low", "rationale": "why" },
  "confidence": 0.0-1.0,
  "evidence": [{ "source": "status|request|response|logs|token|network", "detail": "what it shows", "verified": true|false }],
  "alternatives": [{ "cause": "...", "likelihood": "high|medium|low", "note": "..." }],
  "steps": [{ "title": "...", "detail": "...", "command": "optional shell command" }],
  "fix": { "summary": "...", "code": { "language": "...", "content": "..." }, "notes": ["..."] },
  "curl": "corrected curl command or null",
  "securityRisks": [{ "risk": "...", "severity": "high|medium|low", "detail": "..." }],
  "verifiedFindings": ["facts proven by the supplied material"],
  "likelyFindings": ["hypotheses worth checking"],
  "needsMoreInfo": ["what would raise confidence"]
}`;

function buildUserPrompt(input: DiagnosisInput): string {
  return JSON.stringify(
    {
      method: input.method,
      url: input.url,
      statusCode: input.statusCode,
      statusText: statusText(input.statusCode),
      requestHeaders: input.requestHeaders,
      requestBody: input.requestBody,
      responseBody: input.responseBody,
      errorMessage: input.errorMessage,
      serverLogs: input.logs,
    },
    null,
    2,
  );
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  error?: { message?: string };
}

async function callChat(
  messages: Array<{ role: string; content: string }>,
  temperature: number,
  json = true,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.ai.timeoutMs);

  try {
    const response = await fetch(`${config.ai.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.ai.apiKey ? { authorization: `Bearer ${config.ai.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.ai.model,
        messages,
        temperature,
        max_tokens: config.ai.maxTokens,
        ...(json ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: controller.signal,
    });

    const text = await response.text();

    if (!response.ok) {
      let detail = text.slice(0, 400);
      try {
        const parsed = JSON.parse(text) as ChatCompletionResponse;
        if (parsed.error?.message) detail = parsed.error.message;
      } catch {
        // keep the raw snippet
      }
      throw new AiError(`Model request failed with HTTP ${response.status}: ${detail}`, 'upstream');
    }

    let parsed: ChatCompletionResponse;
    try {
      parsed = JSON.parse(text) as ChatCompletionResponse;
    } catch {
      throw new AiError('Model returned a non-JSON response body.', 'upstream');
    }

    const content = parsed.choices?.[0]?.message?.content;
    if (!content || typeof content !== 'string') {
      throw new AiError('Model returned an empty completion.', 'upstream');
    }
    return content;
  } catch (error) {
    if (error instanceof AiError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new AiError(`Model did not respond within ${Math.round(config.ai.timeoutMs / 1000)}s.`, 'timeout');
    }
    throw new AiError(error instanceof Error ? error.message : 'Unknown model error.', 'upstream');
  } finally {
    clearTimeout(timer);
  }
}

/** Models occasionally wrap JSON in fences or prose; recover the object. */
export function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to brace scanning
  }

  const start = trimmed.indexOf('{');
  if (start === -1) throw new AiError('Model response contained no JSON object.', 'invalid_output');

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < trimmed.length; i++) {
    const char = trimmed[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) {
        const candidate = trimmed.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          throw new AiError('Model JSON could not be parsed.', 'invalid_output');
        }
      }
    }
  }
  throw new AiError('Model JSON was truncated.', 'invalid_output');
}

export interface ModelDiagnosisResult {
  diagnosis: Diagnosis;
  model: string;
  notes: string[];
}

export async function diagnoseWithModel(input: DiagnosisInput): Promise<ModelDiagnosisResult> {
  if (!config.ai.baseUrl || !config.ai.model) {
    throw new AiError('No model provider is configured.', 'not_configured');
  }

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserPrompt(input) },
  ];

  const first = await callChat(messages, 0.2);
  const notes: string[] = [];

  let parsed: unknown;
  try {
    parsed = extractJsonObject(first);
  } catch {
    parsed = null;
  }

  let result = diagnosisSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 12)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');

    const repair = await callChat(
      [
        ...messages,
        { role: 'assistant', content: first.slice(0, 6_000) },
        {
          role: 'user',
          content: `Your previous response did not match the required JSON schema. Problems: ${issues}. Return the corrected JSON object only.`,
        },
      ],
      0,
    );

    parsed = extractJsonObject(repair);
    result = diagnosisSchema.safeParse(parsed);
    if (!result.success) {
      throw new AiError(
        `Model output failed schema validation after a repair attempt (${result.error.issues[0]?.message ?? 'unknown issue'}).`,
        'invalid_output',
      );
    }
    notes.push('The model returned an invalid structure once; AuthDoctor repaired the response before rendering it.');
  }

  return {
    diagnosis: normalise(result.data, input),
    model: config.ai.model,
    notes,
  };
}

/**
 * Post-validation hardening: enforce honesty rules the schema cannot express.
 * A model must not claim high confidence from a bare status code, and a
 * corrected curl must not contain a literal secret.
 */
function normalise(diagnosis: Diagnosis, input: DiagnosisInput): Diagnosis {
  const evidenceCount = diagnosis.evidence.filter((item) => item.verified).length;
  let confidence = diagnosis.confidence;

  if (evidenceCount === 0 && confidence > 0.6) confidence = 0.6;
  if (!input.logs.trim() && (input.statusCode ?? 0) >= 500 && confidence > 0.7) confidence = 0.7;

  const curl = diagnosis.curl
    ? diagnosis.curl
        .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, '$ACCESS_TOKEN')
        .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, '$API_KEY')
    : null;

  const verifiedFindings = diagnosis.evidence.filter((item) => item.verified).map((item) => item.detail);

  return {
    ...diagnosis,
    confidence: Math.round(Math.min(0.97, Math.max(0.3, confidence)) * 100) / 100,
    curl,
    verifiedFindings: verifiedFindings.length ? verifiedFindings.slice(0, 8) : diagnosis.verifiedFindings,
    likelyFindings: diagnosis.likelyFindings.length ? diagnosis.likelyFindings : [diagnosis.likelyCause.cause],
  };
}

const ASSISTANT_PROMPT = `You are AuthDoctor's assistant, embedded in an API debugging workspace.

You are given the redacted request context and, when available, a structured diagnosis that was already produced by the analysis engine. You also receive deterministic tool results computed from the user's message (for example a freshly generated curl command or a status-code comparison).

Rules:
- Answer in concise Markdown. Short paragraphs, bullet lists, fenced code blocks.
- Ground every claim in the supplied context or tool results. If something was not supplied, say what is missing.
- Distinguish verified facts from likely causes.
- You cannot execute HTTP requests. Never claim a fix was tested or that a request was sent.
- Keep credentials as [REDACTED:...] or environment variables; never invent a secret value.
- If the user asks something unrelated to API debugging, redirect briefly to what you can help with.`;

export interface AssistantContext {
  input: DiagnosisInput | null;
  diagnosis: Diagnosis | null;
  toolResults: Array<{ name: string; label: string; content: string }>;
}

export async function chatWithModel(
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  context: AssistantContext,
): Promise<string> {
  if (!config.ai.baseUrl || !config.ai.model) {
    throw new AiError('No model provider is configured.', 'not_configured');
  }

  const contextBlock = JSON.stringify(
    {
      currentRequest: context.input
        ? {
            method: context.input.method,
            url: context.input.url,
            statusCode: context.input.statusCode,
            requestHeaders: context.input.requestHeaders,
            requestBody: context.input.requestBody,
            responseBody: context.input.responseBody,
            errorMessage: context.input.errorMessage,
            serverLogs: context.input.logs,
          }
        : null,
      currentDiagnosis: context.diagnosis,
      toolResults: context.toolResults,
    },
    null,
    2,
  ).slice(0, 24_000);

  const messages = [
    { role: 'system', content: `${ASSISTANT_PROMPT}\n\nCONTEXT:\n${contextBlock}` },
    ...history.slice(-10),
  ];

  return callChat(messages, 0.3, false);
}
