import type { Diagnosis, DiagnosisInput } from '../schema.js';
import { redactInput, type RedactionFinding } from '../utils/redact.js';
import { extractSignals, parseHeaders } from '../utils/request.js';
import { runLocalDiagnosis, STATUS_REFERENCE, statusText } from './localEngine.js';

export type AssistantActionName = 'diagnose' | 'curl' | 'compare' | 'next-steps' | 'redaction' | 'explain';

export interface AssistantAction {
  name: AssistantActionName;
  label: string;
  content: string;
}

const STATUS_CODES = [400, 401, 403, 404, 405, 408, 409, 415, 422, 429, 500, 501, 502, 503, 504];

function codesIn(message: string): number[] {
  const matches = message.match(/\b(4\d\d|5\d\d)\b/g) ?? [];
  const unique = [...new Set(matches.map(Number))].filter((code) => STATUS_CODES.includes(code));
  return unique;
}

function hasAny(message: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(message));
}

export function detectIntent(message: string): AssistantActionName | null {
  const text = message.toLowerCase();
  if (hasAny(text, [/\bcurl\b/, /corrected request/, /reproduce/])) return 'curl';
  if (hasAny(text, [/difference between/, /\bcompare\b/, /\bversus\b/, /\bvs\.?\b/, /how.*(401|403|429).*different/])) return 'compare';
  if (hasAny(text, [/redact/, /secret/, /privacy/, /safe to (paste|share)/, /sensitive/])) return 'redaction';
  if (hasAny(text, [/next step/, /what should i (check|do|try)/, /where (do|should) i start/, /debug plan/])) return 'next-steps';
  if (hasAny(text, [/diagnos/, /what('s| is) wrong/, /why.*(fail|error|reject|break)/, /root cause/])) return 'diagnose';
  if (codesIn(text).length > 0) return 'explain';
  return null;
}

function describeDiagnosis(diagnosis: Diagnosis, engineLabel: string): string {
  const topSteps = diagnosis.steps.slice(0, 3).map((step, index) => `${index + 1}. **${step.title}** — ${step.detail}`);
  return [
    `**${diagnosis.title}**`,
    '',
    diagnosis.summary,
    '',
    `**Most likely cause:** ${diagnosis.likelyCause.cause} _(${diagnosis.likelyCause.confidence} confidence)_`,
    '',
    '**What to check**',
    ...topSteps,
    '',
    `_${engineLabel}_`,
  ].join('\n');
}

function compareReply(codes: number[]): string {
  // Explain exactly the codes that were asked about; only fall back to the
  // 401/403 pair when the caller supplied none.
  const pair = codes.length > 0 ? codes.slice(0, 2) : [401, 403];
  const lines = ['| Status | Meaning | Fix |', '| --- | --- | --- |'];
  for (const code of pair) {
    const ref = STATUS_REFERENCE[code];
    if (ref) lines.push(`| **${code} ${ref.name}** | ${ref.means} | ${ref.fix} |`);
    else lines.push(`| **${code}** | Not in the local reference. | Inspect the response body and logs. |`);
  }
  if (pair.includes(401) && pair.includes(403)) {
    lines.push(
      '',
      'The practical test: refresh the token. If the fresh token still returns the same status, it is **403** (authorization), not 401. Refreshing fixes 401; it never fixes a missing scope.',
    );
  }
  return lines.join('\n');
}

function curlReply(diagnosis: Diagnosis, input: DiagnosisInput | null): string {
  if (!diagnosis.curl) {
    return 'I need a request URL before I can build a curl command. Fill in the endpoint in the workspace, then ask again.';
  }
  const notes: string[] = [];
  const signals = input ? extractSignals(input) : null;
  if (signals?.hasAuthHeader) notes.push('The token is referenced as `$ACCESS_TOKEN` so no credential is embedded in the command.');
  if (signals?.jwt.expired) notes.push('The current token is expired, so export a fresh one before running this.');
  return ['```bash', diagnosis.curl, '```', notes.length ? `\n${notes.map((note) => `- ${note}`).join('\n')}` : ''].join('\n');
}

function nextStepsReply(diagnosis: Diagnosis): string {
  const steps = diagnosis.steps.map(
    (step, index) => `${index + 1}. **${step.title}**\n   ${step.detail}${step.command ? `\n\n   \`\`\`bash\n   ${step.command}\n   \`\`\`` : ''}`,
  );
  const needs = diagnosis.needsMoreInfo.length
    ? `\n**To raise confidence:** ${diagnosis.needsMoreInfo.join(' ')}`
    : '';
  return [...steps, needs].join('\n');
}

function redactionReply(findings: RedactionFinding[], redacted: DiagnosisInput): string {
  if (!findings.length) {
    return 'No recognizable credentials were found in the current workspace. Note that AuthDoctor only detects known token shapes and sensitive header or field names; review anything unusual before sharing it.';
  }
  const lines = [
    `AuthDoctor found **${findings.reduce((sum, finding) => sum + finding.count, 0)}** secret(s) and replaced them before analysis:`,
    '',
    ...findings.map((finding) => `- \`${finding.kind}\` × ${finding.count} (${finding.field})`),
    '',
    'Here is the redacted Authorization header as the model would see it:',
    '',
    '```http',
    redacted.requestHeaders.split('\n').filter((line) => /authorization/i.test(line)).join('\n') || '(no authorization header present)',
    '```',
    '',
    'Original values are never stored or logged. Treat any diagnosis as reviewable advice, not a tested fix.',
  ];
  return lines.join('\n');
}

export interface LocalAssistantResult {
  reply: string;
  actions: AssistantAction[];
  diagnosis: Diagnosis | null;
}

/**
 * Deterministic assistant used in Local mode and as the grounded tool layer
 * for the model. Conversational commands map to real workspace actions
 * rather than to canned text.
 */
export function runLocalAssistant(message: string, input: DiagnosisInput | null, existing: Diagnosis | null): LocalAssistantResult {
  const intent = detectIntent(message);
  const actions: AssistantAction[] = [];
  const redacted = input ? redactInput(input) : null;
  const hasRequest = Boolean(input && (input.url || input.statusCode || input.requestHeaders || input.responseBody || input.errorMessage));

  let diagnosis = existing;
  if (!diagnosis && hasRequest && input) {
    diagnosis = runLocalDiagnosis(input);
  }

  if (intent === 'redaction') {
    const findings = redacted?.findings ?? [];
    const content = redactionReply(findings, redacted?.input ?? (input as DiagnosisInput));
    actions.push({ name: 'redaction', label: 'Inspected redaction report', content });
    return { reply: content, actions, diagnosis };
  }

  if (intent === 'compare') {
    const codes = codesIn(message);
    const content = compareReply(codes);
    actions.push({ name: 'compare', label: `Compared ${codes.length >= 2 ? codes.slice(0, 2).join(' vs ') : '401 vs 403'}`, content });
    return { reply: content, actions, diagnosis };
  }

  // An explicit "what does 429 mean?" must explain 429 even when a different
  // request is loaded, instead of falling through to the loaded diagnosis.
  if (intent === 'explain') {
    const codes = codesIn(message);
    const content = compareReply(codes);
    actions.push({ name: 'explain', label: `Explained ${codes.join(', ')}`, content });
    return { reply: content, actions, diagnosis };
  }

  if (!diagnosis) {
    const reply =
      'There is nothing to diagnose yet. Paste the request, status code and response in the workspace — or load a sample from the sidebar — then ask me again. I can also explain the difference between status codes without a request.';
    return { reply, actions, diagnosis };
  }

  if (intent === 'curl') {
    const content = curlReply(diagnosis, redacted?.input ?? input);
    actions.push({ name: 'curl', label: 'Generated corrected curl', content });
    return { reply: content, actions, diagnosis };
  }

  if (intent === 'next-steps') {
    const content = nextStepsReply(diagnosis);
    actions.push({ name: 'next-steps', label: 'Built a debugging plan', content });
    return { reply: content, actions, diagnosis };
  }

  const content = describeDiagnosis(diagnosis, 'Local rule engine · no model connected');
  actions.push({ name: intent ?? 'diagnose', label: 'Ran local diagnosis', content });
  return { reply: content, actions, diagnosis };
}

/** Compact grounding block handed to the model so it cannot invent context. */
export function toolContext(diagnosis: Diagnosis | null, actions: AssistantAction[]): Array<{ name: string; label: string; content: string }> {
  const results: Array<{ name: string; label: string; content: string }> = actions.map((action) => ({
    name: action.name,
    label: action.label,
    content: action.content.slice(0, 4_000),
  }));
  if (diagnosis) {
    results.push({
      name: 'current_diagnosis',
      label: 'Structured diagnosis already shown to the user',
      content: JSON.stringify(diagnosis).slice(0, 6_000),
    });
  }
  return results;
}

export function contextSummary(input: DiagnosisInput | null): string {
  if (!input) return 'No request loaded.';
  const headers = parseHeaders(input.requestHeaders);
  return `${input.method} ${input.url || '(no url)'} → ${statusText(input.statusCode)} · ${headers.length} headers`;
}
