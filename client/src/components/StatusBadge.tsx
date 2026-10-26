import { STATUS_STYLES, statusTone } from '../lib/format';

export function StatusBadge({ code, className = '' }: { code: string | number | null; className?: string }) {
  const value = code === null || code === '' ? null : String(code);
  const tone = statusTone(value);
  return (
    <span
      className={`chip font-mono tabular-nums ${STATUS_STYLES[tone]} ${className}`}
      title={value ? `HTTP ${value}` : 'No HTTP status'}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${tone === 'ok' ? 'bg-ok' : tone === 'warn' ? 'bg-warn' : tone === 'danger' ? 'bg-danger' : tone === 'info' ? 'bg-info' : 'bg-fg-dim'}`} />
      {value ?? 'no status'}
    </span>
  );
}

export function MethodBadge({ method }: { method: string }) {
  return (
    <span className="chip border-line-strong bg-white/[0.03] font-mono text-[10.5px] uppercase tracking-wide text-fg-muted">
      {method}
    </span>
  );
}
