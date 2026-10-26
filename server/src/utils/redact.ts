/**
 * Secret redaction.
 *
 * Everything pasted into AuthDoctor is untrusted and may contain live
 * credentials. Redaction runs on the server before anything is logged,
 * stored in history or sent to a model. It is intentionally conservative:
 * over-redacting a token is cheap, leaking one is not.
 */

export type RedactionKind =
  | 'authorization'
  | 'cookie'
  | 'api-key'
  | 'password'
  | 'token'
  | 'connection-string'
  | 'private-key';

import type { DiagnosisInput } from '../schema.js';

export interface RedactionFinding {
  field: string;
  kind: RedactionKind;
  count: number;
}

export interface RedactionResult {
  text: string;
  findings: RedactionFinding[];
}

const MASK = (kind: RedactionKind) => `[REDACTED:${kind}]`;

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'apikey',
  'x-auth-token',
  'x-access-token',
  'x-csrf-token',
  'x-xsrf-token',
  'x-amz-security-token',
  'x-goog-api-key',
]);

const SENSITIVE_KEYS = [
  'password',
  'passwd',
  'pwd',
  'secret',
  'client_secret',
  'clientsecret',
  'token',
  'access_token',
  'accesstoken',
  'refresh_token',
  'refreshtoken',
  'id_token',
  'idtoken',
  'api_key',
  'apikey',
  'api-key',
  'private_key',
  'privatekey',
  'authorization',
  'cookie',
  'session',
  'sessionid',
  'session_id',
  'auth',
  'credential',
  'credentials',
  'signature',
  'sig',
];

const isSensitiveKey = (key: string) => SENSITIVE_KEYS.includes(key.toLowerCase().replace(/[\s-]/g, '_'));

/** Token shapes that are recognizable on their own, regardless of context. */
const TOKEN_PATTERNS: Array<{ kind: RedactionKind; pattern: RegExp }> = [
  { kind: 'token', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{0,}/g },
  { kind: 'api-key', pattern: /\bsk-(?:ant-|proj-|live-)?[A-Za-z0-9_-]{16,}/g },
  { kind: 'api-key', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g },
  { kind: 'api-key', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { kind: 'api-key', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { kind: 'api-key', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'api-key', pattern: /\bAIza[0-9A-Za-z_-]{30,}/g },
  { kind: 'api-key', pattern: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { kind: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'connection-string', pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s"'<>]+/gi },
];

const AUTH_SCHEME = /\b(Bearer|Basic|Token|Digest|Bot)\s+([A-Za-z0-9._~+/=-]{6,})/gi;

const QUERY_SECRET = /([?&](?:access_token|refresh_token|id_token|token|api_key|apikey|key|secret|password|client_secret|signature|sig)=)([^&\s"'#]+)/gi;

function redactFreeText(text: string): { text: string; counts: Map<RedactionKind, number> } {
  const counts = new Map<RedactionKind, number>();
  let output = text;

  output = output.replace(AUTH_SCHEME, (_match, scheme: string, _token: string) => {
    counts.set('authorization', (counts.get('authorization') ?? 0) + 1);
    return `${scheme} ${MASK('authorization')}`;
  });

  for (const { kind, pattern } of TOKEN_PATTERNS) {
    output = output.replace(pattern, () => {
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
      return MASK(kind);
    });
  }

  output = output.replace(QUERY_SECRET, (_match, prefix: string) => {
    counts.set('token', (counts.get('token') ?? 0) + 1);
    return `${prefix}${MASK('token')}`;
  });

  return { text: output, counts };
}

function redactKeyValueLine(line: string): { line: string; kind: RedactionKind | null } {
  // Header / log style "Key: value" or "Key=value" or `"key": "value"`.
  const match = line.match(/^(\s*["']?)([A-Za-z0-9_.-]+)(["']?\s*[:=]\s*)(["']?)(.*?)(\4)(,?)(\s*)$/);
  if (!match) return { line, kind: null };

  const [, lead, key, sep, quote, value, closeQuote, comma, tail] = match;
  if (!key || !isSensitiveKey(key)) return { line, kind: null };

  const kind: RedactionKind = /cookie/i.test(key)
    ? 'cookie'
    : /pass|pwd|secret/i.test(key)
      ? 'password'
      : /authoriz/i.test(key)
        ? 'authorization'
        : /key|signature|sig/i.test(key)
          ? 'api-key'
          : 'token';

  // An empty value is not a secret worth flagging.
  if (!value || value.trim() === '') return { line, kind: null };

  return {
    line: `${lead}${key}${sep}${quote}${MASK(kind)}${closeQuote ?? ''}${comma ?? ''}${tail ?? ''}`,
    kind,
  };
}

function redactJsonValue(value: unknown, counts: Map<RedactionKind, number>): unknown {
  if (Array.isArray(value)) return value.map((item) => redactJsonValue(item, counts));
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(key) && typeof child === 'string' && child.trim() !== '') {
        const kind: RedactionKind = /pass|pwd|secret/i.test(key)
          ? 'password'
          : /cookie/i.test(key)
            ? 'cookie'
            : /key/i.test(key)
              ? 'api-key'
              : 'token';
        counts.set(kind, (counts.get(kind) ?? 0) + 1);
        output[key] = MASK(kind);
      } else if (isSensitiveKey(key) && typeof child === 'number') {
        counts.set('token', (counts.get('token') ?? 0) + 1);
        output[key] = MASK('token');
      } else {
        output[key] = redactJsonValue(child, counts);
      }
    }
    return output;
  }
  if (typeof value === 'string') {
    const { text } = redactFreeText(value);
    return text;
  }
  return value;
}

/**
 * Redacts a raw block of text (headers, JSON, plain logs) and reports what
 * was removed. JSON is handled structurally so keys stay readable.
 */
export function redactText(raw: string): RedactionResult {
  if (!raw || raw.trim() === '') return { text: raw, findings: [] };

  const counts = new Map<RedactionKind, number>();
  let text = raw;

  const trimmed = raw.trim();
  const looksLikeJson =
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'));

  if (looksLikeJson) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      text = JSON.stringify(redactJsonValue(parsed, counts), null, 2);
    } catch {
      // Not valid JSON after all; fall through to line handling.
    }
  }

  if (text === raw) {
    text = text
      .split('\n')
      .map((line) => {
        const { line: redacted, kind } = redactKeyValueLine(line);
        if (kind) counts.set(kind, (counts.get(kind) ?? 0) + 1);
        return redacted;
      })
      .join('\n');
  }

  const freeText = redactFreeText(text);
  text = freeText.text;
  for (const [kind, count] of freeText.counts) {
    counts.set(kind, (counts.get(kind) ?? 0) + count);
  }

  return {
    text,
    findings: [...counts.entries()].map(([kind, count]) => ({ field: 'content', kind, count })),
  };
}

/** Redacts a raw header block, preserving header names and ordering. */
export function redactHeaders(raw: string): RedactionResult {
  if (!raw || raw.trim() === '') return { text: raw, findings: [] };
  const counts = new Map<RedactionKind, number>();

  const text = raw
    .split('\n')
    .map((line) => {
      const match = line.match(/^(\s*)([A-Za-z0-9-]+)(\s*:\s*)(.*)$/);
      if (!match) {
        const free = redactFreeText(line);
        for (const [kind, count] of free.counts) counts.set(kind, (counts.get(kind) ?? 0) + count);
        return free.text;
      }
      const [, lead, name, sep, value] = match;
      if (!name || !SENSITIVE_HEADERS.has(name.toLowerCase())) {
        const free = redactFreeText(value ?? '');
        for (const [kind, count] of free.counts) counts.set(kind, (counts.get(kind) ?? 0) + count);
        return `${lead}${name}${sep}${free.text}`;
      }
      if (!value || value.trim() === '') return line;
      const kind: RedactionKind = /cookie/i.test(name) ? 'cookie' : /authoriz/i.test(name) ? 'authorization' : 'api-key';
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
      // Keep the auth scheme: "Bearer" vs "Basic" is diagnostic signal, the
      // credential itself is the secret.
      const scheme = name.toLowerCase().includes('authorization')
        ? value.match(/^([A-Za-z]+)\s+\S+/)?.[1]
        : undefined;
      return `${lead}${name}${sep}${scheme ? `${scheme} ` : ''}${MASK(kind)}`;
    })
    .join('\n');

  return {
    text,
    findings: [...counts.entries()].map(([kind, count]) => ({ field: 'headers', kind, count })),
  };
}

export function mergeFindings(...groups: RedactionFinding[][]): RedactionFinding[] {
  const merged = new Map<string, RedactionFinding>();
  for (const group of groups) {
    for (const finding of group) {
      const key = `${finding.field}:${finding.kind}`;
      const existing = merged.get(key);
      if (existing) existing.count += finding.count;
      else merged.set(key, { ...finding });
    }
  }
  return [...merged.values()];
}

/** Applies redaction to every free-text field of a diagnosis input. */
export function redactInput(input: DiagnosisInput): { input: DiagnosisInput; findings: RedactionFinding[] } {
  const headers = redactHeaders(input.requestHeaders);
  const requestBody = redactText(input.requestBody);
  const responseBody = redactText(input.responseBody);
  const errorMessage = redactText(input.errorMessage);
  const logs = redactText(input.logs);

  return {
    input: {
      ...input,
      requestHeaders: headers.text,
      requestBody: requestBody.text,
      responseBody: responseBody.text,
      errorMessage: errorMessage.text,
      logs: logs.text,
    },
    findings: mergeFindings(headers.findings, requestBody.findings, responseBody.findings, errorMessage.findings, logs.findings),
  };
}

export const REDACTION_NOTE =
  'Credentials were replaced with [REDACTED:*] placeholders on the server before analysis. The original values are never stored or logged.';
