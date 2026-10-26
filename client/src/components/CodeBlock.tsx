import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { copyText } from '../lib/format';

interface Props {
  code: string;
  language?: string;
  label?: string;
  className?: string;
  maxHeight?: string;
  wrap?: boolean;
}

export function CodeBlock({ code, language, label, className = '', maxHeight = '20rem', wrap = false }: Props) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const ok = await copyText(code);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  };

  return (
    <div className={`group relative overflow-hidden rounded-lg border border-line bg-ink-950 ${className}`}>
      <div className="flex items-center justify-between border-b border-line/70 px-3 py-1.5">
        <span className="font-mono text-[10.5px] uppercase tracking-wider text-fg-dim">{label ?? language ?? 'shell'}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-fg-dim transition hover:bg-white/5 hover:text-fg"
          aria-label="Copy code"
        >
          {copied ? <Check size={12} className="text-ok" /> : <Copy size={12} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="scrollbar-thin overflow-auto p-3" style={{ maxHeight }}>
        <code className={`font-mono text-[12px] leading-relaxed text-[#c8d3e8] ${wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'}`}>{code}</code>
      </pre>
    </div>
  );
}
