// Fields as the quote-gated extractor hands them to a validator, for drivers
// whose cases need a value paraphrased away from the answer's wording that its
// quote keeps. Apart from lib.mjs, which stays dependency-free.

import { enforceQuotes, normalise } from '../extract.mjs';

const quotesIn = (node) =>
  Array.isArray(node)
    ? node.flatMap(quotesIn)
    : node && typeof node === 'object'
      ? 'quote' in node
        ? [node.quote ?? '']
        : Object.values(node).flatMap(quotesIn)
      : [];

// `raw` is the extractor's output, every leaf a { value, quote } pair, gated
// against an answer made of its quotes, so every quote survives and
// quoteOf() returns it.
export const quotedFields = (raw) => enforceQuotes(raw, normalise(quotesIn(raw).join('\n')));
