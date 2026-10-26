import { Router } from 'express';
import { aiConfigured } from '../config.js';
import { chatRequestSchema } from '../schema.js';
import { AiError, chatWithModel } from '../services/ai.js';
import { runLocalAssistant, toolContext } from '../services/assistant.js';
import { redactInput } from '../utils/redact.js';

export const chatRouter = Router();

chatRouter.post('/chat', async (req, res, next) => {
  try {
    const parsed = chatRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: 'Invalid chat payload.',
        details: parsed.error.issues.slice(0, 6).map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`),
      });
      return;
    }

    const { messages, context, diagnosis } = parsed.data;
    const redacted = context ? redactInput(context) : null;
    const lastUser = [...messages].reverse().find((message) => message.role === 'user');
    if (!lastUser) {
      res.status(400).json({ error: 'A user message is required.' });
      return;
    }

    // Deterministic actions first: the conversation drives real workspace
    // operations (diagnosis, curl generation, status comparison), and those
    // results become grounding for the model.
    // Local actions run on the raw input in memory so JWT claims stay
    // verifiable; only the model payload below uses the redacted copy.
    const local = runLocalAssistant(lastUser.content, context ?? null, diagnosis ?? null);
    const actions = local.actions.map((action) => ({ name: action.name, label: action.label }));

    if (!aiConfigured) {
      res.json({
        reply: local.reply,
        actions,
        engine: 'local',
        model: null,
        notes: ['Local mode: replies come from the deterministic intent router, not a language model.'],
      });
      return;
    }

    try {
      const reply = await chatWithModel(messages, {
        input: redacted?.input ?? null,
        diagnosis: local.diagnosis,
        toolResults: toolContext(local.diagnosis, local.actions),
      });
      res.json({ reply, actions, engine: 'model', model: null, notes: [] });
    } catch (error) {
      if (!(error instanceof AiError)) throw error;
      res.json({
        reply: local.reply,
        actions,
        engine: 'local-fallback',
        model: null,
        notes: [`Model unavailable (${error.message}). Answered with the local assistant instead.`],
      });
    }
  } catch (error) {
    next(error);
  }
});
