import { useState } from 'react';
import {
  Activity,
  ChevronRight,
  Cpu,
  FlaskConical,
  History,
  Plus,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import type { HistoryEntry, ProviderStatus, Sample } from '../lib/types';
import { relativeTime, STATUS_STYLES, statusTone } from '../lib/format';
import { CodeBlock } from './CodeBlock';

interface Props {
  samples: Sample[];
  activeSampleId: string | null;
  onSelectSample: (sample: Sample) => void;
  history: HistoryEntry[];
  onRestoreHistory: (entry: HistoryEntry) => void;
  onDeleteHistory: (id: string) => void;
  onClearHistory: () => void;
  provider: ProviderStatus | null;
  providerError: boolean;
  onNew: () => void;
  open: boolean;
  onClose: () => void;
}

export function Sidebar({
  samples,
  activeSampleId,
  onSelectSample,
  history,
  onRestoreHistory,
  onDeleteHistory,
  onClearHistory,
  provider,
  providerError,
  onNew,
  open,
  onClose,
}: Props) {
  const [showConnect, setShowConnect] = useState(false);
  const connected = provider?.mode === 'model';

  return (
    <>
      {open && (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={onClose}
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden"
        />
      )}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-[272px] shrink-0 flex-col border-r border-line bg-ink-900 transition-transform duration-200 lg:static lg:translate-x-0 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between px-4 pb-3 pt-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-accent/25 bg-accent-soft">
              <Activity size={16} className="text-accent" />
            </div>
            <div className="leading-tight">
              <div className="text-[13.5px] font-semibold tracking-tight text-fg">AuthDoctor</div>
              <div className="text-[10.5px] text-fg-dim">API debug assistant</div>
            </div>
          </div>
          <button type="button" onClick={onClose} className="btn-quiet p-1 lg:hidden" aria-label="Close navigation">
            <X size={16} />
          </button>
        </div>

        <div className="px-3">
          <button type="button" onClick={onNew} className="btn-ghost w-full justify-start gap-2 px-2.5 py-2 text-[13px]">
            <Plus size={14} />
            New diagnosis
            <span className="ml-auto kbd">⌘K</span>
          </button>
        </div>

        <nav className="mt-5 flex-1 overflow-y-auto px-3 pb-4">
          <div className="mb-2 flex items-center gap-1.5 px-1">
            <FlaskConical size={12} className="text-fg-dim" />
            <span className="label">Samples</span>
          </div>
          <ul className="space-y-0.5">
            {samples.map((sample) => {
              const active = sample.id === activeSampleId;
              return (
                <li key={sample.id}>
                  <button
                    type="button"
                    onClick={() => onSelectSample(sample)}
                    className={`group flex w-full items-start gap-2 rounded-lg border px-2 py-2 text-left transition ${
                      active
                        ? 'border-accent/30 bg-accent-soft'
                        : 'border-transparent hover:border-line hover:bg-white/[0.025]'
                    }`}
                  >
                    <span
                      className={`chip mt-0.5 shrink-0 font-mono text-[10px] ${STATUS_STYLES[statusTone(sample.tag === 'TIMEOUT' ? null : sample.tag)]}`}
                    >
                      {sample.tag}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={`line-clamp-2 text-[12.5px] leading-snug ${active ? 'text-fg' : 'text-fg-muted'}`}>{sample.title}</span>
                      <span className="mt-0.5 block truncate text-[11px] text-fg-dim">{sample.subtitle}</span>
                    </span>
                    <ChevronRight
                      size={13}
                      className={`mt-1 shrink-0 transition ${active ? 'text-accent' : 'text-transparent group-hover:text-fg-dim'}`}
                    />
                  </button>
                </li>
              );
            })}
          </ul>

          <div className="mt-6 mb-2 flex items-center justify-between px-1">
            <div className="flex items-center gap-1.5">
              <History size={12} className="text-fg-dim" />
              <span className="label">History</span>
            </div>
            {history.length > 0 && (
              <button
                type="button"
                onClick={onClearHistory}
                className="text-[10.5px] text-fg-dim transition hover:text-danger"
              >
                Clear
              </button>
            )}
          </div>

          {history.length === 0 ? (
            <p className="px-1.5 py-2 text-[11.5px] leading-relaxed text-fg-dim">
              Diagnoses you run are stored in this browser only.
            </p>
          ) : (
            <ul className="space-y-0.5">
              {history.slice(0, 8).map((entry) => (
                <li key={entry.id} className="group relative">
                  <button
                    type="button"
                    onClick={() => onRestoreHistory(entry)}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-white/[0.03]"
                  >
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                        statusTone(entry.draft.statusCode) === 'danger'
                          ? 'bg-danger'
                          : statusTone(entry.draft.statusCode) === 'warn'
                            ? 'bg-warn'
                            : statusTone(entry.draft.statusCode) === 'ok'
                              ? 'bg-ok'
                              : 'bg-fg-dim'
                      }`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] text-fg-muted">{entry.response.diagnosis.title}</span>
                      <span className="text-[10.5px] text-fg-dim">
                        {entry.draft.statusCode || 'no status'} · {relativeTime(entry.createdAt)}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onDeleteHistory(entry.id)}
                    className="absolute right-1 top-1/2 hidden -translate-y-1/2 rounded p-1 text-fg-dim hover:bg-white/5 hover:text-danger group-hover:block"
                    aria-label="Delete history entry"
                  >
                    <Trash2 size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </nav>

        <div className="border-t border-line p-3">
          <button
            type="button"
            onClick={() => setShowConnect((value) => !value)}
            className="flex w-full items-center gap-2 rounded-lg border border-line bg-ink-850 px-2.5 py-2 text-left transition hover:border-line-strong"
            aria-expanded={showConnect}
          >
            <span className="relative flex h-2 w-2">
              <span
                className={`absolute inline-flex h-full w-full rounded-full ${
                  connected ? 'bg-ok animate-pulse-dot' : providerError ? 'bg-danger' : 'bg-warn'
                }`}
              />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[11.5px] font-medium text-fg-muted">
                {providerError ? 'API unreachable' : connected ? 'Open model connected' : 'Local engine'}
              </span>
              <span className="block truncate font-mono text-[10px] text-fg-dim">
                {providerError ? 'start the server on :8787' : connected ? provider?.model : 'no model configured'}
              </span>
            </span>
            <Cpu size={13} className="text-fg-dim" />
          </button>

          {showConnect && (
            <div className="mt-2 animate-fade-up space-y-2 rounded-lg border border-line bg-ink-850 p-2.5">
              <p className="text-[11px] leading-relaxed text-fg-muted">
                {connected
                  ? `Diagnoses are sent to ${provider?.baseUrlHost ?? 'the configured provider'}. Keys stay on the server.`
                  : 'Add an OpenAI-compatible endpoint to the server .env and restart. No key ever reaches the browser.'}
              </p>
              <CodeBlock
                label="server/.env"
                maxHeight="9rem"
                code={`AI_BASE_URL=https://your-open-model/v1\nAI_MODEL=your-model-id\nAI_API_KEY=...`}
              />
              <p className="flex items-start gap-1.5 text-[10.5px] leading-relaxed text-fg-dim">
                <ShieldCheck size={12} className="mt-0.5 shrink-0 text-ok/80" />
                Local mode still works with no key: the deterministic engine diagnoses requests on its own.
              </p>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
