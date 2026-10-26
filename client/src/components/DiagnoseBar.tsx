import { useEffect, useState } from 'react';
import { AlertCircle, Loader2, RotateCcw, ShieldAlert, Sparkles, Stethoscope } from 'lucide-react';
import type { RequestDraft } from '../lib/types';
import { previewRedactions } from '../lib/redactPreview';

interface Props {
  draft: RequestDraft;
  loading: boolean;
  error: string | null;
  details?: string[];
  hasResult: boolean;
  onDiagnose: () => void;
  onReset: () => void;
}

const LOADING_STEPS = ['Redacting credentials', 'Reading request and response', 'Reasoning about the failure', 'Assembling the diagnosis'];

export function DiagnoseBar({ draft, loading, error, details, hasResult, onDiagnose, onReset }: Props) {
  const [step, setStep] = useState(0);
  const preview = previewRedactions(draft);
  const hasPlaceholders = [draft.requestHeaders, draft.requestBody, draft.responseBody, draft.errorMessage, draft.logs].some((value) =>
    value.includes('[REDACTED:'),
  );
  const empty = !draft.url && !draft.statusCode && !draft.responseBody && !draft.errorMessage && !draft.logs;

  useEffect(() => {
    if (!loading) {
      setStep(0);
      return;
    }
    const timer = setInterval(() => setStep((value) => Math.min(value + 1, LOADING_STEPS.length - 1)), 1400);
    return () => clearInterval(timer);
  }, [loading]);

  return (
    // Sticky only once the diagnosis panel is a separate column (xl+). Below
    // that the panel scrolls under this bar, so a sticky bar would cover the
    // result it just produced.
    <div className="z-20 -mx-4 mt-1 border-t border-line bg-ink-950/92 px-4 py-3 backdrop-blur xl:sticky xl:bottom-0">
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          {error ? (
            <div className="flex items-start gap-2 text-[11.5px] text-danger">
              <AlertCircle size={14} className="mt-0.5 shrink-0" />
              <div>
                <p className="font-medium">{error}</p>
                {details && details.length > 0 && <p className="mt-0.5 text-danger/70">{details.join(' · ')}</p>}
              </div>
            </div>
          ) : loading ? (
            <div className="flex items-center gap-2 text-[11.5px] text-fg-muted">
              <Loader2 size={13} className="animate-spin text-accent" />
              <span>{LOADING_STEPS[step]}…</span>
              <span className="hidden text-fg-dim sm:inline">This usually takes a few seconds.</span>
            </div>
          ) : preview.count > 0 ? (
            <div className="flex items-start gap-2 text-[11.5px] text-warn">
              <ShieldAlert size={14} className="mt-0.5 shrink-0" />
              <p>
                <span className="font-medium">
                  {preview.count} possible secret{preview.count === 1 ? '' : 's'} detected
                </span>{' '}
                <span className="text-warn/75">
                  ({preview.kinds.join(', ')}) — redacted before analysis and never sent to a model.
                </span>
              </p>
            </div>
          ) : hasPlaceholders ? (
            <p className="flex items-center gap-1.5 text-[11.5px] text-warn/90">
              <ShieldAlert size={12} />
              Restored snapshot: credentials are placeholders. Paste a fresh token before re-running.
            </p>
          ) : (
            <p className="flex items-center gap-1.5 text-[11.5px] text-fg-dim">
              <Sparkles size={12} />
              {empty ? 'Load a sample or paste a failing request to get started.' : 'Bearer tokens, cookies and API keys are redacted before analysis.'}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button type="button" onClick={onReset} className="btn-ghost px-2.5 py-2 text-[12px]" disabled={loading}>
            <RotateCcw size={13} />
            <span className="hidden sm:inline">Reset</span>
          </button>
          <button
            type="button"
            onClick={onDiagnose}
            disabled={loading || empty}
            className="btn-primary px-4 py-2 text-[13px]"
            title="Diagnose (⌘⏎)"
          >
            {loading ? <Loader2 size={15} className="animate-spin" /> : <Stethoscope size={15} />}
            {loading ? 'Diagnosing…' : hasResult ? 'Diagnose again' : 'Diagnose API request'}
            {!loading && <span className="ml-1 hidden font-mono text-[10px] text-white/60 sm:inline">⌘⏎</span>}
          </button>
        </div>
      </div>
    </div>
  );
}
