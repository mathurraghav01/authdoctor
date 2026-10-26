import type { DiagnosisInput } from '../schema.js';

export interface HeaderEntry {
  name: string;
  value: string;
}

export function parseHeaders(raw: string): HeaderEntry[] {
  if (!raw || raw.trim() === '') return [];
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const index = line.indexOf(':');
      if (index === -1) return { name: line, value: '' };
      return { name: line.slice(0, index).trim(), value: line.slice(index + 1).trim() };
    })
    .filter((entry) => entry.name.length > 0);
}

export function headerValue(headers: HeaderEntry[], name: string): string | null {
  const match = headers.find((header) => header.name.toLowerCase() === name.toLowerCase());
  return match && match.value ? match.value : null;
}

export function tryParseJson(raw: string): unknown {
  if (!raw || raw.trim() === '') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export interface JwtAnalysis {
  present: boolean;
  expired: boolean | null;
  expiresAt: string | null;
  issuedAt: string | null;
  secondsUntilExpiry: number | null;
  algorithm: string | null;
  issuer: string | null;
  audience: string | null;
  subject: string | null;
  scopes: string[];
  malformed: boolean;
  /** True when the value is clearly not a JWT (opaque token, Basic, etc). */
  opaque: boolean;
}

const EMPTY_JWT: JwtAnalysis = {
  present: false,
  expired: null,
  expiresAt: null,
  issuedAt: null,
  secondsUntilExpiry: null,
  algorithm: null,
  issuer: null,
  audience: null,
  subject: null,
  scopes: [],
  malformed: false,
  opaque: false,
};

function decodeBase64Url(segment: string): string | null {
  try {
    const normalised = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalised.padEnd(Math.ceil(normalised.length / 4) * 4, '=');
    return Buffer.from(padded, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Inspects the Authorization header locally. This is the one piece of
 * evidence AuthDoctor can verify without a model: an expired `exp` claim is
 * a fact, not a guess.
 */
export function analyzeAuthorization(headers: HeaderEntry[], now = Date.now()): JwtAnalysis {
  const raw = headerValue(headers, 'authorization');
  if (!raw) return { ...EMPTY_JWT };

  const bearer = raw.match(/^Bearer\s+(.+)$/i);
  const token = bearer?.[1]?.trim() ?? raw.trim();

  const parts = token.split('.');
  if (parts.length !== 3) {
    return { ...EMPTY_JWT, present: true, opaque: true };
  }

  const payloadRaw = decodeBase64Url(parts[1] ?? '');
  if (!payloadRaw) return { ...EMPTY_JWT, present: true, malformed: true };

  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(payloadRaw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ...EMPTY_JWT, present: true, malformed: true };
    }
    payload = parsed as Record<string, unknown>;
  } catch {
    return { ...EMPTY_JWT, present: true, malformed: true };
  }

  const headerRaw = decodeBase64Url(parts[0] ?? '');
  let algorithm: string | null = null;
  if (headerRaw) {
    try {
      const header: unknown = JSON.parse(headerRaw);
      if (header && typeof header === 'object' && !Array.isArray(header)) {
        const alg = (header as Record<string, unknown>).alg;
        if (typeof alg === 'string') algorithm = alg;
      }
    } catch {
      // Header is not required for the expiry check.
    }
  }

  const exp = typeof payload.exp === 'number' ? payload.exp : null;
  const iat = typeof payload.iat === 'number' ? payload.iat : null;
  const nowSeconds = Math.floor(now / 1000);
  const secondsUntilExpiry = exp === null ? null : exp - nowSeconds;

  const scopeValue = payload.scope ?? payload.scp;
  const scopes: string[] = Array.isArray(scopeValue)
    ? scopeValue.filter((value): value is string => typeof value === 'string')
    : typeof scopeValue === 'string'
      ? scopeValue.split(/\s+/).filter(Boolean)
      : [];

  return {
    present: true,
    expired: exp === null ? null : exp <= nowSeconds,
    expiresAt: exp === null ? null : new Date(exp * 1000).toISOString(),
    issuedAt: iat === null ? null : new Date(iat * 1000).toISOString(),
    secondsUntilExpiry,
    algorithm,
    issuer: typeof payload.iss === 'string' ? payload.iss : null,
    audience:
      typeof payload.aud === 'string'
        ? payload.aud
        : Array.isArray(payload.aud) && typeof payload.aud[0] === 'string'
          ? payload.aud[0]
          : null,
    subject: typeof payload.sub === 'string' ? payload.sub : null,
    scopes,
    malformed: false,
    opaque: false,
  };
}

export interface RequestSignals {
  headers: HeaderEntry[];
  jwt: JwtAnalysis;
  contentType: string | null;
  hasAuthHeader: boolean;
  authScheme: string | null;
  errorCode: string | null;
  responseJson: Record<string, unknown> | null;
  requestJson: Record<string, unknown> | null;
  responseText: string;
  errorText: string;
  logText: string;
  statusCode: number | null;
  retryAfter: string | null;
  rateLimitRemaining: string | null;
  wwwAuthenticate: string | null;
  isTimeout: boolean;
  isNetworkError: boolean;
}

const TIMEOUT_PATTERN = /(timeout|timed out|ETIMEDOUT|ECONNRESET|socket hang up|aborted|deadline exceeded)/i;
const NETWORK_PATTERN = /(ENOTFOUND|ECONNREFUSED|EAI_AGAIN|getaddrinfo|network error|failed to fetch|certificate|CERT_|SSL|TLS handshake)/i;

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function findErrorCode(value: unknown, depth = 0): string | null {
  if (depth > 3 || !value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findErrorCode(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of ['code', 'error', 'error_code', 'errorCode', 'type', 'status']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.length <= 80) return candidate;
  }
  for (const child of Object.values(record)) {
    const found = findErrorCode(child, depth + 1);
    if (found) return found;
  }
  return null;
}

export function extractSignals(input: DiagnosisInput, now = Date.now()): RequestSignals {
  const headers = parseHeaders(input.requestHeaders);
  const authHeader = headerValue(headers, 'authorization');
  const responseText = [input.responseBody, input.errorMessage].filter(Boolean).join('\n');
  const logText = input.logs ?? '';

  const responseJson = asObject(tryParseJson(input.responseBody));
  const requestJson = asObject(tryParseJson(input.requestBody));

  return {
    headers,
    jwt: analyzeAuthorization(headers, now),
    contentType: headerValue(headers, 'content-type'),
    hasAuthHeader: Boolean(authHeader),
    authScheme: authHeader ? (authHeader.split(/\s+/)[0] ?? null) : null,
    errorCode: findErrorCode(responseJson),
    responseJson,
    requestJson,
    responseText,
    errorText: `${input.errorMessage}\n${responseText}`,
    logText,
    statusCode: input.statusCode,
    retryAfter: headerValue(headers, 'retry-after'),
    rateLimitRemaining: headerValue(headers, 'x-ratelimit-remaining') ?? headerValue(headers, 'ratelimit-remaining'),
    wwwAuthenticate: headerValue(headers, 'www-authenticate'),
    isTimeout: TIMEOUT_PATTERN.test(responseText) || TIMEOUT_PATTERN.test(logText),
    isNetworkError: NETWORK_PATTERN.test(responseText) || NETWORK_PATTERN.test(logText),
  };
}

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

export function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
