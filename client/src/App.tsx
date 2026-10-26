import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Cpu, Loader2, Menu, MessageSquare, Plus, Sparkles, Stethoscope, X } from 'lucide-react';
import { Sidebar } from './components/Sidebar';
import { RequestEditor, ResponseEditor } from './components/Editors';
import { DiagnoseBar } from './components/DiagnoseBar';
import { DiagnosisPanel } from './components/DiagnosisPanel';
import { AssistantPanel } from './components/AssistantPanel';
import { EMPTY_DRAFT, SAMPLES } from './data/samples';
import { ApiError, diagnose, getProvider, sendChat } from './lib/api';
import type { ChatMessage, DiagnosisResponse, HistoryEntry, ProviderStatus, RequestDraft, Sample } from './lib/types';
import { STATUS_STYLES, statusTone, truncate } from './lib/format';

const HISTORY_KEY = 'authdoctor.history.v1';
const MAX_HISTORY = 12;

function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as HistoryEntry[];
    return Array.isArray(parsed) ? parsed.filter((entry) => entry?.response?.diagnosis).slice(0, MAX_HISTORY) : [];
  } catch {
    return [];
  }
}

function draftFromPayload(payload: DiagnosisResponse['redactedInput']): RequestDraft {
  return {
    method: payload.method,
    url: payload.url,
    statusCode: payload.statusCode === null ? '' : String(payload.statusCode),
    requestHeaders: payload.requestHeaders,
    requestBody: payload.requestBody,
    responseBody: payload.responseBody,
    errorMessage: payload.errorMessage,
    logs: payload.logs,
  };
}

function uid() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

export default function App() {
  const [draft, setDraft] = useState<RequestDraft>(EMPTY_DRAFT);
  const [activeSampleId, setActiveSampleId] = useState<string | null>(null);
  const [result, setResult] = useState<DiagnosisResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ message: string; details?: string[] } | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>(loadHistory);
  const [provider, setProvider] = useState<ProviderStatus | null>(null);
  const [providerError, setProviderError] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [tab, setTab] = useState<'diagnosis' | 'assistant'>('diagnosis');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<number | null>(null);

  const toast = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 2600);
  }, []);

  useEffect(() => {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  }, [history]);

  useEffect(() => {
    let cancelled = false;
    getProvider()
      .then((status) => {
        if (cancelled) return;
        setProvider(status);
        setProviderError(false);
      })
      .catch(() => {
        if (!cancelled) setProviderError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const patchDraft = useCallback((patch: Partial<RequestDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setActiveSampleId(null);
    // A diagnosis describes one exact request; never show it for an edited one.
    setResult((current) => (current ? null : current));
  }, []);

  const reset = useCallback(() => {
    setDraft(EMPTY_DRAFT);
    setResult(null);
    setError(null);
    setActiveSampleId(null);
    setMessages([]);
    setTab('diagnosis');
    toast('Workspace cleared');
  }, [toast]);

  const runDiagnosis = useCallback(async () => {
    if (loading) return;
    setLoading(true);
    setError(null);
    setTab('diagnosis');
    try {
      const response = await diagnose(draft);
      setResult(response);
      const entry: HistoryEntry = {
        id: uid(),
        createdAt: Date.now(),
        draft: draftFromPayload(response.redactedInput),
        response,
      };
      setHistory((current) => [entry, ...current].slice(0, MAX_HISTORY));
    } catch (caught) {
      const apiError = caught instanceof ApiError ? caught : null;
      setError({
        message: apiError?.message ?? 'Something went wrong while diagnosing this request.',
        details: apiError?.details,
      });
    } finally {
      setLoading(false);
    }
  }, [draft, loading]);

  const ask = useCallback(
    async (text: string, options?: { switchTab?: boolean }) => {
      if (sending) return;
      if (options?.switchTab !== false) setTab('assistant');

      const userMessage: ChatMessage = { id: uid(), role: 'user', content: text };
      const nextMessages = [...messages, userMessage];
      setMessages(nextMessages);
      setSending(true);

      try {
        const response = await sendChat(
          nextMessages.map((message) => ({ role: message.role, content: message.content })),
          draft,
          result,
        );
        setMessages((current) => [
          ...current,
          {
            id: uid(),
            role: 'assistant',
            content: response.reply,
            actions: response.actions,
            engine: response.engine,
            notes: response.notes,
          },
        ]);
      } catch (caught) {
        const apiError = caught instanceof ApiError ? caught : null;
        setMessages((current) => [
          ...current,
          {
            id: uid(),
            role: 'assistant',
            content: `I could not reach the assistant. ${apiError?.message ?? 'Check that the API server is running and try again.'}`,
            engine: 'local-fallback',
          },
        ]);
      } finally {
        setSending(false);
      }
    },
    [draft, messages, result, sending],
  );

  const loadSample = useCallback((sample: Sample) => {
    setDraft(sample.draft);
    setActiveSampleId(sample.id);
    setResult(null);
    setError(null);
    setMessages([]);
    setTab('diagnosis');
    setSidebarOpen(false);
  }, []);

  const restoreHistory = useCallback((entry: HistoryEntry) => {
    setDraft(entry.draft);
    setResult(entry.response);
    setActiveSampleId(null);
    setError(null);
    setMessages([]);
    setTab('diagnosis');
    setSidebarOpen(false);
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key === 'Enter') {
        event.preventDefault();
        void runDiagnosis();
      }
      if (meta && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        reset();
      }
      if (event.key === 'Escape') setSidebarOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [reset, runDiagnosis]);

  const hasContext = useMemo(
    () => Boolean(draft.url || draft.statusCode || draft.requestHeaders || draft.responseBody || draft.errorMessage || draft.logs),
    [draft],
  );

  return (
    <div className="flex h-[100dvh] overflow-hidden bg-ink-950">
      <Sidebar
        samples={SAMPLES}
        activeSampleId={activeSampleId}
        onSelectSample={loadSample}
        history={history}
        onRestoreHistory={restoreHistory}
        onDeleteHistory={(id) => setHistory((current) => current.filter((entry) => entry.id !== id))}
        onClearHistory={() => {
          setHistory([]);
          toast('History cleared');
        }}
        provider={provider}
        providerError={providerError}
        onNew={reset}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-[52px] shrink-0 items-center gap-2 border-b border-line bg-ink-900/60 px-3 backdrop-blur sm:px-4">
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            className="btn-quiet -ml-1 p-1.5 lg:hidden"
            aria-label="Open navigation"
          >
            <Menu size={17} />
          </button>

          <div className="flex min-w-0 items-center gap-2">
            <Activity size={14} className="shrink-0 text-accent lg:hidden" />
            <div className="flex min-w-0 items-center gap-1.5 text-[12px]">
              <span className="hidden text-fg-dim sm:inline">Workspace</span>
              <span className="hidden text-fg-dim/50 sm:inline">/</span>
              <span className="truncate font-mono text-fg-muted">
                {draft.method} {draft.url ? truncate(draft.url.replace(/^https?:\/\//, ''), 46) : 'new request'}
              </span>
              <span className={`chip shrink-0 font-mono text-[10px] ${STATUS_STYLES[statusTone(draft.statusCode)]}`}>
                {draft.statusCode || '---'}
              </span>
            </div>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <div className="hidden items-center gap-1.5 rounded-md border border-line bg-ink-850 px-2 py-1 text-[10.5px] text-fg-dim sm:flex">
              {providerError ? (
                <>
                  <span className="h-1.5 w-1.5 rounded-full bg-danger" />
                  API offline
                </>
              ) : provider?.mode === 'model' ? (
                <>
                  <Sparkles size={11} className="text-ok" />
                  <span className="max-w-[140px] truncate text-fg-muted">{provider.model}</span>
                </>
              ) : (
                <>
                  <Cpu size={11} className="text-warn" />
                  Local engine
                </>
              )}
            </div>
            <button type="button" onClick={reset} className="btn-ghost px-2 py-1.5 text-[11.5px]" title="New diagnosis (⌘K)">
              <Plus size={13} />
              <span className="hidden sm:inline">New</span>
            </button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden xl:flex-row xl:overflow-hidden">
          <main className="flex min-h-0 min-w-0 flex-col xl:flex-1">
            <div className="min-w-0 overflow-x-hidden px-3 pt-3 sm:px-4 sm:pt-4 xl:scrollbar-thin xl:min-h-0 xl:flex-1 xl:overflow-y-auto">
              <RequestEditor draft={draft} onChange={patchDraft} disabled={loading} />
              <div className="mt-3">
                <ResponseEditor draft={draft} onChange={patchDraft} disabled={loading} />
              </div>
              <div className="h-4" />
            </div>
            <div className="px-3 sm:px-4">
              <DiagnoseBar
                draft={draft}
                loading={loading}
                error={error?.message ?? null}
                details={error?.details}
                hasResult={Boolean(result)}
                onDiagnose={runDiagnosis}
                onReset={reset}
              />
            </div>
          </main>

          <aside className="flex w-full flex-col border-t border-line bg-ink-900/40 xl:min-h-0 xl:w-[444px] xl:shrink-0 xl:border-l xl:border-t-0 2xl:w-[480px]">
            <div className="sticky top-0 z-10 flex h-[46px] shrink-0 items-center gap-1 border-b border-line bg-ink-900/95 px-3 backdrop-blur xl:static xl:bg-transparent">
              <button
                type="button"
                onClick={() => setTab('diagnosis')}
                className={`flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] font-medium transition ${
                  tab === 'diagnosis' ? 'bg-white/[0.06] text-fg' : 'text-fg-dim hover:text-fg-muted'
                }`}
              >
                <Stethoscope size={13} />
                Diagnosis
                {result && (
                  <span className="ml-0.5 rounded bg-accent/15 px-1 font-mono text-[9px] text-accent">
                    {Math.round(result.diagnosis.confidence * 100)}
                  </span>
                )}
              </button>
              <button
                type="button"
                onClick={() => setTab('assistant')}
                className={`flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] font-medium transition ${
                  tab === 'assistant' ? 'bg-white/[0.06] text-fg' : 'text-fg-dim hover:text-fg-muted'
                }`}
              >
                <MessageSquare size={13} />
                Assistant
                {messages.length > 0 && (
                  <span className="ml-0.5 rounded bg-white/[0.07] px-1 font-mono text-[9px] text-fg-muted">{messages.length}</span>
                )}
              </button>

              <div className="ml-auto flex items-center gap-1.5 text-[9.5px] uppercase tracking-wider text-fg-dim">
                {result ? (
                  result.engine === 'model' ? (
                    <>
                      <Sparkles size={10} className="text-ok" /> model
                    </>
                  ) : (
                    <>
                      <Cpu size={10} className="text-warn" /> {result.engine === 'local-fallback' ? 'fallback' : 'local'}
                    </>
                  )
                ) : provider?.mode === 'model' ? (
                  <>
                    <Sparkles size={10} className="text-ok" /> ready
                  </>
                ) : (
                  <>
                    <Cpu size={10} className="text-warn" /> local
                  </>
                )}
              </div>
            </div>

            <div className="min-h-0 xl:scrollbar-thin xl:flex-1 xl:overflow-y-auto">
              {tab === 'diagnosis' ? (
                <DiagnosisPanel
                  result={result}
                  loading={loading}
                  error={error?.message ?? null}
                  draft={draft}
                  onLoadSample={() => loadSample(SAMPLES[0]!)}
                  onAsk={(prompt) => void ask(prompt)}
                />
              ) : (
                <AssistantPanel
                  messages={messages}
                  sending={sending}
                  onSend={(text) => void ask(text, { switchTab: false })}
                  onClear={() => setMessages([])}
                  provider={provider}
                  hasContext={hasContext}
                />
              )}
            </div>
          </aside>
        </div>
      </div>

      {notice && (
        <div className="pointer-events-none fixed bottom-5 left-1/2 z-[60] -translate-x-1/2 animate-fade-up rounded-lg border border-line-strong bg-ink-800 px-3 py-2 text-[11.5px] text-fg shadow-panel">
          {notice}
        </div>
      )}

      {loading && (
        <div className="pointer-events-none fixed inset-x-0 top-0 z-[70] h-0.5 overflow-hidden">
          <div className="h-full w-1/3 animate-[shimmer_1.2s_linear_infinite] bg-gradient-to-r from-transparent via-accent to-transparent bg-[length:200%_100%]" />
        </div>
      )}

      {sending && tab !== 'assistant' && (
        <button
          type="button"
          onClick={() => setTab('assistant')}
          className="fixed bottom-20 right-4 z-50 flex items-center gap-2 rounded-full border border-accent/30 bg-ink-800 px-3 py-2 text-[11px] text-fg shadow-panel"
        >
          <Loader2 size={12} className="animate-spin text-accent" />
          Assistant is answering
          <X size={11} className="text-fg-dim" onClick={() => setTab('assistant')} />
        </button>
      )}
    </div>
  );
}
