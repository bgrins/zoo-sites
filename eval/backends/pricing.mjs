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
//
// `requests` is how many model requests `usage` sums. A long-context tier
// (gpt-5.6 doubles input past 272k) applies per request, but calcPrice picks
// the tier from the input it is handed, so a run's summed usage priced whole
// put 60k-token requests at the 272k rate. The usage is split evenly across the
// requests instead, in whole tokens so the totals stay exact.
export function priceTokens(modelId, usage, label, requests = 1) {
  if (!usage || !modelId) return null;
  const n = Number.isInteger(requests) && requests > 1 ? requests : 1;
  // n - 1 requests take the floor share, and the last one the remainder.
  const share = (count, last) => {
    const total = count ?? 0;
    const each = Math.floor(total / n);
    return last ? total - each * (n - 1) : each;
  };
  const price = (last) => {
    const cacheRead = share(usage.cache_read, last);
    const cacheWrite = share(usage.cache_creation, last);
    return calcPrice(
      {
        input_tokens: share(usage.input_tokens, last) + cacheRead + cacheWrite,
        cache_read_tokens: cacheRead,
        cache_write_tokens: cacheWrite,
        output_tokens: share(usage.output_tokens, last),
      },
      modelId
    );
  };
  try {
    const priced = price(true);
    // Unknown models come back as null rather than throwing.
    if (!priced) return null;
    const matched = priced.model?.id;
    if (matched && matched !== modelId && !pricingWarned.has(modelId)) {
      pricingWarned.add(modelId);
      console.log(`[${label}] pricing "${modelId}" using the "${matched}" price entry`);
    }
    if (priced.total_price == null) return null;
    return n > 1 ? priced.total_price + (n - 1) * price(false).total_price : priced.total_price;
  } catch {
    return null;
  }
}
