/**
 * Gemini client — port of Go internal/ocr/gemini.go. Talks to the REST
 * generateContent endpoint directly. Used by extract, classify (LLM fallback),
 * and insights. Forces JSON output via responseSchema; 2-attempt retry on
 * 429/5xx; throws RateLimitedError on quota exhaustion so handlers return 429.
 */
const DEFAULT_MODEL = "gemini-2.5-flash";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

export class RateLimitedError extends Error {
  constructor(msg = "ocr: rate limited") {
    super(msg);
    this.name = "RateLimitedError";
  }
}

export const CATEGORIES = [
  "meals", "travel", "lodging", "fuel", "groceries", "office",
  "software", "utilities", "entertainment", "health", "shopping",
  "services", "other",
] as const;

export interface LineItem {
  description?: string | null;
  qty?: number | null;
  unit_price?: number | null;
  total?: number | null;
}
export interface Receipt {
  merchant?: string | null;
  date?: string | null;
  total?: number | null;
  currency?: string | null;
  tax?: number | null;
  payment_method?: string | null;
  category?: string | null;
  line_items?: LineItem[];
  notes?: string | null;
  confidence?: number | null;
}

const EXTRACT_PROMPT = `You are a receipt parser. Extract the data from the attached image or PDF.

Rules:
- Use null for any field you can't read confidently. Don't guess.
- Numbers are decimals only. No currency symbols, no thousand-separators.
- date is ISO 8601 (YYYY-MM-DD).
- currency is a 3-letter ISO code (USD, ZAR, EUR, GBP, etc.).
- payment_method is one of: cash, card, transfer, other.
- Pick the category that best fits the merchant + line items; use "other" if nothing fits.
- If you can't classify a line item cleanly, omit it; if no line items at all, return [].
- confidence is a self-rating from 0.0 (guessed) to 1.0 (read clearly). Be honest so admins know which fields to verify.`;

const RECEIPT_SCHEMA = {
  type: "object",
  properties: {
    merchant: { type: "string", nullable: true },
    date: { type: "string", nullable: true },
    total: { type: "number", nullable: true },
    currency: { type: "string", nullable: true },
    tax: { type: "number", nullable: true },
    payment_method: { type: "string", nullable: true, enum: ["cash", "card", "transfer", "other"] },
    category: { type: "string", nullable: true, enum: [...CATEGORIES] },
    line_items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: "string", nullable: true },
          qty: { type: "number", nullable: true },
          unit_price: { type: "number", nullable: true },
          total: { type: "number", nullable: true },
        },
      },
    },
    notes: { type: "string", nullable: true },
    confidence: { type: "number", nullable: true },
  },
} as const;

export class Gemini {
  private apiKey: string;
  private model: string;
  constructor(apiKey: string, model = DEFAULT_MODEL) {
    this.apiKey = apiKey;
    this.model = model;
  }
  getModel(): string {
    return this.model;
  }

  async extract(imageBytes: Uint8Array, mimeType: string): Promise<{ receipt: Receipt; raw: string }> {
    if (imageBytes.length === 0) throw new Error("ocr: empty image");
    const text = await this.callJSON({
      contents: [{
        parts: [
          { text: EXTRACT_PROMPT },
          { inline_data: { mime_type: mimeType, data: base64Std(imageBytes) } },
        ],
      }],
      generationConfig: { responseMimeType: "application/json", responseSchema: RECEIPT_SCHEMA, temperature: 0.1 },
    });
    return { receipt: JSON.parse(text) as Receipt, raw: text };
  }

  async extractWithSchema(imageBytes: Uint8Array, mimeType: string, prompt: string, schema: unknown): Promise<string> {
    if (imageBytes.length === 0) throw new Error("ocr: empty image");
    return this.callJSON({
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: mimeType, data: base64Std(imageBytes) } },
        ],
      }],
      generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0.1 },
    });
  }

  async generateJSON(prompt: string, schema: unknown, temperature = 0.1): Promise<string> {
    return this.callJSON({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature },
    });
  }

  private async callJSON(body: unknown): Promise<string> {
    const url = `${API_BASE}/${this.model}:generateContent?key=${this.apiKey}`;
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await sleep(400 + Math.floor(Math.random() * 400));
      let resp: Response;
      try {
        resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
        });
      } catch (e) {
        lastErr = new Error(`ocr: call gemini: ${String(e)}`);
        continue;
      }
      const text = await resp.text();
      if (resp.status === 429) {
        lastErr = new RateLimitedError(`ocr: rate limited: ${truncate(text, 200)}`);
        continue;
      }
      if (resp.status >= 500) {
        lastErr = new Error(`ocr: gemini status ${resp.status}: ${truncate(text, 200)}`);
        continue;
      }
      if (resp.status !== 200) {
        throw new Error(`ocr: gemini status ${resp.status}: ${text}`);
      }
      return extractText(text);
    }
    throw lastErr ?? new Error("ocr: gemini failed");
  }
}

function extractText(body: string): string {
  const env = JSON.parse(body) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
    promptFeedback?: { blockReason?: string };
  };
  if (env.promptFeedback?.blockReason) throw new Error(`ocr: gemini blocked: ${env.promptFeedback.blockReason}`);
  const t = env.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!t) throw new Error("ocr: gemini returned no candidates");
  return stripFences(t);
}

function stripFences(s: string): string {
  s = s.trim();
  if (s.startsWith("```json")) s = s.slice(7);
  else if (s.startsWith("```")) s = s.slice(3);
  if (s.endsWith("```")) s = s.slice(0, -3);
  return s.trim();
}

function base64Std(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
const truncate = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n) + "…");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
