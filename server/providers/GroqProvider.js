const Groq = require("groq-sdk");
const sharp = require("sharp");
const VLMProvider = require("./VLMProvider");

/**
 * GroqProvider — implements the VLMProvider interface using Groq's API.
 *
 * NOTE ON ARCHITECTURE:
 * Groq is serving as one implementation of the VLMProvider interface.
 * The underlying models (Llama / Qwen vision) are open-weight models that
 * could technically be self-hosted, fulfilling the privacy-preserving
 * goal of the project. Groq provides fast cloud inference.
 *
 * Response schema (v2 — full plan):
 * {
 *   "plan": [
 *     { "step": 1, "action": "type", "target_id": "elem_0", "field_type": "NAME",  "value": "John Doe" },
 *     { "step": 2, "action": "type", "target_id": "elem_1", "field_type": "EMAIL", "value": "john.doe@example.com" },
 *     { "step": 3, "action": "type", "target_id": "elem_2", "field_type": "PASSWORD", "value": null },
 *     { "step": 4, "action": "type", "target_id": "elem_3", "field_type": "CARD",  "value": null },
 *     { "step": 5, "action": "click", "target_id": "elem_4", "field_type": "BUTTON", "value": null }
 *   ],
 *   "reasoning": "..."
 * }
 */
class GroqProvider extends VLMProvider {
  constructor() {
    super();
    const key = process.env.GROQ_API_KEY;
    const hasKey = Boolean(key && key.trim().length > 0);
    console.log(`[GroqProvider] Initialized. API key present: ${hasKey} (${hasKey ? key.trim().length : 0} chars)`);
    this.client = new Groq({
      apiKey: process.env.GROQ_API_KEY,
    });
  }

  /**
   * Resizes and compresses the base64 image to ensure the payload stays
   * under Groq's 4MB limit, while maintaining enough detail for the VLM.
   */
  async compressImage(base64Str) {
    try {
      const buffer = Buffer.from(base64Str, "base64");
      
      const compressedBuffer = await sharp(buffer)
        .resize({
          width: 1280,
          height: 1280,
          fit: "inside",
          withoutEnlargement: true
        })
        .jpeg({ quality: 80 })
        .toBuffer();

      const compressedBase64 = compressedBuffer.toString("base64");
      
      // Calculate approximate payload size in MB
      const sizeMB = (compressedBase64.length * 0.75) / (1024 * 1024);
      console.log(`[GroqProvider] Image compressed: ${sizeMB.toFixed(2)} MB`);
      
      if (sizeMB > 3.8) {
        console.warn(`[GroqProvider] WARNING: Image is very close to 4MB limit!`);
      }

      return compressedBase64;
    } catch (err) {
      console.error("[GroqProvider] Image compression failed:", err);
      return base64Str; // fallback to original if sharp fails
    }
  }

  async analyze(payload) {
    const { task_instruction, redacted_image, manifest, dom_summary } = payload;

    const systemPrompt = `You are an autonomous browser agent. Analyze the screenshot, visual content, and DOM information to fulfill the user's task instruction.

IMPORTANT: The screenshot may have privacy redactions (black boxes) over sensitive PII. If there are no redactions, inspect the visual content normally.
If the task requires reading visual gauges, meters, graphs, or text drawn in a canvas or image, visually extract the exact numbers and text directly from the screenshot pixels.

MANIFEST OF REDACTED REGIONS:
${JSON.stringify(manifest, null, 2)}

DOM SUMMARY (interactive elements detected in DOM):
${JSON.stringify(dom_summary, null, 2)}

RULES:
1. Follow the task instruction precisely.
2. VISUAL PERCEPTION / CONDITIONAL TASKS:
   - If the task asks to inspect a visual readout (e.g. battery voltage, telemetry, sensor readings rendered in a canvas or graphic) and take an action based on a condition:
     * Carefully read the exact visual values from the screenshot pixels.
     * Evaluate the condition against the observed value.
     * If the condition is met, output the appropriate action (e.g. action "click" on the relevant button or element, like "ack-alert-btn").
     * If the condition is NOT met, return an empty plan: {"plan":[],"reasoning":"..."}.
   - In your "reasoning", ALWAYS explicitly state the exact visual values observed on screen (e.g., "Observed Battery Voltage = 21.8 V on telemetry canvas. Since 21.8 V < 24.0 V threshold, clicking Acknowledge Alert button.").
3. FORM FILLING & SELECTION TASKS:
   - If the task is to fill a form: build a plan covering all unfilled fields. Order steps top-to-bottom.
   - For text input fields (text, email, tel, password): use action "type".
   - For radio button groups, checkboxes, or dropdown/select fields: use action "select_choice" with "match_value" (e.g. match_value: "CSE", "3rd Year", "Engineering"). Never use "type" for radios/checkboxes.
   - Use these safe demo values when filling fields:
     * NAME / Full Name        → "Rajesh Kumar"
     * EMAIL                   → "vendor.demo@example.in"
     * DEPARTMENT              → "CSE" (or match_value: "CSE")
     * YEAR                    → "3rd Year" (or match_value: "3rd Year")
     * PASSWORD, CARD, AADHAAR, PAN, GSTIN, IFSC, INDIAN_MOBILE, BANK_ACCOUNT → null (client substitutes locally)
     * Any submit or action BUTTON → action "click", value null
   - Skip any field where current_value is non-empty — it's already done.
   - If ALL form fields are already filled, return an empty plan: {"plan":[],"reasoning":"All fields filled."}.
4. TARGET IDENTIFICATION:
   - CRITICAL: You MUST use the exact "element_id" (e.g. "agent_0", "agent_1") from the dom_summary as target_id or target_group_id.
   - NEVER invent or guess target IDs like "name-input", "department-CSE", or "form-container".
   - If the target element is a button or input visible on page with an explicit DOM id, use that exact DOM id.

Respond ONLY with strict JSON — no markdown, no prose outside the object.
Schema:
{
  "plan": [
    {
      "step": <integer starting at 1>,
      "action": "type" | "select_choice" | "click" | "scroll",
      "target_id": "<element_id or DOM id>",
      "target_group_id": "<element_id or DOM id if radio/checkbox group>",
      "field_type": "BUTTON" | "NAME" | "EMAIL" | "PASSWORD" | "CARD" | "PHONE" | "DEPARTMENT" | "YEAR" | "OTHER",
      "value": "<string to type>" | null,
      "match_value": "<string to match for select_choice, e.g. CSE or 3rd Year>" | null
    }
  ],
  "reasoning": "<explanation citing exact visual numbers observed and logic>"
}`;

    // Compress image before sending
    const compressedImage = await this.compressImage(redacted_image);

    // Reference for supported models and deprecation status:
    // https://console.groq.com/docs/deprecations
    // https://console.groq.com/docs/vision
    // Note: llama-3.2-90b-vision-preview was decommissioned on 04/14/25.
    // Note: meta-llama/llama-4-scout-17b-16e-instruct reached shutdown on 07/17/26.
    // Currently active multimodal model on Groq: qwen/qwen3.6-27b
    const MODELS = [
      "qwen/qwen3.6-27b",
      "qwen/qwen3.8-27b"
    ];

    let lastError;

    for (const model of MODELS) {
      try {
        console.log(`[GroqProvider] Requesting full plan from ${model}...`);
        
        const requestParams = {
          model: model,
          max_tokens: 500,  // Stays safely within Groq free-tier 1000 OTPM limit
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: systemPrompt,
            },
            {
              role: "user",
              content: [
                {
                  type: "image_url",
                  image_url: {
                    url: `data:image/jpeg;base64,${compressedImage}`,
                  },
                },
                {
                  type: "text",
                  text: `Task: ${task_instruction}\nProduce a complete plan for ALL unfilled fields. Respond with JSON only.`,
                },
              ],
            },
          ],
        };

        // For reasoning models (Qwen on Groq): disable <think> tokens so JSON mode works cleanly.
        // See: https://console.groq.com/docs/reasoning  (reasoning_effort: "none" = instruct mode)
        if (model.includes("qwen")) {
          requestParams.reasoning_effort = "none";
        }

        const response = await this.client.chat.completions.create(requestParams);
        const outputText = response.choices[0].message.content;
        
        // Robustly extract JSON: strip any residual <think> tags or markdown fences
        const cleaned = outputText
          .replace(/<think>[\s\S]*?<\/think>/gi, "")
          .replace(/<think>[\s\S]*/gi, "")
          .replace(/```(?:json)?/gi, "")
          .trim();
        const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
        const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : cleaned);

        // Normalise: if model returns old single-action format, wrap it
        if (parsed.action && !parsed.plan) {
          console.warn("[GroqProvider] Model returned single-action format; wrapping into plan[]");
          parsed.plan = [{
            step: 1,
            action: parsed.action,
            target_id: parsed.target_id,
            field_type: "UNKNOWN",
            value: parsed.value ?? null
          }];
          parsed.reasoning = parsed.reasoning || "";
          delete parsed.action;
          delete parsed.target_id;
          delete parsed.value;
        }

        // Guarantee plan is always an array
        if (!Array.isArray(parsed.plan)) {
          parsed.plan = [];
        }

        console.log(`[GroqProvider] Plan received: ${parsed.plan.length} step(s)`);
        return parsed;

      } catch (err) {
        const status = err?.status || err?.response?.status;
        const msg = err?.error?.message || err?.message || String(err);
        
        console.warn(`[GroqProvider] ⚠️  Model ${model} failed (${status}): ${msg.substring(0, 200)}`);
        lastError = err;

        // ── Specific failure categorisation ──────────────────────────────
        if (
          status === 413 || msg.toLowerCase().includes("payload too large") ||
          (msg.toLowerCase().includes("too large") && !msg.toLowerCase().includes("token") && status !== 429)
        ) {
          throw new Error(`Groq Payload Too Large (4MB Limit exceeded). Image compression was insufficient.`);
        }
        
        if (
          (status === 400 || status === 404) && 
          (msg.includes("does not exist") || msg.includes("model_not_found"))
        ) {
          console.warn(`[GroqProvider] Model ${model} is decommissioned — trying fallback.`);
          continue;
        }

        if (status === 429 || msg.includes("overloaded") || msg.includes("rate limit")) {
          console.warn(`[GroqProvider] Rate limit / overload on ${model} — trying fallback.`);
          continue;
        }

        if (status >= 500) {
          console.warn(`[GroqProvider] Groq internal server error on ${model} — trying fallback.`);
          continue;
        }

        throw err; // Unrecoverable (e.g. invalid API key, malformed request)
      }
    }

    throw new Error(`All Groq vision models failed. Last error: ${lastError?.message}`);
  }
}

module.exports = GroqProvider;
