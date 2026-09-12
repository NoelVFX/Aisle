/**
 * Tier-3 cold resolution: the PICKER (aisle-pipeline.md §16.3, §16.4, §17).
 *
 * The model sees a numbered list of REAL actionable nodes and returns an
 * integer. Never a CSS selector, never coordinates, never prose. The index is
 * validated before anything touches the page. Controls that pay are filtered
 * out before the model ever sees the list.
 *
 * REPLAY_RESOLVER=1 replays recorded choices (matched by role + name) instead of
 * calling the model (§16.7). Rehearse with 0 so recordings are real.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ActionCandidate } from "../browser.js";
import { OPENROUTER_REQUEST_TIMEOUT_MS, type OpenRouterFetch } from "../computer-use.js";
import { InfraBlockedError, ResolutionExhaustedError } from "../../errors.js";
import { loadLimits } from "../../policy/policy.js";

export interface PickRequest {
  goal: string;
  /** `index` must equal array position. */
  candidates: ActionCandidate[];
  /** Stable key for recordings, e.g. `{billingOrigin}|units:5000|0`. */
  stepKey: string;
}

export interface PickResult {
  index: number;
  why: string;
  modelUsed: string | undefined;
  replayed: boolean;
}

export interface CandidatePicker {
  pick(request: PickRequest): Promise<PickResult>;
}

/**
 * Text-only picker profile. A fast non-reasoning model: the picker only returns an
 * index, and the free reasoning model stalled past the request timeout on live runs.
 * Measured 2026-09-12 on the picker prompt: flash-lite 0.5s, llama-3.3-70b 0.9s,
 * gpt-4.1-nano 1.7s, all correct. Override with OPENROUTER_PICKER_MODEL.
 */
export const PICKER_PROFILE = {
  model: "google/gemini-2.5-flash-lite",
  models: ["meta-llama/llama-3.3-70b-instruct", "openai/gpt-4.1-nano"] as readonly string[],
} as const;

export function formatCandidates(candidates: ActionCandidate[]): string {
  return candidates.map((c) => `[${c.index}] ${c.role} "${c.name}"${c.near ? ` near: ${c.near}` : ""}`).join("\n");
}

/** Parse `{"index": n, "why": "..."}` and validate n against the candidate count. */
export function parsePickerReply(text: string, count: number): { index: number; why: string } {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("RESOLVER_BAD_REPLY: no JSON object");
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    throw new Error("RESOLVER_BAD_REPLY: invalid JSON");
  }
  const index = Number(obj["index"]);
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new Error(`RESOLVER_INDEX_OUT_OF_RANGE: ${String(obj["index"])} of ${count}`);
  }
  return { index, why: String(obj["why"] ?? "").slice(0, 120) };
}

interface RecordedChoice {
  role: string;
  name: string;
}

function loadRecordings(file: string | undefined): Record<string, RecordedChoice> {
  if (!file || !existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, RecordedChoice>;
  } catch {
    return {};
  }
}

export interface OpenRouterPickerOptions {
  /** Defaults to OPENROUTER_INFRA_KEY. Infrastructure, never recoverable (§16.5). */
  apiKey?: string;
  /** Defaults to OPENROUTER_PICKER_MODEL, then PICKER_PROFILE.model. */
  model?: string;
  fallbackModels?: string[];
  /** Model calls allowed for this picker instance (one per job). Default MAX_RESOLVER_CALLS_PER_JOB. */
  budget?: number;
  recordingsFile?: string;
  /** Defaults to REPLAY_RESOLVER === "1". */
  replay?: boolean;
  baseUrl?: string;
  fetchImpl?: OpenRouterFetch;
  /** Abort a model call after this long; the attempt counts and is retried within budget. Default 60s. */
  requestTimeoutMs?: number;
  onCall?: (info: { stepKey: string; modelUsed: string | undefined; replayed: boolean }) => void;
}

export function createOpenRouterPicker(options: OpenRouterPickerOptions = {}): CandidatePicker {
  const replay = options.replay ?? process.env["REPLAY_RESOLVER"] === "1";
  const apiKey = options.apiKey ?? process.env["OPENROUTER_INFRA_KEY"];
  if (!apiKey && !replay) {
    throw new Error("OPENROUTER_INFRA_KEY is required for the tier-3 picker (or set REPLAY_RESOLVER=1).");
  }
  const model = options.model ?? process.env["OPENROUTER_PICKER_MODEL"] ?? PICKER_PROFILE.model;
  const fallbackModels = options.fallbackModels ?? [...PICKER_PROFILE.models];
  const budget = options.budget ?? loadLimits().maxResolverCallsPerJob;
  const baseUrl = options.baseUrl ?? "https://openrouter.ai/api/v1";
  const doFetch: OpenRouterFetch = options.fetchImpl ?? (globalThis.fetch as unknown as OpenRouterFetch);
  const recordings = loadRecordings(options.recordingsFile);
  let calls = 0;

  const save = () => {
    if (!options.recordingsFile) return;
    mkdirSync(dirname(options.recordingsFile), { recursive: true });
    writeFileSync(options.recordingsFile, JSON.stringify(recordings, null, 2));
  };

  return {
    async pick(req) {
      if (replay) {
        const rec = recordings[req.stepKey];
        if (!rec) throw new Error(`NO_RECORDED_CHOICE: ${req.stepKey}`);
        const match = req.candidates.find((c) => c.role === rec.role && c.name === rec.name);
        if (!match) throw new Error(`RECORDED_CHOICE_NOT_ON_PAGE: ${rec.role} "${rec.name}"`);
        options.onCall?.({ stepKey: req.stepKey, modelUsed: undefined, replayed: true });
        return { index: match.index, why: "replayed recording", modelUsed: undefined, replayed: true };
      }

      const prompt =
        `You choose ONE control on a web page for a purchasing agent.\n` +
        `Goal: ${req.goal}\n` +
        `Never choose a control that pays, confirms, or submits a payment.\n` +
        `Candidates:\n${formatCandidates(req.candidates)}\n\n` +
        `Return ONLY: {"index": <number>, "why": "<12 words max>"}`;

      let lastError: unknown;
      // A bad or out-of-range reply is rejected in code and retried within budget.
      for (let attempt = 0; attempt < 2; attempt++) {
        if (calls >= budget) throw new ResolutionExhaustedError(`Picker budget of ${budget} calls exhausted.`);
        calls += 1;

        const payload: Record<string, unknown> = {
          model,
          max_tokens: 4096,
          reasoning: { exclude: true },
          messages: [{ role: "user", content: prompt }],
        };
        if (fallbackModels.length > 0) payload["models"] = fallbackModels;

        let resp: Awaited<ReturnType<OpenRouterFetch>>;
        try {
          resp = await doFetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://aisle.dev",
            "X-OpenRouter-Title": "Aisle",
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(options.requestTimeoutMs ?? OPENROUTER_REQUEST_TIMEOUT_MS),
          });
        } catch (err) {
          lastError = new Error(`RESOLVER_REQUEST_FAILED: ${String(err)}`);
          continue;
        }
        if (resp.status === 402) throw new InfraBlockedError();
        if (!resp.ok) {
          lastError = new Error(`RESOLVER_HTTP_${resp.status}`);
          continue;
        }
        let content: string | undefined;
        let modelUsed: string | undefined;
        try {
          const body = JSON.parse(await resp.text()) as { model?: unknown; choices?: Array<{ message?: { content?: unknown } }> };
          const c = body.choices?.[0]?.message?.content;
          content = typeof c === "string" ? c : undefined;
          modelUsed = typeof body.model === "string" ? body.model : undefined;
        } catch {
          content = undefined;
        }
        try {
          const { index, why } = parsePickerReply(content ?? "", req.candidates.length);
          const chosen = req.candidates[index]!;
          recordings[req.stepKey] = { role: chosen.role, name: chosen.name };
          save();
          options.onCall?.({ stepKey: req.stepKey, modelUsed, replayed: false });
          return { index, why, modelUsed, replayed: false };
        } catch (err) {
          lastError = err;
        }
      }
      throw lastError instanceof Error ? lastError : new Error("RESOLVER_FAILED");
    },
  };
}
