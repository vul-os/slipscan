/**
 * Static cost/metadata config for extraction models.
 * Keyed by model_id (the short Gemini model name, NOT the UUID).
 * Prices as of 2025-Q3 Gemini pricing (USD per 1k tokens).
 * source: https://ai.google.dev/pricing
 */

export interface ModelMeta {
  cost_per_1k_input: number;  // USD per 1 000 input tokens
  cost_per_1k_output: number; // USD per 1 000 output tokens
  speed: "fastest" | "fast" | "standard" | "slow";
  quality: "basic" | "good" | "great" | "best";
  description: string;
}

/**
 * Gemini 2.5 Flash pricing: $0.075 / M input, $0.30 / M output
 * = $0.000075 / k input, $0.0003 / k output
 *
 * Gemini 2.5 Pro pricing: $1.25 / M input, $10.00 / M output
 * = $0.00125 / k input, $0.010 / k output
 *
 * Gemini 2.5 Flash-Lite (experimental): ~$0.015 / M input, $0.06 / M output
 * = $0.000015 / k input, $0.00006 / k output
 */
export const MODEL_META: Record<string, ModelMeta> = {
  "gemini-2.5-flash": {
    cost_per_1k_input:  0.000075,
    cost_per_1k_output: 0.0003,
    speed:   "fast",
    quality: "good",
    description: "Best balance of speed and quality. Recommended for most workloads.",
  },
  "gemini-2.5-pro": {
    cost_per_1k_input:  0.00125,
    cost_per_1k_output: 0.010,
    speed:   "slow",
    quality: "best",
    description: "Highest accuracy. Use when receipt quality is poor or data is critical.",
  },
  "gemini-2.5-flash-lite": {
    cost_per_1k_input:  0.000015,
    cost_per_1k_output: 0.00006,
    speed:   "fastest",
    quality: "basic",
    description: "Lowest cost. Suitable for high-volume, lower-stakes processing.",
  },
};

/**
 * Rough estimated cost per extraction (USD).
 * Assumes ~3 000 input tokens + ~1 000 output tokens per receipt.
 */
export function costPerExtraction(modelId: string): number {
  const m = MODEL_META[modelId];
  if (!m) return 0;
  return (3 * m.cost_per_1k_input + m.cost_per_1k_output);
}
