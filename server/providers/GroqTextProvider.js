const Groq = require("groq-sdk");
const VLMProvider = require("./VLMProvider");

/**
 * GroqTextProvider — text-only VLM using Groq's free API.
 *
 * Since Groq deprecated all vision models, this provider uses a text model
 * (llama-4-scout) and relies on the DOM summary + manifest for page context
 * instead of the image. PII detection and redaction still happen locally in
 * the extension — only the action-decision step is text-based here.
 *
 * This is sufficient for form-filling demos because the dom_summary already
 * contains element IDs, tags, roles, and bounding boxes.
 */
class GroqTextProvider extends VLMProvider {
  constructor() {
    super();
    this.client = new Groq({
      apiKey: process.env.GROQ_API_KEY,
    });
  }

  async analyze(payload) {
    const { task_instruction, manifest, dom_summary } = payload;

    const systemPrompt = `You are an autonomous browser agent. Your task is to analyze the provided page structure and accomplish the user's task step by step.

NOTE: This page has been visually analyzed and PII regions have been redacted client-side. The manifest below lists those redacted regions. Use the dom_summary for structural context — it contains all interactive element IDs, tags, and roles.

MANIFEST OF REDACTED REGIONS (intentional, privacy-preserving):
${JSON.stringify(manifest, null, 2)}

DOM SUMMARY (interactive elements on the page):
${JSON.stringify(dom_summary, null, 2)}

You must respond ONLY with strict JSON. Do NOT include markdown blocks or conversational text:
{
  "action": "click" | "type" | "select_choice" | "scroll" | "done",
  "target_id": "string",
  "target_group_id": "string" | null,
  "value": "string" | null,
  "match_value": "string" | null,
  "reasoning": "string"
}

Rules:
- CRITICAL: You MUST use the exact element_id values (e.g. "agent_0", "agent_1") from dom_summary as target_id or target_group_id. NEVER guess or invent element IDs like "name-input", "department-CSE", or "form-container".
- For radio/checkbox options or dropdowns, use action "select_choice" and specify "match_value" (e.g. "CSE", "3rd Year").
- For text fields, use action "type" with realistic placeholder values (NOT real PII).
- Return "done" when the task is complete`;

    // Fallback model list — tried in order until one succeeds
    const MODELS = [
      "qwen/qwen3.8-27b",
      "qwen/qwen3.6-27b",
      "groq/compound-mini",
      "openai/gpt-oss-20b",
    ];

    let lastError;
    for (const model of MODELS) {
      try {
        console.log(`[GroqTextProvider] Trying model: ${model}`);
        const response = await this.client.chat.completions.create({
          model,
          max_tokens: 512,
          messages: [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: `Task: ${task_instruction}\n\nWhat is the next single action to take? Respond with JSON only.`,
            },
          ],
        });

        const outputText = response.choices[0].message.content;
        console.log(`[GroqTextProvider] ✅ Got response from ${model}`);

        // Strip optional <think>...</think> tags from reasoning models
        const stripped = outputText.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
        const jsonStr = stripped.match(/\{[\s\S]*\}/)?.[0] || stripped;
        return JSON.parse(jsonStr);
      } catch (err) {
        const msg = err?.message || String(err);
        console.warn(`[GroqTextProvider] ⚠️  Model ${model} failed: ${msg.substring(0, 120)}`);
        lastError = err;
        // Only skip to next model on overload / rate-limit / not-found errors
        if (
          msg.includes("overloaded") ||
          msg.includes("rate_limit") ||
          msg.includes("529") ||
          msg.includes("model_not_found") ||
          msg.includes("does not exist")
        ) {
          continue;
        }
        throw err; // Unrecoverable error — bubble up immediately
      }
    }

    throw new Error(
      `All Groq models are currently unavailable. Last error: ${lastError?.message}`
    );
  }
}

module.exports = GroqTextProvider;
