export type Engine = 'model' | 'local' | 'local-fallback';

export interface RequestDraft {
  method: string;
  url: string;
  statusCode: string;
  requestHeaders: string;
  requestBody: string;
  responseBody: string;
  errorMessage: string;
  logs: string;
}

export interface Sample {
  id: string;
  title: string;
  subtitle: string;
  tag: string;
  tone: 'danger' | 'warn' | 'info';
  draft: RequestDraft;
}

export type EvidenceSource = 'status' | 'request' | 'response' | 'logs' | 'token' | 'network';
export type ConfidenceLabel = 'high' | 'medium' | 'low';

export interface Evidence {
  source: EvidenceSource;
  detail: string;
  verified: boolean;
}

export interface Diagnosis {
  title: string;
  summary: string;
  likelyCause: { cause: string; confidence: ConfidenceLabel; rationale: string };
  confidence: number;
  evidence: Evidence[];
  alternatives: Array<{ cause: string; likelihood: ConfidenceLabel; note: string }>;
  steps: Array<{ title: string; detail: string; command?: string }>;
  fix: { summary: string; code?: { language: string; content: string }; notes: string[] };
  curl: string | null;
  securityRisks: Array<{ risk: string; severity: ConfidenceLabel; detail: string }>;
  verifiedFindings: string[];
  likelyFindings: string[];
  needsMoreInfo: string[];
}

export interface DiagnosisResponse {
  diagnosis: Diagnosis;
  redactedInput: Omit<RequestDraft, 'statusCode'> & { statusCode: number | null };
  engine: Engine;
  model: string | null;
  analyzedAt: string;
  redactions: { total: number; kinds: string[] };
  notes: string[];
}

export interface ProviderStatus {
  mode: 'model' | 'local';
  model: string | null;
  baseUrlHost: string | null;
  hasApiKey: boolean;
  aiConfigured: boolean;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  actions?: Array<{ name: string; label: string }>;
  engine?: Engine;
  notes?: string[];
}

export interface ChatResponse {
  reply: string;
  actions: Array<{ name: string; label: string }>;
  engine: Engine;
  model: string | null;
  notes: string[];
}

export interface HistoryEntry {
  id: string;
  createdAt: number;
  draft: RequestDraft;
  response: DiagnosisResponse;
}
