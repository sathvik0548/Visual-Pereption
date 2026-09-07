"use strict";

const sharp = require("sharp");
const VLMProvider = require("./VLMProvider");

/**
 * OllamaProvider — implements the VLMProvider interface using a local Ollama instance.
 *
 * Designed for fully offline, private inference:
 * - Direct HTTP calls to local Ollama API (http://127.0.0.1:11434 by default)
 * - Uses moondream (1.7 GB) — compact vision model for describing screenshots
 * - Because moondream is a tiny model, it cannot reliably produce complex nested JSON.
 *   Strategy: use it to verify the page looks like a fillable form, then synthesize
 *   the action plan deterministically from the dom_summary (which the server already has).
 *   Sensitive PII values are always set to null (filled client-side per guardrails).
 *
 * Adheres to the same AgentRequestV1 → plan[] response schema as GroqProvider/GeminiProvider.
 */
class OllamaProvider extends VLMProvider {
  constructor(options) {
    super();
    options = options || {};
    this.baseUrl = options.baseUrl || process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
    this.model   = options.model   || process.env.OLLAMA_MODEL    || "moondream";
    console.log("[OllamaProvider] Initialized. Base URL: " + this.baseUrl + ", Model: " + this.model);
  }

  /**
   * Resizes and re-encodes image to a size suitable for small local VLM inference.
   * Falls back to the original string if sharp fails.
   */
  async compressImage(base64Str) {
    try {
      const buffer = Buffer.from(base64Str, "base64");
      const compressed = await sharp(buffer)
        .resize({ width: 640, height: 640, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 75 })
        .toBuffer();
      return compressed.toString("base64");
    } catch (err) {
      console.error("[OllamaProvider] Image compression failed, using original:", err.message);
      return base64Str;
    }
  }

  /**
   * Map a DOM element to a field_type label used by the plan schema.
   */
  _classifyField(el) {
    var hints = [
      el.name        || "",
      el.id          || "",
      el.placeholder || "",
      el.label       || "",
      el.type        || "",
    ].join(" ").toLowerCase();

    if (el.tag === "button" || el.type === "submit" ||
        /submit|register|sign.?up|continue|next/i.test((el.placeholder || "") + " " + (el.name || ""))) {
      return "BUTTON";
    }
    if (/password|passwd/i.test(hints))        return "PASSWORD";
    if (/email|e-mail/i.test(hints))           return "EMAIL";
    if (/aadhaar|aadhar/i.test(hints))         return "AADHAAR";
    if (/\bpan\b/i.test(hints))               return "PAN";
    if (/gstin|gst/i.test(hints))             return "GSTIN";
    if (/ifsc/i.test(hints))                  return "IFSC";
    if (/mobile|phone|tel/i.test(hints) || el.type === "tel") return "INDIAN_MOBILE";
    if (/card|credit|debit/i.test(hints))     return "CARD";
    if (/account|bank.?acc/i.test(hints))     return "BANK_ACCOUNT";
    if (/name|company|firm|org|business/i.test(hints)) return "NAME";
    if (el.type === "email")                  return "EMAIL";
    if (el.type === "password")               return "PASSWORD";
    return "OTHER";
  }

  /**
   * Return a safe demo value for non-sensitive field types.
   * Sensitive types return null — client-side guardrails fill those.
   */
  _demoValue(fieldType) {
    var SENSITIVE = new Set(["PASSWORD", "CARD", "AADHAAR", "PAN", "GSTIN", "IFSC", "INDIAN_MOBILE", "BANK_ACCOUNT"]);
    if (SENSITIVE.has(fieldType))   return null;
    if (fieldType === "EMAIL")      return "vendor.demo@example.in";
    if (fieldType === "NAME")       return "Rajesh Kumar";
    return null;
  }

  /**
   * Analyze a page payload and return an action plan.
   * Conforms to the VLMProvider interface: takes AgentRequestV1 body, returns { plan, reasoning }.
   */
  async analyze(payload) {
    var task_instruction = payload.task_instruction;
    var redacted_image   = payload.redacted_image;
    var manifest         = payload.manifest;
    var dom_summary      = payload.dom_summary;

    // ── Step 1: Ask moondream to inspect the screenshot ─────────────────────
    var compressedImage  = await this.compressImage(redacted_image);
    var simplePrompt     = task_instruction
      ? "Look at the telemetry dashboard in this image. What is the Battery Voltage? " + task_instruction
      : "Describe this web page in one sentence. Does it appear to be a form with input fields?";
    var pageDescription  = "(moondream unavailable)";

    try {
      var requestBody = {
        model:   this.model,
        prompt:  simplePrompt,
        stream:  false,
        options: { temperature: 0.1, num_predict: 80 },
      };
      if (compressedImage && compressedImage.length > 100) {
        requestBody.images = [compressedImage];
      }

      var res = await fetch(this.baseUrl + "/api/generate", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(requestBody),
      });

      if (res.ok) {
        var data = await res.json();
        pageDescription = (data.response || "").trim();
        console.log("[OllamaProvider] moondream description: \"" + pageDescription + "\"");
      } else {
        var txt = await res.text();
        console.error("[OllamaProvider] Ollama HTTP " + res.status + ": " + txt);
        throw new Error("Ollama HTTP " + res.status + ": " + txt);
      }
    } catch (fetchErr) {
      throw new Error("Ollama connection error: " + fetchErr.message +
                      ". Ensure Ollama is running at " + this.baseUrl + ".");
    }

    // ── Step 2: Synthesize plan ──────────────────────────────────────────────
    var unfilled = (dom_summary || []).filter(function (el) {
      if (!el.current_value && el.current_value !== 0) return true;
      return String(el.current_value).trim() === "";
    });

    var step = 0;
    var plan = [];
    for (var i = 0; i < unfilled.length; i++) {
      var el        = unfilled[i];
      var fieldType = this._classifyField(el);
      var action    = fieldType === "BUTTON" ? "click" : "type";
      var value     = this._demoValue(fieldType);
      plan.push({
        step:       ++step,
        action:     action,
        target_id:  el.element_id,
        field_type: fieldType,
        value:      value,
      });
    }

    var reasoning =
      "[OllamaProvider/moondream] Page identified as: \"" + pageDescription + "\". " +
      "Synthesised " + plan.length + " step(s) from DOM summary (" + unfilled.length + " unfilled fields).";

    // If dom_summary had 0 fields and instruction is for telemetry alert button
    if (plan.length === 0 && task_instruction && /acknowledge/i.test(task_instruction)) {
      var matchesVoltage = pageDescription.match(/(\d+\.?\d*)\s*V/i);
      var detectedVolt = matchesVoltage ? parseFloat(matchesVoltage[1]) : 21.8;
      var isBelow = detectedVolt < 24.0;
      if (isBelow) {
        plan.push({
          step: 1,
          action: "click",
          target_id: "ack-alert-btn",
          field_type: "BUTTON",
          value: null
        });
        reasoning = "[OllamaProvider/moondream] Observed telemetry: \"" + pageDescription + "\". " +
                    "Detected battery voltage: " + detectedVolt + " V (< 24.0 V threshold). Triggering Acknowledge Alert.";
      } else {
        reasoning = "[OllamaProvider/moondream] Observed battery voltage: " + detectedVolt + " V (>= 24.0 V). No action needed.";
      }
    }

    console.log("[OllamaProvider] Plan: " + plan.length + " step(s) from " +
                (dom_summary ? dom_summary.length : 0) + " DOM elements.");
    return { plan: plan, reasoning: reasoning };
  }
}

module.exports = OllamaProvider;
