import type { RequestDraft } from './types';

/**
 * Client-side preview only. The server performs authoritative redaction;
 * this exists so the UI can warn before anything leaves the browser.
 */
export interface RedactionPreview {
  count: number;
  kinds: string[];
}

const CHECKS: Array<{ kind: string; pattern: RegExp }> = [
  { kind: 'authorization', pattern: /(?:authorization|proxy-authorization)\s*:\s*(?:bearer|basic|token)\s+\S+/gi },
  { kind: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g },
  { kind: 'api-key', pattern: /\b(?:sk|pk|rk)[-_](?:live|test|ant-|proj-)?[A-Za-z0-9_-]{12,}/g },
  { kind: 'api-key', pattern: /\b(?:ghp|gho|github_pat|xox[baprs])[_-][A-Za-z0-9_-]{10,}/g },
  { kind: 'cookie', pattern: /\bcookie\s*:\s*[^\n]+/gi },
  { kind: 'password', pattern: /["']?(?:password|passwd|client_secret|secret)["']?\s*[:=]\s*["']?[^\s"',}]{3,}/gi },
  { kind: 'token', pattern: /[?&](?:access_token|refresh_token|api_key|token|sig|signature)=[^&\s"']{6,}/gi },
  { kind: 'connection-string', pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s"'<>]+/gi },
];

export function previewRedactions(draft: RequestDraft | null): RedactionPreview {
  if (!draft) return { count: 0, kinds: [] };
  const haystack = [
    draft.requestHeaders,
    draft.requestBody,
    draft.responseBody,
    draft.errorMessage,
    draft.logs,
  ].join('\n');

  const kinds = new Set<string>();
  let count = 0;

  for (const check of CHECKS) {
    const matches = (haystack.match(check.pattern) ?? []).filter((match) => !match.includes('[REDACTED:'));
    if (matches.length > 0) {
      // A JWT inside an Authorization header is one secret, not two.
      const effective = check.kind === 'jwt' && kinds.has('authorization') ? 0 : matches.length;
      if (effective > 0) {
        count += effective;
        kinds.add(check.kind);
      }
    }
  }

  return { count, kinds: [...kinds] };
}
