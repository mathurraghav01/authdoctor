import { useState } from 'react';
import { ArrowRight, Braces, FileJson2, Terminal } from 'lucide-react';
import type { RequestDraft } from '../lib/types';
import { HTTP_METHODS, METHOD_STYLES, looksLikeJson, prettyJson } from '../lib/format';
import { StatusBadge } from './StatusBadge';

interface Props {
  draft: RequestDraft;
  onChange: (patch: Partial<RequestDraft>) => void;
  disabled?: boolean;
}

type Tab = 'headers' | 'body';

export function RequestEditor({ draft, onChange, disabled }: Props) {
  const [tab, setTab] = useState<Tab>('headers');

  const headerCount = draft.requestHeaders.split('\n').filter((line) => line.trim()).length;

  return (
    <section className="panel animate-fade-up">
      <div className="panel-header">
        <div className="flex items-center gap-2">
          <span className="label">Request</span>
          <StatusBadge code={draft.statusCode} className="hidden sm:inline-flex" />
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-4">
            <button type="button" onClick={() => setTab('headers')} className={`tab ${tab === 'headers' ? 'tab-active' : ''}`}>
              Headers {headerCount > 0 && <span className="ml-1 text-[10px] text-fg-dim">{headerCount}</span>}
            </button>
            <button type="button" onClick={() => setTab('body')} className={`tab ${tab === 'body' ? 'tab-active' : ''}`}>
              Body
            </button>
          </div>
        </div>
      </div>

      <div className="space-y-3 p-4">
        <div className="flex flex-row gap-2">
          <div className="relative w-[104px] shrink-0 sm:w-[124px]">
            <select
              value={draft.method}
              onChange={(event) => onChange({ method: event.target.value })}
              disabled={disabled}
              aria-label="HTTP method"
              className={`field appearance-none py-2 pl-2.5 pr-7 font-mono text-[12.5px] font-semibold uppercase ${METHOD_STYLES[draft.method] ?? 'text-fg'}`}
            >
              {HTTP_METHODS.map((method) => (
                <option key={method} value={method} className="bg-ink-850 text-fg">
                  {method}
                </option>
              ))}
            </select>
            <ArrowRight size={13} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rotate-90 text-fg-dim" />
          </div>

          <div className="relative flex-1">
            <input
              value={draft.url}
              onChange={(event) => onChange({ url: event.target.value })}
              disabled={disabled}
              placeholder="https://api.example.com/v1/resource"
              spellCheck={false}
              autoComplete="off"
              aria-label="Request URL"
              className="field py-2 pl-9 font-mono text-[12.5px]"
            />
            <Terminal size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-dim" />
          </div>
        </div>

        {tab === 'headers' ? (
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <label htmlFor="request-headers" className="text-[11px] text-fg-dim">
                One header per line, as sent by the client
              </label>
              <span className="font-mono text-[10px] text-fg-dim">{headerCount} lines</span>
            </div>
            <textarea
              id="request-headers"
              value={draft.requestHeaders}
              onChange={(event) => onChange({ requestHeaders: event.target.value })}
              disabled={disabled}
              spellCheck={false}
              placeholder={'Authorization: Bearer $ACCESS_TOKEN\nContent-Type: application/json\nAccept: application/json'}
              className="field-mono min-h-[188px] resize-y"
            />
          </div>
        ) : (
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <label htmlFor="request-body" className="text-[11px] text-fg-dim">
                Raw request body (JSON, form data or text)
              </label>
              <span className="font-mono text-[10px] text-fg-dim">{draft.requestBody.length} chars</span>
            </div>
            <textarea
              id="request-body"
              value={draft.requestBody}
              onChange={(event) => onChange({ requestBody: event.target.value })}
              disabled={disabled}
              spellCheck={false}
              placeholder={'{\n  "amount": 100,\n  "currency": "usd"\n}'}
              className="field-mono min-h-[188px] resize-y"
            />
          </div>
        )}
      </div>
    </section>
  );
}

interface ResponseProps {
  draft: RequestDraft;
  onChange: (patch: Partial<RequestDraft>) => void;
  disabled?: boolean;
}

export function ResponseEditor({ draft, onChange, disabled }: ResponseProps) {
  const [tab, setTab] = useState<'body' | 'logs'>('body');
  const [formatNote, setFormatNote] = useState<string | null>(null);

  const format = () => {
    const formatted = prettyJson(draft.responseBody);
    if (formatted) {
      onChange({ responseBody: formatted });
      setFormatNote(null);
    } else {
      setFormatNote('Not valid JSON');
      setTimeout(() => setFormatNote(null), 1800);
    }
  };

  return (
    <section className="panel animate-fade-up" style={{ animationDelay: '40ms' }}>
      <div className="panel-header">
        <div className="flex items-center gap-2">
          <span className="label">Response</span>
          <div className="flex items-center gap-1.5">
            <input
              value={draft.statusCode}
              onChange={(event) => {
                const digits = event.target.value.replace(/[^\d]/g, '').slice(0, 3);
                onChange({ statusCode: digits });
              }}
              disabled={disabled}
              inputMode="numeric"
              placeholder="---"
              aria-label="HTTP status code"
              className="w-[46px] rounded-md border border-line bg-ink-900 px-1.5 py-0.5 text-center font-mono text-[11.5px] text-fg placeholder:text-fg-dim/60 focus:border-accent/60 focus:outline-none"
            />
            <span className="hidden text-[10.5px] text-fg-dim sm:inline">status</span>
          </div>
        </div>
        <div className="flex items-center gap-2 sm:gap-4">
          {tab === 'body' && (
            <button
              type="button"
              onClick={format}
              className="hidden items-center gap-1 text-[11px] text-fg-dim transition hover:text-fg sm:flex"
              title="Pretty-print JSON"
            >
              <Braces size={12} />
              {formatNote ?? 'Format'}
            </button>
          )}
          <div className="flex items-center gap-3 whitespace-nowrap sm:gap-4">
            <button type="button" onClick={() => setTab('body')} className={`tab ${tab === 'body' ? 'tab-active' : ''}`}>
              Body
            </button>
            <button type="button" onClick={() => setTab('logs')} className={`tab ${tab === 'logs' ? 'tab-active' : ''}`}>
              Error & logs
            </button>
          </div>
        </div>
      </div>

      <div className="p-4">
        {tab === 'body' ? (
          <>
            <div className="mb-1.5 flex items-center justify-between">
              <label htmlFor="response-body" className="text-[11px] text-fg-dim">
                Response body as returned by the server
              </label>
              {looksLikeJson(draft.responseBody) && (
                <span className="flex items-center gap-1 text-[10px] text-ok/80">
                  <FileJson2 size={10} /> JSON detected
                </span>
              )}
            </div>
            <textarea
              id="response-body"
              value={draft.responseBody}
              onChange={(event) => onChange({ responseBody: event.target.value })}
              disabled={disabled}
              spellCheck={false}
              placeholder={'{\n  "error": "invalid_token",\n  "message": "The access token expired"\n}'}
              className="field-mono min-h-[172px] resize-y"
            />
          </>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <label htmlFor="error-message" className="mb-1.5 block text-[11px] text-fg-dim">
                Client error message
              </label>
              <textarea
                id="error-message"
                value={draft.errorMessage}
                onChange={(event) => onChange({ errorMessage: event.target.value })}
                disabled={disabled}
                spellCheck={false}
                placeholder="Request failed with status code 401"
                className="field-mono min-h-[172px] resize-y"
              />
            </div>
            <div>
              <label htmlFor="logs" className="mb-1.5 block text-[11px] text-fg-dim">
                Server logs <span className="text-fg-dim/70">(optional)</span>
              </label>
              <textarea
                id="logs"
                value={draft.logs}
                onChange={(event) => onChange({ logs: event.target.value })}
                disabled={disabled}
                spellCheck={false}
                placeholder="Paste the matching server log lines or stack trace"
                className="field-mono min-h-[172px] resize-y"
              />
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
