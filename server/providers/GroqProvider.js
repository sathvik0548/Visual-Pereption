const Groq = require("groq-sdk");
const VLMProvider = require("./VLMProvider");

/**
 * GroqProvider — implements the VLMProvider interface using Groq's free API.
 *
 * Uses llama-3.2-90b-vision-preview which is a vision-capable model available
 * on Groq's free tier. The manifest is passed in the system prompt so the model
 * understands that black-boxed regions are intentionally redacted for privacy —
 * NOT visual artefacts — and should not be guessed at.
 */
class GroqProvider extends VLMProvider {
  constructor() {
    super();
    this.client = new Groq({
      apiKey: process.env.GROQ_API_KEY,
    });
  }

  async analyze(payload) {
    const { task_instruction, redacted_image, manifest, dom_summary } = payload;

    const systemPrompt = `You are an autonomous browser agent. Your task is to analyze the provided screenshot and structural DOM information to accomplish the user's task.

IMPORTANT: The screenshot has been redacted for privacy. Regions listed in the manifest below are intentionally redacted and masked (e.g. as black boxes) to protect sensitive data. Do not attempt to guess their content or assume the UI is broken. Use the provided dom_summary for structural context on non-visual details.

MANIFEST OF REDACTED REGIONS:
${JSON.stringify(manifest, null, 2)}

DOM SUMMARY:
${JSON.stringify(dom_summary, null, 2)}

You must respond ONLY with strict JSON matching the following schema. Do NOT include markdown blocks (\`\`\`json) or conversational text.
{
  "action": "click" | "type" | "scroll" | "done",
  "target_id": "string", // references dom_summary element_id or manifest region_id
  "value": "string" | null, // e.g. text to type, but NEVER echo actual PII
  "reasoning": "string"
}`;

    const response = await this.client.chat.completions.create({
      model: "llama-3.2-90b-vision-preview",
      max_tokens: 1024,
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
                url: `data:image/png;base64,${redacted_image}`,
              },
            },
            {
              type: "text",
              text: `Task: ${task_instruction}\nWhat is the next action?`,
            },
          ],
        },
      ],
    });

    const outputText = response.choices[0].message.content;

    try {
      const jsonStr = outputText.match(/\{[\s\S]*\}/)?.[0] || outputText;
      return JSON.parse(jsonStr);
    } catch (err) {
      throw new Error(`Failed to parse VLM response as JSON: ${outputText}`);
    }
  }
}

module.exports = GroqProvider;
