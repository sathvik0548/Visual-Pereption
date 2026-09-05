const { GoogleGenerativeAI } = require("@google/generative-ai");
const VLMProvider = require("./VLMProvider");

/**
 * GeminiProvider — implements the VLMProvider interface using Google Gemini.
 *
 * Uses gemini-1.5-flash which is free (15 RPM, 1M tokens/day via Google AI Studio).
 * The manifest is passed in the system prompt so the model understands that
 * black-boxed regions are intentionally redacted for privacy — NOT visual
 * artefacts — and should not be guessed at.
 */
class GeminiProvider extends VLMProvider {
  constructor() {
    super();
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    this.model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
  }

  async analyze(payload) {
    const { task_instruction, redacted_image, manifest, dom_summary } = payload;

    const prompt = `You are an autonomous browser agent. Your task is to analyze the provided screenshot and structural DOM information to accomplish the user's task.

IMPORTANT: The screenshot has been redacted for privacy. Regions listed in the manifest below are intentionally redacted and masked (e.g. as black boxes) to protect sensitive data. Do not attempt to guess their content or assume the UI is broken. Use the provided dom_summary for structural context on non-visual details.

MANIFEST OF REDACTED REGIONS:
${JSON.stringify(manifest, null, 2)}

DOM SUMMARY:
${JSON.stringify(dom_summary, null, 2)}

Task: ${task_instruction}

You must respond ONLY with strict JSON matching the following schema. Do NOT include markdown blocks (\`\`\`json) or conversational text.
{
  "action": "click" | "type" | "scroll" | "done",
  "target_id": "string",
  "value": "string" | null,
  "reasoning": "string"
}

What is the next action?`;

    const imagePart = {
      inlineData: {
        data: redacted_image,
        mimeType: "image/png",
      },
    };

    const result = await this.model.generateContent([prompt, imagePart]);
    const outputText = result.response.text();

    try {
      const jsonStr = outputText.match(/\{[\s\S]*\}/)?.[0] || outputText;
      return JSON.parse(jsonStr);
    } catch (err) {
      throw new Error(`Failed to parse VLM response as JSON: ${outputText}`);
    }
  }
}

module.exports = GeminiProvider;
