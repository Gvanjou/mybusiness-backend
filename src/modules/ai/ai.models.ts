import { createHash } from 'node:crypto'
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

// How the model picker shows them. flash = smarter, 20 a day; lite = quicker and lighter, 500 a day.
export const MODEL_INFO: Record<string, { name: string; tier: 'flash' | 'lite' }> = {
  'gemini-3.8-flash': { name: 'Gemini 3.8 Flash', tier: 'flash' },
  'gemini-3.7-flash': { name: 'Gemini 3.7 Flash', tier: 'flash' },
  'gemini-3.6-flash': { name: 'Gemini 3.6 Flash', tier: 'flash' },
  'gemini-3.5-flash': { name: 'Gemini 3.5 Flash', tier: 'flash' },
  'gemini-3-flash-preview': { name: 'Gemini 3 Flash', tier: 'flash' },
  'gemini-3.5-flash-lite': { name: 'Gemini 3.5 Flash-Lite', tier: 'lite' },
  'gemini-3.1-flash-lite': { name: 'Gemini 3.1 Flash-Lite', tier: 'lite' },
  'gemini-3.1-flash-lite-preview': { name: 'Gemini 3.1 Flash-Lite (preview)', tier: 'lite' },
}

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

// Free-tier limits as Google AI Studio shows them for this project (Rate limit page, 2026-10-28): the Flash models
// allow 5 requests a minute and 20 a day, the Flash-Lite models 15 a minute and 500 a day. Pro, Omni and Argon have
// no free quota. Limits are per Google Cloud project and change: check https://aistudio.google.com/rate-limit and
// override with GEMINI_MODEL_LIMITS if yours differ.
const flash: ModelLimit = { rpm: 5, rpd: 20 }
const lite: ModelLimit = { rpm: 15, rpd: 500 }
const defaultLimits: Record<string, ModelLimit> = {
  'gemini-3.8-flash': flash,
  'gemini-3.7-flash': flash,
  'gemini-3.6-flash': flash,
  'gemini-3.5-flash': flash,
  'gemini-3-flash-preview': flash,
  'gemini-3.5-flash-lite': lite,
  'gemini-3.1-flash-lite': lite,
  'gemini-3.1-flash-lite-preview': lite,
  'gemini-embedding-2': { rpm: 100, rpd: 1000 },
}

export function limitFor(model: string): ModelLimit {
  // Unknown free models typically allow 20 requests a day.
  return env.GEMINI_MODEL_LIMITS[model] ?? defaultLimits[model] ?? { rpm: 5, rpd: 20 }
}

export const EMBEDDING_DIMENSIONS = 768

// Which Gemini key the usage log belongs to: a short hash, never the key. Quotas belong to the key's Google project,
// so a new key starts from zero.
export const KEY_ID = createHash('sha256').update(env.GEMINI_API_KEY).digest('hex').slice(0, 12)
