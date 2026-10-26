import type { Diagnosis, DiagnosisInput } from '../schema.js';
import { extractSignals, parseHeaders, type RequestSignals } from '../utils/request.js';
import { redactInput } from '../utils/redact.js';

/**
 * Deterministic diagnosis engine.
 *
 * This is not a language model. It encodes the checks a senior backend
 * engineer runs first, and it only reports as "verified" the facts it can
 * actually compute from the pasted material (status codes, JWT claims,
 * rate-limit headers, error codes, timeout markers). Everything else is
 * labelled as likely. It powers Local mode and is the fallback when a
 * configured model returns something unusable.
 */

interface Playbook {
  title: string;
  summary: string;
  cause: string;
  confidence: 'high' | 'medium' | 'low';
  score: number;
  rationale: string;
  evidence: Diagnosis['evidence'];
  alternatives: Diagnosis['alternatives'];
  steps: Diagnosis['steps'];
  fix: Diagnosis['fix'];
  securityRisks: Diagnosis['securityRisks'];
  needsMoreInfo: string[];
}

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  408: 'Request Timeout',
  409: 'Conflict',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

export function statusText(code: number | null): string {
  if (code === null) return 'No status code';
  return `${code} ${STATUS_TEXT[code] ?? 'HTTP Error'}`;
}

function quote(value: string, max = 160): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max)}…` : compact;
}

function buildCurl(input: DiagnosisInput, signals: RequestSignals): string | null {
  if (!input.url) return null;
  const lines = [`curl -i -X ${input.method} '${input.url.replace(/'/g, "'\\''")}'`];
  // Header values here are already redacted; the scheme is preserved.
  for (const header of parseHeaders(input.requestHeaders)) {
    const name = header.name.toLowerCase();
    if (name === 'authorization') {
      const scheme = header.value.split(/\s+/)[0] ?? 'Bearer';
      lines.push(`  -H 'Authorization: ${scheme} $ACCESS_TOKEN'`);
    } else if (name === 'cookie' || name === 'x-api-key' || name === 'api-key') {
      lines.push(`  -H '${header.name}: $${name === 'cookie' ? 'COOKIE' : 'API_KEY'}'`);
    } else if (header.value && !header.value.includes('[REDACTED:')) {
      lines.push(`  -H '${header.name}: ${header.value.replace(/'/g, "'\\''")}'`);
    }
  }

  if (!signals.hasAuthHeader && (signals.statusCode === 401 || signals.statusCode === 403)) {
    lines.push(`  -H 'Authorization: Bearer $ACCESS_TOKEN'`);
  }

  if (input.requestBody.trim()) {
    lines.push(`  --data-raw '${input.requestBody.replace(/'/g, "'\\''")}'`);
  }

  return lines.join(' \\\n');
}

function commonRisks(signals: RequestSignals): Diagnosis['securityRisks'] {
  const risks: Diagnosis['securityRisks'] = [];
  if (signals.jwt.algorithm && /^none$/i.test(signals.jwt.algorithm)) {
    risks.push({
      risk: 'JWT uses alg=none',
      severity: 'high',
      detail: 'A token with no signature algorithm must never be accepted by a verifier. Reject alg=none explicitly.',
    });
  }
  if (signals.jwt.secondsUntilExpiry !== null && signals.jwt.secondsUntilExpiry > 60 * 60 * 24 * 30) {
    risks.push({
      risk: 'Very long-lived access token',
      severity: 'medium',
      detail: 'The access token is valid for more than 30 days. Prefer short-lived access tokens with refresh tokens.',
    });
  }
  if (signals.jwt.opaque && signals.hasAuthHeader) {
    risks.push({
      risk: 'Opaque credential in Authorization',
      severity: 'low',
      detail: 'The bearer value is not a JWT, so expiry and scopes cannot be checked locally. Confirm the token type the API expects.',
    });
  }
  if (!signals.hasAuthHeader && signals.statusCode !== 401) {
    risks.push({
      risk: 'No Authorization header supplied',
      severity: 'low',
      detail: 'If this endpoint is authenticated, the request never proves an identity. Confirm the endpoint is meant to be public.',
    });
  }
  return risks;
}

function baseEvidence(signals: RequestSignals): Diagnosis['evidence'] {
  const evidence: Diagnosis['evidence'] = [];
  if (signals.statusCode !== null) {
    evidence.push({
      source: 'status',
      detail: `Response status is ${statusText(signals.statusCode)}.`,
      verified: true,
    });
  }
  if (signals.errorCode) {
    evidence.push({
      source: 'response',
      detail: `Response body carries error code "${quote(signals.errorCode, 80)}".`,
      verified: true,
    });
  }
  return evidence;
}

function unauthorized(input: DiagnosisInput, signals: RequestSignals): Playbook {
  const { jwt } = signals;
  const evidence = baseEvidence(signals);
  const alternatives: Diagnosis['alternatives'] = [];
  const steps: Diagnosis['steps'] = [];
  const needsMoreInfo: string[] = [];
  let cause: string;
  let confidence: Playbook['confidence'] = 'high';
  let score = 0.86;
  let rationale: string;
  let summary: string;
  let fix: Diagnosis['fix'];

  if (jwt.present && jwt.expired === true) {
    score = 0.96;
    cause = 'The bearer token has expired';
    rationale = `The JWT payload's exp claim is ${jwt.expiresAt}, which is ${Math.abs(
      jwt.secondsUntilExpiry ?? 0,
    )} seconds in the past. AuthDoctor decoded this locally, so it is a fact rather than a guess.`;
    evidence.push({
      source: 'token',
      detail: `JWT exp claim (${jwt.expiresAt}) is in the past.${jwt.issuer ? ` Issuer: ${jwt.issuer}.` : ''}${
        jwt.audience ? ` Audience: ${jwt.audience}.` : ''
      }`,
      verified: true,
    });
    if (jwt.issuedAt) {
      evidence.push({ source: 'token', detail: `Token was issued at ${jwt.issuedAt}.`, verified: true });
    }
    summary =
      'The request was rejected because the access token has already expired. Expiry is a client-side fact: refresh the token, retry, and make the client refresh before exp instead of after a 401.';
    alternatives.push({
      cause: 'Clock skew between the client and the authorization server',
      likelihood: 'low',
      note: 'If the token was minted seconds ago and already reads as expired, check NTP on the issuing host.',
    });
    alternatives.push({
      cause: 'The API rejected the token for a reason other than expiry',
      likelihood: 'low',
      note: 'Signature, issuer and audience checks also produce 401. Decode WWW-Authenticate for a hint.',
    });
    steps.push(
      {
        title: 'Refresh the access token',
        detail: 'Use the refresh token or client-credentials grant to obtain a new access token. Do not retry with the expired value.',
      },
      {
        title: 'Retry once with the fresh token',
        detail: 'Re-run the request with the new bearer value and confirm the status changes to 200/2xx.',
        command: buildCurl(input, signals) ?? undefined,
      },
      {
        title: 'Add proactive refresh',
        detail: 'Refresh when fewer than 60 seconds remain before exp, rather than waiting for a 401. Compare exp to the local clock.',
      },
    );
    fix = {
      summary: 'Obtain a new access token before retrying, then refresh proactively using the exp claim.',
      code: {
        language: 'typescript',
        content: `// Refresh before the token expires instead of after a 401.
const REFRESH_SKEW_MS = 60_000;

function needsRefresh(expiresAt: number) {
  return Date.now() >= expiresAt - REFRESH_SKEW_MS;
}

async function authorizedFetch(url: string, init: RequestInit = {}) {
  if (needsRefresh(token.expiresAt)) {
    token = await refreshAccessToken(token.refreshToken);
  }
  return fetch(url, {
    ...init,
    headers: { ...init.headers, Authorization: \`Bearer \${token.accessToken}\` },
  });
}`,
      },
      notes: [
        'Never log the raw token while debugging; log the exp claim and a token fingerprint instead.',
        'If refresh itself returns 401, the refresh token is expired or revoked and the user must re-authenticate.',
      ],
    };
  } else if (jwt.present && jwt.malformed) {
    score = 0.92;
    cause = 'The Authorization header does not contain a valid JWT';
    rationale =
      'A three-part value was found but the payload could not be base64url-decoded into JSON. APIs reject structurally invalid tokens before any claim checks.';
    evidence.push({
      source: 'token',
      detail: 'Bearer value has three dot-separated segments but the payload is not valid base64url JSON.',
      verified: true,
    });
    summary =
      'The token is malformed, so the API cannot verify it. This usually means the token was truncated, copied with whitespace, URL-encoded twice, or a non-JWT value (such as an API key) was sent as a bearer token.';
    alternatives.push({
      cause: 'A different credential type is being sent',
      likelihood: 'medium',
      note: 'Some APIs expect an opaque API key or a session cookie instead of a JWT.',
    });
    steps.push(
      { title: 'Print the token length and segment count', detail: 'A JWT must have exactly three segments. Log only the length and a fingerprint, never the token.' },
      { title: 'Re-copy the token from the issuer', detail: 'Avoid truncation in shell variables and double URL-encoding in query strings.' },
      { title: 'Check the expected auth scheme', detail: 'Confirm the API documents Bearer vs Basic vs an API-key header.' },
    );
    fix = {
      summary: 'Send the exact token string the issuer returned, with the documented scheme.',
      notes: ['Verify no newline or wrapping quote was introduced by your shell or .env file.'],
    };
  } else if (!signals.hasAuthHeader) {
    score = 0.9;
    cause = 'The request has no Authorization header';
    rationale = 'No Authorization header was present in the pasted request headers, which is the first thing an authenticated endpoint checks.';
    evidence.push({ source: 'request', detail: 'Request headers contain no Authorization entry.', verified: true });
    summary =
      'The endpoint requires authentication but the request arrived without credentials. Add the Authorization header on the request that actually failed, and confirm middleware or a proxy is not stripping it.';
    alternatives.push(
      { cause: 'A proxy or gateway removes the Authorization header', likelihood: 'medium', note: 'Check ingress, CDN and API-gateway rules that forward only allow-listed headers.' },
      { cause: 'The SDK call omitted the token', likelihood: 'medium', note: 'Confirm the client was initialized with credentials before the first request.' },
    );
    steps.push(
      { title: 'Add the Authorization header', detail: 'Send `Authorization: Bearer <token>` (or the scheme your API documents) on the failing request.' },
      { title: 'Confirm the header survives the network path', detail: 'Log header names only at the gateway and at the service to find where it disappears.' },
      { title: 'Retry and compare', detail: 'A correct token should move the response from 401 to 2xx or to 403 if scopes are missing.' },
    );
    fix = {
      summary: 'Attach the access token to the request.',
      code: {
        language: 'bash',
        content: `curl -i https://api.example.com/v1/resource \\
  -H "Authorization: Bearer $ACCESS_TOKEN"`,
      },
      notes: ['Keep the token in an environment variable so it never lands in shell history or source control.'],
    };
  } else if (jwt.present && jwt.opaque) {
    score = 0.62;
    confidence = 'medium';
    cause = 'The API did not accept the supplied bearer credential';
    rationale = `The Authorization header uses the ${signals.authScheme ?? 'Bearer'} scheme with an opaque value, so expiry and scopes cannot be checked locally. Rejection reasons are server-side.`;
    evidence.push({ source: 'request', detail: `Authorization header uses the ${signals.authScheme ?? 'Bearer'} scheme with a non-JWT value.`, verified: true });
    if (signals.wwwAuthenticate) {
      evidence.push({ source: 'response', detail: `WWW-Authenticate: ${quote(signals.wwwAuthenticate)}`, verified: true });
    }
    summary =
      'The request carried credentials, but the server still returned 401. With an opaque token the failure is on the server side: the credential is unknown, revoked, expired, or belongs to another environment.';
    alternatives.push(
      { cause: 'Token belongs to a different environment', likelihood: 'high', note: 'Test and production credentials are frequently swapped; compare the issuer host.' },
      { cause: 'Token was revoked or rotated', likelihood: 'medium', note: 'Rotating a key invalidates all tokens signed with it.' },
    );
    steps.push(
      { title: 'Read WWW-Authenticate', detail: 'The error parameter often distinguishes invalid_token from insufficient_scope.' },
      { title: 'Verify environment and key', detail: 'Confirm the token was minted by the same issuer the API validates against.' },
      { title: 'Try a freshly minted token', detail: 'If a new token works, the old one was expired or revoked.' },
    );
    needsMoreInfo.push('The issuer or token endpoint used to mint this credential.');
    fix = {
      summary: 'Mint a token from the issuer this API trusts, then retry with that value.',
      notes: ['Opaque tokens cannot be introspected locally; check the authorization server logs for the rejection reason.'],
    };
  } else {
    score = 0.7;
    confidence = 'medium';
    cause = 'The access token was rejected by the resource server';
    rationale = 'A bearer token was supplied but the server returned 401. Signature, issuer, audience, or revocation checks can all produce this response.';
    evidence.push({ source: 'request', detail: 'A Bearer token was supplied in the Authorization header.', verified: true });
    if (jwt.audience) evidence.push({ source: 'token', detail: `Token audience is "${jwt.audience}".`, verified: true });
    if (jwt.issuer) evidence.push({ source: 'token', detail: `Token issuer is "${jwt.issuer}".`, verified: true });
    if (signals.wwwAuthenticate) {
      evidence.push({ source: 'response', detail: `WWW-Authenticate: ${quote(signals.wwwAuthenticate)}`, verified: true });
    }
    summary =
      'The server received a token but did not accept it. Check issuer, audience and signature configuration before assuming the token itself is bad.';
    alternatives.push(
      { cause: 'Audience mismatch', likelihood: 'high', note: 'The token aud must include the API identifier the resource server expects.' },
      { cause: 'Signing key mismatch after rotation', likelihood: 'medium', note: 'The resource server may cache JWKS; a rotation can leave it validating against an old key.' },
    );
    steps.push(
      { title: 'Compare iss and aud', detail: 'Decode the token payload and compare issuer and audience with the resource server configuration.' },
      { title: 'Verify JWKS reachability', detail: 'Confirm the API can fetch the issuer JWKS and that kid matches the token header.' },
      { title: 'Check WWW-Authenticate', detail: 'Use the returned error code to distinguish invalid_token from insufficient_scope.' },
    );
    fix = {
      summary: 'Align issuer, audience and signing keys between the token issuer and the API.',
      notes: ['Do not disable signature verification to make a 401 disappear.'],
    };
  }

  return {
    title: `401 Unauthorized — ${cause}`,
    summary,
    cause,
    confidence,
    score,
    rationale,
    evidence,
    alternatives,
    steps,
    fix,
    securityRisks: commonRisks(signals),
    needsMoreInfo,
  };
}

function forbidden(input: DiagnosisInput, signals: RequestSignals): Playbook {
  const scopes = signals.jwt.scopes;
  const evidence = baseEvidence(signals);
  if (signals.hasAuthHeader) {
    evidence.push({
      source: 'request',
      detail: `The request is authenticated (${signals.authScheme ?? 'Bearer'} scheme), so identity was accepted.`,
      verified: true,
    });
  }
  if (scopes.length) {
    evidence.push({ source: 'token', detail: `Token scopes: ${scopes.join(' ')}`, verified: true });
  }
  if (signals.responseJson) {
    const detail = (signals.responseJson.error ?? signals.responseJson.message) as unknown;
    if (typeof detail === 'string') {
      evidence.push({ source: 'response', detail: `Server said: ${quote(detail)}`, verified: true });
    }
  }

  return {
    title: '403 Forbidden — authenticated but not authorized',
    summary:
      'The API knows who you are and still refuses the action. This is an authorization problem: a missing scope, a role that lacks permission, or a tenant/resource boundary. It is not fixed by refreshing the token.',
    cause: scopes.length
      ? `The access token lacks a scope required by this endpoint (granted: ${scopes.slice(0, 6).join(' ')}).`
      : 'The caller is authenticated but lacks permission for this resource or action.',
    confidence: scopes.length ? 'high' : 'medium',
    score: scopes.length ? 0.88 : 0.74,
    rationale: scopes.length
      ? 'A valid token was accepted, and its scope list is readable. 403 with a valid identity points at scope or role enforcement rather than authentication.'
      : 'The request carried credentials and the server still returned 403, which is the standard signal for insufficient permission.',
    evidence,
    alternatives: [
      { cause: 'Object-level authorization', likelihood: 'high', note: 'The caller may own the scope but not this specific record (another tenant or user).' },
      { cause: 'Required role not assigned', likelihood: 'medium', note: 'RBAC roles are often cached; confirm the role was granted and the cache refreshed.' },
      { cause: 'IP allow-list or WAF rule', likelihood: 'low', note: 'Some gateways return 403 for blocked networks before the app sees the request.' },
    ],
    steps: [
      { title: 'Find the required scope', detail: 'Read the endpoint documentation and identify the exact scope or role it enforces.' },
      { title: 'Compare with the token', detail: scopes.length ? `The token currently grants: ${scopes.join(' ')}. Request the missing scope in the next authorization flow.` : 'Decode the token to list granted scopes, then compare with the endpoint requirement.' },
      { title: 'Re-consent if the scope was added later', detail: 'Scopes are baked into a token at issue time; add the scope and mint a new token.' },
      { title: 'Check resource ownership', detail: 'If the scope is present, verify the resource belongs to the caller tenant or user.' },
    ],
    fix: {
      summary: 'Grant the missing scope or role, then obtain a new token so the grant is present in the claims.',
      code: {
        language: 'javascript',
        content: `// Request the scope the endpoint actually enforces.
const authUrl = new URL('https://auth.example.com/oauth/authorize');
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('client_id', process.env.CLIENT_ID);
authUrl.searchParams.set('redirect_uri', process.env.REDIRECT_URI);
authUrl.searchParams.set('scope', 'openid profile invoices.write');
// After the redirect, exchange the code for a token that carries the new scope.
console.log(authUrl.toString());`,
      },
      notes: ['403 is not fixed by refreshing a token that already has the wrong scopes.'],
    },
    securityRisks: [
      ...commonRisks(signals),
      { risk: 'Over-broad scopes', severity: 'medium', detail: 'Do not request admin or wildcard scopes to work around a single 403. Fix the permission model instead.' },
    ],
    needsMoreInfo: scopes.length ? [] : ['The token scope list or the role assigned to the caller.'],
  };
}

function rateLimited(_input: DiagnosisInput, signals: RequestSignals): Playbook {
  const evidence = baseEvidence(signals);
  if (signals.retryAfter) evidence.push({ source: 'response', detail: `Retry-After: ${signals.retryAfter}`, verified: true });
  if (signals.rateLimitRemaining) {
    evidence.push({ source: 'response', detail: `Rate-limit remaining: ${signals.rateLimitRemaining}`, verified: true });
  }

  const retrySeconds = signals.retryAfter && /^\d+$/.test(signals.retryAfter) ? Number(signals.retryAfter) : null;

  return {
    title: '429 Too Many Requests — rate limit exceeded',
    summary: retrySeconds
      ? `The API is throttling this client and asked you to wait ${retrySeconds} seconds. Respect Retry-After and add exponential backoff with jitter rather than retrying immediately.`
      : 'The API is throttling this client. The response should include Retry-After or rate-limit headers; use them to pace requests and add backoff with jitter.',
    cause: 'The request rate exceeded the limit configured for this key, IP, or tenant.',
    confidence: 'high',
    score: 0.95,
    rationale: 'HTTP 429 is emitted by rate-limiting middleware and is unambiguous when rate-limit headers or a Retry-After value accompany it.',
    evidence,
    alternatives: [
      { cause: 'Concurrency limit rather than request rate', likelihood: 'medium', note: 'Some gateways cap in-flight requests per key, not requests per second.' },
      { cause: 'Shared quota exhausted by another client', likelihood: 'medium', note: 'A quota is often per API key or tenant, so a second service can consume it.' },
    ],
    steps: [
      { title: 'Honour Retry-After', detail: retrySeconds ? `Wait at least ${retrySeconds} seconds before the next attempt.` : 'Read the Retry-After header when present and wait that long.' },
      { title: 'Add bounded retries with jitter', detail: 'Retry only 429/5xx responses, cap attempts, and use exponential backoff with random jitter.' },
      { title: 'Find the limiting dimension', detail: 'Identify whether the limit is per key, per IP, per tenant or per endpoint, then reduce concurrency or batch requests.' },
      { title: 'Raise the quota if the traffic is legitimate', detail: 'Use the provider dashboard to confirm the limit and request an increase.' },
    ],
    fix: {
      summary: 'Back off according to Retry-After and reduce concurrency; raise the quota only if traffic is genuinely within budget.',
      code: {
        language: 'typescript',
        content: `async function withRetry<T>(fn: () => Promise<Response>, attempts = 5): Promise<Response> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const res = await fn();
    if (res.status !== 429 && res.status < 500) return res;

    const retryAfter = Number(res.headers.get('retry-after'));
    const base = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt;
    const jitter = Math.random() * 250;
    await new Promise((resolve) => setTimeout(resolve, base + jitter));
  }
  throw new Error('rate limit retries exhausted');
}`,
      },
      notes: ['Never retry a 429 in a tight loop; it extends the throttle window.', 'Cache idempotent reads to cut request volume.'],
    },
    securityRisks: [
      {
        risk: 'API key shared across services',
        severity: 'medium',
        detail: 'A shared key makes quota attribution impossible and turns one noisy service into an outage for all of them. Use per-service keys.',
      },
    ],
    needsMoreInfo: signals.retryAfter ? [] : ['The Retry-After header or the provider rate-limit headers for this endpoint.'],
  };
}

function serverError(_input: DiagnosisInput, signals: RequestSignals): Playbook {
  const evidence = baseEvidence(signals);
  const logMatches = signals.logText.match(/(?:Error|Exception|TypeError|at\s+\w+)[^\n]{0,160}/g) ?? [];
  for (const line of logMatches.slice(0, 3)) {
    evidence.push({ source: 'logs', detail: quote(line, 180), verified: true });
  }
  if (signals.responseJson) {
    const requestId = signals.responseJson.requestId ?? signals.responseJson.request_id ?? signals.responseJson.traceId;
    if (typeof requestId === 'string') {
      evidence.push({ source: 'response', detail: `Request/trace id: ${quote(requestId, 80)}`, verified: true });
    }
  }
  if (!logMatches.length) {
    evidence.push({ source: 'logs', detail: 'No server-side stack trace was supplied, so the failing frame is unknown.', verified: true });
  }

  return {
    title: '500 Internal Server Error — the server failed while handling the request',
    summary:
      'The request reached the application and the application threw. A 500 is not caused by the shape of the response; it is a server-side defect or an unhandled dependency failure. Start from the trace id and the stack trace.',
    cause: logMatches.length
      ? 'An unhandled exception in the application, visible in the supplied server logs.'
      : 'An unhandled server-side exception or dependency failure; the exact cause needs the server stack trace.',
    confidence: logMatches.length ? 'medium' : 'low',
    score: logMatches.length ? 0.68 : 0.5,
    rationale: logMatches.length
      ? 'The supplied logs contain exception output that lines up with the 500 response, but the root cause still needs the full stack trace and request id.'
      : 'A 500 only proves the server failed. Without logs or a trace id, naming a specific cause would be a guess.',
    evidence,
    alternatives: [
      { cause: 'Downstream dependency returned an error that was not handled', likelihood: 'high', note: 'Database timeouts, third-party 5xx and queue failures commonly surface as 500.' },
      { cause: 'Unvalidated input reached a code path that throws', likelihood: 'medium', note: 'A null or wrong-typed field can throw before the handler returns a 4xx.' },
      { cause: 'Configuration or environment variable missing at runtime', likelihood: 'medium', note: 'Missing secrets often fail at first use rather than at boot.' },
    ],
    steps: [
      { title: 'Find the trace', detail: 'Locate the server log line for this request using the trace id, timestamp and path.' },
      { title: 'Read the innermost frame', detail: 'Identify the first application frame in the stack trace; that is usually the defect site.' },
      { title: 'Check downstream calls', detail: 'Confirm database, cache and third-party calls in that path returned successfully.' },
      { title: 'Reproduce with the same payload', detail: 'Replay the request against staging with the same body and headers, then narrow the input until the error disappears.' },
    ],
    fix: {
      summary: 'Fix the throwing code path and add an error boundary that returns a typed 4xx/5xx with a trace id.',
      notes: [
        'Never return the raw stack trace to clients; log it with the trace id instead.',
        'A 500 should be an intentional response for unexpected failures, not an uncaught exception.',
      ],
    },
    securityRisks: [
      {
        risk: 'Stack traces exposed to clients',
        severity: signals.responseText.includes('at ') ? 'high' : 'low',
        detail: signals.responseText.includes('at ')
          ? 'The pasted response appears to contain a stack trace. Remove it from client-facing responses; it discloses internal paths and versions.'
          : 'Confirm production responses never include stack traces or SQL errors.',
      },
    ],
    needsMoreInfo: logMatches.length ? ['The full stack trace and the request id from the failing request.'] : ['Server logs or the stack trace for this request.'],
  };
}

function networkFailure(input: DiagnosisInput, signals: RequestSignals): Playbook {
  const text = `${input.errorMessage} ${signals.logText}`;
  const isTls = /(certificate|CERT_|SSL|TLS)/i.test(text);
  const isDns = /(ENOTFOUND|EAI_AGAIN|getaddrinfo)/i.test(text);
  const isRefused = /(ECONNREFUSED)/i.test(text);
  const isTimeout = signals.isTimeout;

  let cause = 'The request never produced an HTTP response';
  let rationale = 'The client reported a transport-level failure, so no HTTP status was returned. The fault is below the application layer.';
  let title = 'Network failure — no HTTP response received';

  if (isTls) {
    cause = 'TLS negotiation failed';
    rationale = 'The error text references a certificate or TLS handshake, which fails before any HTTP request is sent.';
    title = 'TLS failure — certificate or handshake rejected';
  } else if (isDns) {
    cause = 'DNS resolution failed for the host';
    rationale = 'The error text indicates the hostname could not be resolved, so no connection was attempted.';
    title = 'DNS failure — hostname did not resolve';
  } else if (isRefused) {
    cause = 'The connection was refused by the target host';
    rationale = 'ECONNREFUSED means a host was reachable but nothing was listening on that port, or a proxy rejected the connection.';
    title = 'Connection refused — nothing listening on the target port';
  } else if (isTimeout) {
    cause = 'The request timed out before a response arrived';
    rationale = 'A timeout means the connection or read phase exceeded the client budget. It does not prove the server failed.';
    title = 'Timeout — the response exceeded the client deadline';
  }

  const evidence: Diagnosis['evidence'] = [
    { source: 'network', detail: quote(input.errorMessage || signals.logText || 'Transport error reported by the client.', 220), verified: Boolean(input.errorMessage) },
  ];
  if (signals.isTimeout) evidence.push({ source: 'logs', detail: 'Timeout or connection-reset marker found in the supplied text.', verified: true });

  return {
    title,
    summary: `${cause}. Because no HTTP response exists, status-code advice does not apply: check DNS, TLS, connectivity, proxy configuration and the client timeout budget in that order.`,
    cause,
    confidence: isDns || isTls || isRefused ? 'high' : 'medium',
    score: isDns || isTls || isRefused ? 0.86 : 0.62,
    rationale,
    evidence,
    alternatives: [
      { cause: 'Proxy or egress firewall blocking the connection', likelihood: 'medium', note: 'Corporate proxies and VPC egress rules often surface as timeouts or refusals.' },
      { cause: 'The server is slow rather than down', likelihood: 'medium', note: 'A timeout can be a latency problem; check server latency before assuming an outage.' },
    ],
    steps: [
      { title: 'Resolve the hostname', detail: 'Run `dig +short <host>` or `nslookup <host>` from the same network as the failing client.', command: input.url ? `dig +short ${new URL(input.url).hostname}` : undefined },
      { title: 'Test the TCP/TLS path', detail: 'Use `curl -v --max-time 10 <url>` to see whether DNS, TCP, TLS or the HTTP response is the phase that fails.' },
      { title: 'Check proxy and egress rules', detail: 'Confirm HTTP(S)_PROXY and NO_PROXY are correct and that the destination is allow-listed.' },
      { title: 'Compare timeouts', detail: 'If TLS and TCP succeed, raise the client timeout and measure server latency before retrying.' },
    ],
    fix: {
      summary: 'Isolate the failing phase (DNS, TCP, TLS, HTTP) and fix that layer rather than retrying blindly.',
      code: {
        language: 'bash',
        content: `# Shows which phase fails: resolve, connect, TLS, or response.
curl -v --max-time 10 "${input.url || 'https://api.example.com/health'}" 2>&1 | sed -n '1,40p'`,
      },
      notes: ['A retry without diagnosis turns a timeout into a retry storm.'],
    },
    securityRisks: [
      {
        risk: 'Certificate verification disabled as a workaround',
        severity: 'medium',
        detail: 'Do not set NODE_TLS_REJECT_UNAUTHORIZED=0 or curl -k to bypass a TLS failure; fix the trust chain instead.',
      },
    ],
    needsMoreInfo: signals.statusCode === null ? ['The exact client error text, including the error code.'] : [],
  };
}

function genericStatus(input: DiagnosisInput, signals: RequestSignals): Playbook {
  const code = signals.statusCode ?? 0;
  const evidence = baseEvidence(signals);
  if (signals.responseJson) {
    const message = signals.responseJson.message ?? signals.responseJson.error;
    if (typeof message === 'string') evidence.push({ source: 'response', detail: quote(message), verified: true });
  }

  const guidance: Record<number, { cause: string; steps: Diagnosis['steps']; summary: string }> = {
    400: {
      cause: 'The request body or parameters failed validation',
      summary: 'The server rejected the request as malformed. Read the validation error fields and compare them with the documented schema before changing anything else.',
      steps: [
        { title: 'Read the field-level error', detail: 'Most 400 responses name the offending field. Fix that field first.' },
        { title: 'Validate locally', detail: 'Validate the payload against the API schema before sending it.' },
      ],
    },
    404: {
      cause: 'The path, resource id or base URL does not exist',
      summary: 'A 404 means the server found no route or resource at this path. Check the base URL, API version prefix, trailing slash and resource id.',
      steps: [
        { title: 'Confirm base URL and version', detail: 'Compare the URL with the documented base URL and API version prefix.' },
        { title: 'Check the resource id', detail: 'Verify the id exists and belongs to the authenticated tenant.' },
      ],
    },
    422: {
      cause: 'The payload was syntactically valid but semantically rejected',
      summary: 'The server parsed the body and refused its meaning. Field-level errors usually explain which constraint failed.',
      steps: [
        { title: 'Read the errors array', detail: 'Inspect each field error and its constraint.' },
        { title: 'Fix constraints, not types', detail: '422 usually means a value is out of range or violates a business rule.' },
      ],
    },
    502: {
      cause: 'An upstream service returned an invalid response to the gateway',
      summary: 'The gateway reached the upstream but could not use its response. The defect is usually in the upstream service or the gateway timeout.',
      steps: [
        { title: 'Check upstream health', detail: 'Confirm the upstream service is healthy and returning valid responses.' },
        { title: 'Check gateway timeouts', detail: 'A slow upstream often surfaces as 502 at the proxy.' },
      ],
    },
    503: {
      cause: 'The service is unavailable, overloaded or in maintenance',
      summary: 'The service is refusing traffic. Check status pages, deploy events and dependency health; 503 is frequently a deliberate shed-load response.',
      steps: [
        { title: 'Check deploy and status', detail: 'Look for a recent deploy, restart or provider incident.' },
        { title: 'Honour Retry-After', detail: 'Back off rather than hammering an unavailable service.' },
      ],
    },
  };

  const selected = guidance[code] ?? {
    cause: `The API returned ${statusText(code)}`,
    summary: 'The server returned an error status. Use the response body and server logs to identify the failing layer before changing the request.',
    steps: [
      { title: 'Read the response body', detail: 'Extract the error code and message; they usually name the failing component.' },
      { title: 'Correlate with logs', detail: 'Find the matching server log entry by timestamp and path.' },
    ],
  };

  return {
    title: `${statusText(code)} — ${selected.cause}`,
    summary: selected.summary,
    cause: selected.cause,
    confidence: 'medium',
    score: 0.66,
    rationale: `HTTP ${code} narrows the failure to a specific class, but the supplied material does not identify the exact line of code.`,
    evidence,
    alternatives: [
      { cause: 'A gateway or proxy produced this status instead of the application', likelihood: 'medium', note: 'Compare response headers such as server and x-request-id with the application.' },
    ],
    steps: selected.steps,
    fix: {
      summary: 'Correct the request according to the documented schema, then verify with the trace id.',
      notes: ['Do not retry non-idempotent requests without confirming whether the first attempt took effect.'],
    },
    securityRisks: commonRisks(signals),
    needsMoreInfo: ['The response body and any request id from the failing call.'],
  };
}

function choosePlaybook(input: DiagnosisInput, signals: RequestSignals): Playbook {
  const code = signals.statusCode;

  // Only a missing status makes this a transport failure. A 500 whose logs
  // mention a downstream timeout is still a server-side failure, and the
  // timeout belongs in its evidence rather than replacing the diagnosis.
  if (code === null) return networkFailure(input, signals);
  if (code === 401) return unauthorized(input, signals);
  if (code === 403) return forbidden(input, signals);
  if (code === 429) return rateLimited(input, signals);
  if (code !== null && code >= 500) return serverError(input, signals);
  return genericStatus(input, signals);
}

function confidenceValue(score: number): number {
  return Math.round(Math.min(0.97, Math.max(0.35, score)) * 100) / 100;
}

export function runLocalDiagnosis(input: DiagnosisInput, now = Date.now()): Diagnosis {
  // Signals come from the raw input so JWT claims stay verifiable; only the
  // generated curl uses the redacted copy.
  const signals = extractSignals(input, now);
  const playbook = choosePlaybook(input, signals);
  const safe = redactInput(input).input;

  const verifiedFindings = playbook.evidence.filter((item) => item.verified).map((item) => item.detail);
  const likelyFindings = [
    playbook.cause,
    ...playbook.alternatives.filter((alt) => alt.likelihood === 'high').map((alt) => alt.cause),
  ];

  const notes: string[] = [];
  if (!input.requestHeaders.trim()) notes.push('No request headers were supplied; header-dependent checks were skipped.');
  if (!input.responseBody.trim() && !input.errorMessage.trim()) notes.push('No response body or error message was supplied.');
  if (!input.logs.trim() && (signals.statusCode ?? 0) >= 500) notes.push('Server logs were not supplied, so the failing frame is unknown.');

  return {
    title: playbook.title,
    summary: playbook.summary,
    likelyCause: {
      cause: playbook.cause,
      confidence: playbook.confidence,
      rationale: playbook.rationale,
    },
    confidence: confidenceValue(playbook.score),
    evidence: playbook.evidence,
    alternatives: playbook.alternatives,
    steps: playbook.steps,
    fix: playbook.fix,
    curl: buildCurl(safe, signals),
    securityRisks: playbook.securityRisks,
    verifiedFindings: verifiedFindings.length
      ? verifiedFindings
      : ['Nothing in the supplied material can be verified without additional data.'],
    likelyFindings,
    needsMoreInfo: playbook.needsMoreInfo,
  };
}

/** Used by the assistant when asked to compare status codes. */
export const STATUS_REFERENCE: Record<number, { name: string; means: string; fix: string }> = {
  400: { name: 'Bad Request', means: 'Malformed syntax or failed validation.', fix: 'Read field errors and correct the payload.' },
  401: { name: 'Unauthorized', means: 'No valid identity: missing, malformed or expired credentials.', fix: 'Authenticate or refresh the token.' },
  403: { name: 'Forbidden', means: 'Identity is valid but permission is missing.', fix: 'Grant the scope or role; do not refresh the token.' },
  404: { name: 'Not Found', means: 'No route or resource at this path.', fix: 'Check base URL, version and resource id.' },
  409: { name: 'Conflict', means: 'The request conflicts with current resource state.', fix: 'Re-read the resource and reconcile the version.' },
  422: { name: 'Unprocessable Entity', means: 'Syntactically valid but semantically rejected.', fix: 'Fix the constraint named in the errors array.' },
  429: { name: 'Too Many Requests', means: 'Client exceeded a rate limit.', fix: 'Honour Retry-After and add backoff with jitter.' },
  500: { name: 'Internal Server Error', means: 'The server threw while handling a valid request.', fix: 'Use the trace id and stack trace; fix the server defect.' },
  502: { name: 'Bad Gateway', means: 'The gateway received an invalid upstream response.', fix: 'Check upstream health and gateway timeouts.' },
  503: { name: 'Service Unavailable', means: 'The service is overloaded or in maintenance.', fix: 'Back off and check status/deploy events.' },
  504: { name: 'Gateway Timeout', means: 'An upstream did not answer within the gateway deadline.', fix: 'Measure upstream latency and raise the budget only if justified.' },
};
