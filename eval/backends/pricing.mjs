// Token pricing against genai-prices' bundled table (no network call), for the
// spend a backend cannot read off its SDK: every codex run, and an anthropic
// attempt the harness aborted before its SDK reported a cost. Best-effort by
// design: an unknown model must never fail a run.

import { calcPrice } from '@pydantic/genai-prices';

// Warn once per model id whose price entry was resolved by approximate match,
// so a silently mispriced model is visible instead of quietly wrong.
const pricingWarned = new Set();

// `usage` is in the uncached-remainder convention of the backend interface
// (see backends/anthropic.mjs). calcPrice wants OpenAI's convention, where
// input_tokens already includes the cached portion; it subtracts the cached
// tokens itself and rejects a negative remainder.
export function priceTokens(modelId, usage, label) {
  if (!usage || !modelId) return null;
  const cacheRead = usage.cache_read ?? 0;
  const cacheWrite = usage.cache_creation ?? 0;
  try {
    const priced = calcPrice(
      {
        input_tokens: (usage.input_tokens ?? 0) + cacheRead + cacheWrite,
        cache_read_tokens: cacheRead,
        cache_write_tokens: cacheWrite,
        output_tokens: usage.output_tokens ?? 0,
      },
      modelId
    );
    // Unknown models come back as null rather than throwing.
    if (!priced) return null;
    const matched = priced.model?.id;
    if (matched && matched !== modelId && !pricingWarned.has(modelId)) {
      pricingWarned.add(modelId);
      console.log(`[${label}] pricing "${modelId}" using the "${matched}" price entry`);
    }
    return priced.total_price ?? null;
  } catch {
    return null;
  }
}
