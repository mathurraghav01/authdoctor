import { z } from 'zod';

export const MAX_FIELD = 40_000;

export const diagnosisInputSchema = z.object({
  method: z
    .string()
    .trim()
    .max(10)
    .default('GET')
    .transform((value) => value.toUpperCase()),
  url: z.string().trim().max(2_000).default(''),
  statusCode: z
    .union([z.number().int().min(100).max(599), z.literal(''), z.null()])
    .optional()
    .transform((value) => (typeof value === 'number' ? value : null)),
  requestHeaders: z.string().max(MAX_FIELD).default(''),
  requestBody: z.string().max(MAX_FIELD).default(''),
  responseBody: z.string().max(MAX_FIELD).default(''),
  errorMessage: z.string().max(4_000).default(''),
  logs: z.string().max(MAX_FIELD).default(''),
});

export type DiagnosisInput = z.infer<typeof diagnosisInputSchema>;

const confidenceLabel = z.enum(['high', 'medium', 'low']);

export const diagnosisSchema = z.object({
  title: z.string().min(3).max(120),
  summary: z.string().min(20).max(1_200),
  likelyCause: z.object({
    cause: z.string().min(3).max(300),
    confidence: confidenceLabel,
    rationale: z.string().min(10).max(800),
  }),
  confidence: z.number().min(0).max(1),
  evidence: z
    .array(
      z.object({
        source: z.enum(['status', 'request', 'response', 'logs', 'token', 'network']),
        detail: z.string().min(3).max(500),
        verified: z.boolean(),
      }),
    )
    .min(1)
    .max(12),
  alternatives: z
    .array(
      z.object({
        cause: z.string().min(3).max(300),
        likelihood: confidenceLabel,
        note: z.string().max(400),
      }),
    )
    .max(6),
  steps: z
    .array(
      z.object({
        title: z.string().min(3).max(160),
        detail: z.string().min(3).max(700),
        command: z.string().max(600).optional(),
      }),
    )
    .min(2)
    .max(10),
  fix: z.object({
    summary: z.string().min(5).max(1_000),
    code: z
      .object({
        language: z.string().min(1).max(30),
        content: z.string().min(1).max(4_000),
      })
      .optional(),
    notes: z.array(z.string().max(400)).max(8),
  }),
  curl: z.string().max(4_000).nullable(),
  securityRisks: z
    .array(
      z.object({
        risk: z.string().min(3).max(200),
        severity: confidenceLabel,
        detail: z.string().min(3).max(500),
      }),
    )
    .max(8),
  verifiedFindings: z.array(z.string().max(300)).max(10),
  likelyFindings: z.array(z.string().max(300)).max(10),
  needsMoreInfo: z.array(z.string().max(300)).max(8),
});

export type Diagnosis = z.infer<typeof diagnosisSchema>;

export type Engine = 'model' | 'local' | 'local-fallback';

export interface DiagnosisResponse {
  diagnosis: Diagnosis;
  /** Sanitised copy of the submitted request, safe for client-side history. */
  redactedInput: DiagnosisInput;
  engine: Engine;
  model: string | null;
  analyzedAt: string;
  redactions: { total: number; kinds: string[] };
  notes: string[];
}

export const chatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(8_000),
});

export const chatRequestSchema = z.object({
  messages: z.array(chatMessageSchema).min(1).max(24),
  context: diagnosisInputSchema.optional(),
  diagnosis: diagnosisSchema.nullable().optional(),
});

export type ChatMessage = z.infer<typeof chatMessageSchema>;
