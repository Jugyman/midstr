import express, { Request, Response } from 'express';
import OpenAI from 'openai';
import { z } from 'zod';

const router = express.Router();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const BET_CLASSIFICATION_MODEL =
  process.env.MIDSTR_CLASSIFICATION_MODEL || 'gpt-5-mini';
const BET_DECISION_MODEL =
  process.env.MIDSTR_DECISION_MODEL || 'gpt-5';
const MODERATION_MODEL =
  process.env.MIDSTR_MODERATION_MODEL || 'omni-moderation-latest';

const ClassificationRequestSchema = z.object({
  rawBetText: z.string().min(5),
  categoryHint: z.string().optional(),
  creatorTimezone: z.string().optional(),
});

const ProposeResultRequestSchema = z.object({
  betId: z.union([z.string(), z.number()]),
  classification: z.enum(['VERIFIABLE', 'AMBIGUOUS', 'MANUAL_ONLY']),
  betText: z.string().min(5),
  marketType: z.string().optional(),
  closeTimeIso: z.string().optional(),
  resultExpectedByIso: z.string().optional(),
  creatorClaim: z.string().optional(),
  takerClaim: z.string().optional(),
  evidence: z
    .array(
      z.object({
        id: z.string(),
        type: z.enum([
          'url',
          'text',
          'image_note',
          'screenshot_note',
          'manual_note',
        ]),
        title: z.string().optional(),
        content: z.string().min(1),
        sourceUrl: z.string().optional(),
      })
    )
    .min(1),
});

const DisputeReviewRequestSchema = z.object({
  betId: z.union([z.string(), z.number()]),
  originalDecision: z.object({
    winner: z.enum(['CREATOR', 'TAKER', 'NONE']),
    confidence: z.number().min(0).max(1),
    rationale: z.string(),
  }),
  disputeReason: z.string().min(5),
  newEvidence: z
    .array(
      z.object({
        id: z.string(),
        type: z.enum([
          'url',
          'text',
          'image_note',
          'screenshot_note',
          'manual_note',
        ]),
        title: z.string().optional(),
        content: z.string().min(1),
        sourceUrl: z.string().optional(),
      })
    )
    .min(1),
  betText: z.string().min(5),
  classification: z.enum(['VERIFIABLE', 'AMBIGUOUS', 'MANUAL_ONLY']),
});

async function runModeration(input: string) {
  const moderation = await openai.moderations.create({
    model: MODERATION_MODEL,
    input,
  });

  const result = moderation.results?.[0];

  return {
    flagged: Boolean(result?.flagged),
    categories: result?.categories ?? {},
    categoryScores: result?.category_scores ?? {},
  };
}

async function parseStructuredJson<T>(response: any): Promise<T> {
  const text = response.output_text;

  if (!text) {
    throw new Error('Model returned no output_text');
  }

  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(
      `Failed to parse model JSON: ${(error as Error).message}`
    );
  }
}

router.get('/health/ai', async (_req: Request, res: Response) => {
  const configured = Boolean(process.env.OPENAI_API_KEY);
  res.json({ ok: true, openaiConfigured: configured });
});

router.post('/ai/classify-bet', async (req: Request, res: Response) => {
  try {
    const input = ClassificationRequestSchema.parse(req.body);

    const moderation = await runModeration(input.rawBetText);
    if (moderation.flagged) {
      return res.status(400).json({
        ok: false,
        error: 'Bet text failed moderation checks.',
        moderation,
      });
    }

    const response = await openai.responses.create({
      model: BET_CLASSIFICATION_MODEL,
      store: false,
      input: [
        {
          role: 'system',
          content: [
            {
              type: 'input_text',
              text: [
                'You classify betting prompts for the MIDSTR Telegram bot.',
                'Return only valid JSON.',
                'Never include markdown or code fences.',
                'Classification must be one of: VERIFIABLE, AMBIGUOUS, MANUAL_ONLY.',
                'VERIFIABLE means an objective external result can be checked.',
                'AMBIGUOUS means partly objective but wording or evidence could be contested.',
                'MANUAL_ONLY means subjective, personal, aesthetic, or not objectively provable.',
                'Flag vague wording such as: best, better, nice, soon, viral, more popular, looks good.',
                'If needed, rewrite the bet into cleaner neutral wording without changing the meaning.',
                'Determine decisionType: EVENT_BASED if outcome depends on a real-world event or objective external condition.',
                'Determine decisionType: TIME_BASED if the bet is subjective, interpersonal, unclear, or requires a user-defined result window.',
                'Provide settlementBasis describing exactly what determines the winner.',
                'Estimate earliestCheckTime when the event is likely safely decidable.',
                'Provide latestDecisionTime as a safe fallback deadline for a check.',
                'For VERIFIABLE bets, needsResultExpectedBy should normally be false.',
                'For AMBIGUOUS and MANUAL_ONLY bets, needsResultExpectedBy should normally be true.',
                'If exact dates are missing, still make a best-effort estimate and explain what fields are missing.',
              ].join(' '),
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: JSON.stringify({
                rawBetText: input.rawBetText,
                categoryHint: input.categoryHint,
                creatorTimezone: input.creatorTimezone,
              }),
            },
          ],
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'midstr_bet_classification',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            required: [
              'cleanedDescription',
              'classification',
              'decisionType',
              'settlementBasis',
              'earliestCheckTime',
              'latestDecisionTime',
              'reason',
              'needsResultExpectedBy',
              'riskFlags',
              'requiredFields',
              'userWarning',
              'confidence',
            ],
            properties: {
              cleanedDescription: { type: 'string' },
              classification: {
                type: 'string',
                enum: ['VERIFIABLE', 'AMBIGUOUS', 'MANUAL_ONLY'],
              },
              decisionType: {
                type: 'string',
                enum: ['EVENT_BASED', 'TIME_BASED'],
              },
              settlementBasis: { type: 'string' },
              earliestCheckTime: { type: 'string' },
              latestDecisionTime: { type: 'string' },
              reason: { type: 'string' },
              needsResultExpectedBy: { type: 'boolean' },
              riskFlags: {
                type: 'array',
                items: { type: 'string' },
              },
              requiredFields: {
                type: 'array',
                items: { type: 'string' },
              },
              userWarning: { type: 'string' },
              confidence: { type: 'number' },
            },
          },
        },
      },
    });

    const parsed = await parseStructuredJson<{
      cleanedDescription: string;
      classification: 'VERIFIABLE' | 'AMBIGUOUS' | 'MANUAL_ONLY';
      decisionType: 'EVENT_BASED' | 'TIME_BASED';
      settlementBasis: string;
      earliestCheckTime: string;
      latestDecisionTime: string;
      reason: string;
      needsResultExpectedBy: boolean;
      riskFlags: string[];
      requiredFields: string[];
      userWarning: string;
      confidence: number;
    }>(response);

    res.json({ ok: true, moderation, result: parsed });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ ok: false, error: message });
  }
});

router.post('/ai/propose-result', async (req: Request, res: Response) => {
  try {
    const input = ProposeResultRequestSchema.parse(req.body);

    const response = await openai.responses.create({
      model: BET_DECISION_MODEL,
      store: false,
      input: [
        {
          role: 'system',
          content: [
            {
              type: 'input_text',
              text: [
                'You are the MIDSTR result proposal engine.',
                'Return only valid JSON.',
                'Base your answer only on the provided bet text and evidence bundle.',
                'Do not invent facts.',
                'If the evidence is weak or conflicting, prefer INSUFFICIENT_EVIDENCE.',
                'For AMBIGUOUS and MANUAL_ONLY bets, be conservative and escalate more often.',
              ].join(' '),
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: JSON.stringify(input),
            },
          ],
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'midstr_result_proposal',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            required: [
              'decision',
              'winner',
              'confidence',
              'rationale',
              'evidenceUsed',
              'missingEvidence',
              'disputeRecommended',
              'escalate',
            ],
            properties: {
              decision: {
                type: 'string',
                enum: [
                  'CREATOR_WINS',
                  'TAKER_WINS',
                  'INSUFFICIENT_EVIDENCE',
                  'MANUAL_REVIEW_REQUIRED',
                ],
              },
              winner: {
                type: 'string',
                enum: ['CREATOR', 'TAKER', 'NONE'],
              },
              confidence: { type: 'number' },
              rationale: { type: 'string' },
              evidenceUsed: {
                type: 'array',
                items: { type: 'string' },
              },
              missingEvidence: {
                type: 'array',
                items: { type: 'string' },
              },
              disputeRecommended: { type: 'boolean' },
              escalate: { type: 'boolean' },
            },
          },
        },
      },
    });

    const parsed = await parseStructuredJson<{
      decision:
        | 'CREATOR_WINS'
        | 'TAKER_WINS'
        | 'INSUFFICIENT_EVIDENCE'
        | 'MANUAL_REVIEW_REQUIRED';
      winner: 'CREATOR' | 'TAKER' | 'NONE';
      confidence: number;
      rationale: string;
      evidenceUsed: string[];
      missingEvidence: string[];
      disputeRecommended: boolean;
      escalate: boolean;
    }>(response);

    res.json({ ok: true, result: parsed });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ ok: false, error: message });
  }
});

router.post('/ai/dispute-review', async (req: Request, res: Response) => {
  try {
    const input = DisputeReviewRequestSchema.parse(req.body);

    const response = await openai.responses.create({
      model: BET_DECISION_MODEL,
      store: false,
      input: [
        {
          role: 'system',
          content: [
            {
              type: 'input_text',
              text: [
                'You are the MIDSTR dispute review engine.',
                'Return only valid JSON.',
                'Compare the original decision with the new dispute evidence.',
                'Do not invent facts.',
                'If the new evidence does not clearly justify a reversal, you may uphold the original decision.',
                'If the case remains uncertain, return INSUFFICIENT_EVIDENCE and escalate.',
              ].join(' '),
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: JSON.stringify(input),
            },
          ],
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'midstr_dispute_review',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            required: [
              'reviewDecision',
              'finalWinner',
              'confidence',
              'rationale',
              'overturned',
              'evidenceUsed',
              'escalate',
            ],
            properties: {
              reviewDecision: {
                type: 'string',
                enum: ['UPHOLD', 'OVERTURN', 'INSUFFICIENT_EVIDENCE'],
              },
              finalWinner: {
                type: 'string',
                enum: ['CREATOR', 'TAKER', 'NONE'],
              },
              confidence: { type: 'number' },
              rationale: { type: 'string' },
              overturned: { type: 'boolean' },
              evidenceUsed: {
                type: 'array',
                items: { type: 'string' },
              },
              escalate: { type: 'boolean' },
            },
          },
        },
      },
    });

    const parsed = await parseStructuredJson<{
      reviewDecision: 'UPHOLD' | 'OVERTURN' | 'INSUFFICIENT_EVIDENCE';
      finalWinner: 'CREATOR' | 'TAKER' | 'NONE';
      confidence: number;
      rationale: string;
      overturned: boolean;
      evidenceUsed: string[];
      escalate: boolean;
    }>(response);

    res.json({ ok: true, result: parsed });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ ok: false, error: message });
  }
});

export default router;