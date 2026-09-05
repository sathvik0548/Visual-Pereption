const Anthropic = require("@anthropic-ai/sdk");
const VLMProvider = require("./VLMProvider");

class AnthropicProvider extends VLMProvider {
  constructor() {
    super();
    this.client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
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

    const response = await this.client.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: redacted_image,
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

    const outputText = response.content[0].text;
    
    try {
      const jsonStr = outputText.match(/\{[\s\S]*\}/)?.[0] || outputText;
      return JSON.parse(jsonStr);
    } catch (err) {
      throw new Error(`Failed to parse VLM response as JSON: ${outputText}`);
    }
  }
}

module.exports = AnthropicProvider;
