import type { ConfidenceLabel } from './types';

export function statusTone(code: string | number | null): 'ok' | 'warn' | 'danger' | 'info' | 'muted' {
  const value = typeof code === 'string' ? Number(code) : code;
  if (!value || Number.isNaN(value)) return 'muted';
  if (value >= 200 && value < 300) return 'ok';
  if (value >= 300 && value < 400) return 'info';
  if (value >= 400 && value < 500) return value === 429 ? 'warn' : 'danger';
  if (value >= 500) return 'danger';
  return 'muted';
}

export const STATUS_STYLES: Record<string, string> = {
  ok: 'bg-ok/10 text-ok border-ok/30',
  warn: 'bg-warn/10 text-warn border-warn/30',
  danger: 'bg-danger/10 text-danger border-danger/30',
  info: 'bg-info/10 text-info border-info/30',
  muted: 'bg-white/5 text-fg-muted border-line-strong',
};

export const CONFIDENCE_STYLES: Record<ConfidenceLabel, string> = {
  high: 'bg-ok/10 text-ok border-ok/25',
  medium: 'bg-warn/10 text-warn border-warn/25',
  low: 'bg-white/5 text-fg-muted border-line-strong',
};

export function prettyJson(raw: string): string | null {
  if (!raw.trim()) return null;
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return null;
  }
}

export function looksLikeJson(raw: string): boolean {
  const trimmed = raw.trim();
  return (trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'));
}

export function relativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(timestamp).toLocaleDateString();
}

export function truncate(value: string, max: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max)}…` : compact;
}

export function confidencePercent(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 100);
}

export async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = value;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(area);
      return ok;
    } catch {
      return false;
    }
  }
}

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

export const METHOD_STYLES: Record<string, string> = {
  GET: 'text-info',
  POST: 'text-ok',
  PUT: 'text-warn',
  PATCH: 'text-accent',
  DELETE: 'text-danger',
  HEAD: 'text-fg-muted',
  OPTIONS: 'text-fg-muted',
};
