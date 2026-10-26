import { Router } from 'express';
import { ZodError } from 'zod';
import { aiConfigured, providerStatus } from '../config.js';
import { diagnosisInputSchema, type DiagnosisResponse } from '../schema.js';
import { AiError, diagnoseWithModel } from '../services/ai.js';
import { redactInput } from '../utils/redact.js';
import { runLocalDiagnosis } from '../services/localEngine.js';
import { REDACTION_NOTE } from '../utils/redact.js';

export const diagnoseRouter = Router();

diagnoseRouter.post('/diagnose', async (req, res, next) => {
  try {
    const parsed = diagnosisInputSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request payload.', details: formatIssues(parsed.error) });
      return;
    }

    const raw = parsed.data;
    const hasContent = Boolean(
      raw.url || raw.requestHeaders || raw.requestBody || raw.responseBody || raw.errorMessage || raw.logs || raw.statusCode,
    );

    if (!hasContent) {
      res.status(400).json({
        error: 'Nothing to diagnose yet.',
        details: ['Provide at least a status code, response body, error message or server logs.'],
      });
      return;
    }

    const { input, findings } = redactInput(raw);
    const redactions = {
      total: findings.reduce((sum, finding) => sum + finding.count, 0),
      kinds: [...new Set(findings.map((finding) => finding.kind))],
    };

    if (aiConfigured) {
      try {
        const result = await diagnoseWithModel(input);
        const payload: DiagnosisResponse = {
          diagnosis: result.diagnosis,
          redactedInput: input,
          engine: 'model',
          model: result.model,
          analyzedAt: new Date().toISOString(),
          redactions,
          notes: [REDACTION_NOTE, ...result.notes],
        };
        res.json(payload);
        return;
      } catch (error) {
        if (!(error instanceof AiError)) throw error;

        const reason =
          error.code === 'timeout'
            ? 'The model timed out.'
            : error.code === 'invalid_output'
              ? 'The model response did not pass validation.'
              : 'The model request failed.';

        const diagnosis = runLocalDiagnosis(raw);
        const payload: DiagnosisResponse = {
          diagnosis,
          redactedInput: input,
          engine: 'local-fallback',
          model: null,
          analyzedAt: new Date().toISOString(),
          redactions,
          notes: [
            REDACTION_NOTE,
            `${reason} Showing the deterministic local analysis instead.`,
            error.message,
          ],
        };
        res.json(payload);
        return;
      }
    }

    const payload: DiagnosisResponse = {
      diagnosis: runLocalDiagnosis(raw),
      redactedInput: input,
      engine: 'local',
      model: null,
      analyzedAt: new Date().toISOString(),
      redactions,
      notes: [
        REDACTION_NOTE,
        'Local mode: no model provider is configured, so this diagnosis comes from AuthDoctor\'s deterministic rule engine. Verified findings are computed from your input; everything else is labelled as likely.',
      ],
    };
    res.json(payload);
  } catch (error) {
    next(error);
  }
});

diagnoseRouter.get('/provider', (_req, res) => {
  res.json({ ...providerStatus(), aiConfigured });
});

function formatIssues(error: ZodError): string[] {
  return error.issues.slice(0, 8).map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`);
}
