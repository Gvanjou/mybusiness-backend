import { ThinkingLevel } from '@google/genai'
import { env } from '../../pkg/env/env.js'

export type AiTask = 'responder' | 'search' | 'transcribe' | 'embedding'

// Defaults fit the free tier (Pro / Argon models have no free quota); a paid key can put Pro first via .env.
// Each task lists models in preference order. The gateway tries healthy models first (see quota.order)
// and moves to the next one on 429/5xx, timeouts or local quota.
// GEMINI_RESPONDER_MODELS in .env replaces the chat chain (e.g. a paid Pro model first).
// Every free Gemini model that answers with tools on this project (tested 2026-10-28), strongest first. Each has its
// own daily allowance, so the chat keeps answering on the next one when a model is busy (503) or used up (429).
// Pro, Omni and Argon have no free quota; Gemma models failed with tools; 2.5 is retired.
export const FREE_CHAT_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3-flash-preview',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-3.1-flash-lite-preview',
] as const

export const modelChains: Record<AiTask, readonly string[]> = {
  responder: env.GEMINI_RESPONDER_MODELS.length ? env.GEMINI_RESPONDER_MODELS : FREE_CHAT_MODELS,
  // Google Search / Maps grounding: the same pool, fastest first (the answer is only facts for the responder).
  search: ['gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash'],
  transcribe: ['gemini-3.5-flash-lite', 'gemini-3-flash-preview', 'gemini-3.1-flash-lite'],
  embedding: ['gemini-embedding-2'],
}

// The models the chat draws on; their daily allowances make up the total shown in the usage circle.
export function chatModels(): string[] {
  return [...new Set([...modelChains.responder, ...modelChains.search, ...modelChains.transcribe])]
}

export const thinkingByTask: Record<Exclude<AiTask, 'embedding'>, ThinkingLevel> = {
  responder: ThinkingLevel.LOW,
  search: ThinkingLevel.LOW,
  transcribe: ThinkingLevel.MINIMAL,
}

export type ModelLimit = { rpm: number; rpd: number }

// Free-tier defaults. Measured on 2026-10-27: gemini-3.8-flash, 3.7-flash, 3.6-flash and 3.5-flash allow 20 requests/day;
// Pro and Argon models have no free quota (limit 0), gemini-2.5-* are retired
// (quota GenerateRequestsPerDayPerProjectPerModel-FreeTier). Limits are per Google Cloud project and change:
// check https://aistudio.google.com/rate-limit and raise them with GEMINI_MODEL_LIMITS if yours are higher.
const defaultLimits: Record<string, ModelLimit> = {
  'gemini-3.5-flash-lite': { rpm: 10, rpd: 20 },
  'gemini-3.1-flash-lite': { rpm: 10, rpd: 20 },
  'gemini-3.1-flash-lite-preview': { rpm: 10, rpd: 20 },
  'gemini-3.8-flash': { rpm: 5, rpd: 20 },
  'gemini-3.7-flash': { rpm: 5, rpd: 20 },
  'gemini-3.5-flash': { rpm: 5, rpd: 20 },
  'gemini-3.6-flash': { rpm: 5, rpd: 20 },
  'gemini-3-flash-preview': { rpm: 5, rpd: 20 },
  'gemini-embedding-2': { rpm: 100, rpd: 1000 },
}

export function limitFor(model: string): ModelLimit {
  // Unknown free models typically allow 20 requests a day.
  return env.GEMINI_MODEL_LIMITS[model] ?? defaultLimits[model] ?? { rpm: 5, rpd: 20 }
}

export const EMBEDDING_DIMENSIONS = 768
