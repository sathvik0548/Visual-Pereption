/**
 * Base VLM Provider interface
 * 
 * Implementations should extend this class to interface with specific
 * Vision Language Models (e.g., Anthropic, LLaVA, GPT-4V).
 */
class VLMProvider {
  /**
   * Run the analysis task using the given V1 Agent payload.
   * 
   * @param {Object} payload - The AgentRequestV1 payload
   * @param {string} payload.task_instruction
   * @param {string} payload.redacted_image - Base64 PNG string
   * @param {Array} payload.manifest - Array of redacted regions
   * @param {Array} payload.dom_summary - Array of DOM elements
   * @returns {Promise<{action: string, target_id: string, value: string|null, reasoning: string}>}
   */
  async analyze(payload) {
    throw new Error("VLMProvider.analyze() must be implemented by subclass");
  }
}

module.exports = VLMProvider;
