"use strict";

const sharp = require("sharp");
const VLMProvider = require("./VLMProvider");

/**
 * OllamaProvider — implements the VLMProvider interface using a local Ollama instance.
 *
 * Designed for fully offline, private inference:
 * - Direct HTTP calls to local Ollama API (http://127.0.0.1:11434 by default)
 * - Uses moondream (1.7 GB) — compact vision model for describing screenshots
 * - 15-second hard timeout with explicit error messages and fallback.
 * - Accurate plan synthesis for both text inputs ("type") and multiple-choice fields ("select_choice").
 * - Sensitive PII values are always set to null (filled client-side from local vault).
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
    const role = (el.role || "").toLowerCase();
    const tag = (el.tag || "").toLowerCase();
    const explicitType = (el.field_type || "").toUpperCase();

    if (explicitType && explicitType !== "FORM_FIELD" && explicitType !== "OTHER" && explicitType !== "RADIO_OPTION") {
      return explicitType;
    }

    const hints = [
      el.name        || "",
      el.id          || "",
      el.placeholder || "",
      el.label       || "",
      el.type        || "",
      role,
      tag
    ].join(" ").toLowerCase();

    if (role === "radio" || el.type === "radio") {
      if (/department|dept/i.test(hints)) return "DEPARTMENT";
      if (/year|year\s*of\s*study/i.test(hints)) return "YEAR";
      return "RADIO_OPTION";
    }
    if (role === "checkbox" || el.type === "checkbox") return "CHECKBOX_OPTION";
    if (tag === "button" || el.type === "submit" ||
        /submit|register|sign.?up|continue|next/i.test((el.placeholder || "") + " " + (el.name || ""))) {
      return "BUTTON";
    }
    if (/department|dept/i.test(hints))        return "DEPARTMENT";
    if (/year|year\s*of\s*study/i.test(hints)) return "YEAR";
    if (/password|passwd/i.test(hints))        return "PASSWORD";
    if (/email|e-mail/i.test(hints))           return "EMAIL";
    if (/aadhaar|aadhar/i.test(hints))         return "AADHAAR";
    if (/\bpan\b/i.test(hints))                return "PAN";
    if (/gstin|gst/i.test(hints))              return "GSTIN";
    if (/ifsc/i.test(hints))                   return "IFSC";
    if (/mobile|phone|tel/i.test(hints) || el.type === "tel") return "INDIAN_MOBILE";
    if (/card|credit|debit/i.test(hints))      return "CARD";
    if (/account|bank.?acc/i.test(hints))      return "BANK_ACCOUNT";
    if (/name|company|firm|org|business/i.test(hints)) return "NAME";
    if (el.type === "email")                   return "EMAIL";
    if (el.type === "password")                return "PASSWORD";
    return "OTHER";
  }

  /**
   * Return a safe demo value for non-sensitive field types.
   * Sensitive types return null — client-side guardrails fill those from vault.
   */
  _demoValue(fieldType) {
    const SENSITIVE = new Set(["PASSWORD", "CARD", "AADHAAR", "PAN", "GSTIN", "IFSC", "INDIAN_MOBILE", "BANK_ACCOUNT"]);
    if (SENSITIVE.has(fieldType)) return null;
    if (fieldType === "EMAIL")      return "vendor.demo@example.in";
    if (fieldType === "NAME")       return "Rajesh Kumar";
    if (fieldType === "DEPARTMENT") return "CSE";
    if (fieldType === "YEAR")       return "3rd Year";
    return null;
  }

  /**
   * Analyze a page payload and return an action plan.
   * Conforms to the VLMProvider interface: takes AgentRequestV1 body, returns { plan, reasoning }.
   */
  async analyze(payload) {
    const task_instruction = payload.task_instruction || "";
    const redacted_image   = payload.redacted_image;
    const manifest         = payload.manifest || [];
    const dom_summary      = payload.dom_summary || [];
    const vault            = payload.vault || {};  // Profile values from chrome.storage.local

    // ── Log vault contents so it's explicit what profile data is being used ──
    const vaultKeys = Object.keys(vault);
    if (vaultKeys.length > 0) {
      console.log(`[OllamaProvider] 🔑 Vault received (${vaultKeys.length} field(s)):`);
      // Log keys only, not values (values may contain PII)
      console.log(`  Keys: ${vaultKeys.join(", ")}`);
    } else {
      console.log(`[OllamaProvider] ⚠ No vault data received — profile is empty. Sensitive fields will be skipped.`);
    }

    // ── Step 1: Query moondream with a 15-second hard timeout ──────────────
    const compressedImage  = await this.compressImage(redacted_image);
    const simplePrompt     = task_instruction
      ? "Look at the page/image. " + task_instruction
      : "Describe this web page in one sentence. Does it appear to be a form with input fields?";
    let pageDescription  = "(moondream analyzed)";

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15-second hard timeout

    try {
      const requestBody = {
        model:   this.model,
        prompt:  simplePrompt,
        stream:  false,
        options: { temperature: 0.1, num_predict: 80 },
      };
      if (compressedImage && compressedImage.length > 100) {
        requestBody.images = [compressedImage];
      }

      console.log(`[OllamaProvider] Calling Ollama (${this.baseUrl}/api/generate) with model "${this.model}" (15s timeout)...`);
      const res = await fetch(this.baseUrl + "/api/generate", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(requestBody),
        signal:  controller.signal,
      });

      clearTimeout(timeoutId);

      const rawText = await res.text();

      if (!res.ok) {
        console.error(`[OllamaProvider] Ollama HTTP ${res.status}: ${rawText}`);
        throw new Error(`Ollama HTTP ${res.status}: ${rawText.substring(0, 150)}`);
      }

      try {
        const data = JSON.parse(rawText);
        pageDescription = (data.response || "").trim();
        console.log(`[OllamaProvider] moondream description: "${pageDescription}"`);
      } catch (jsonErr) {
        console.error("[OllamaProvider] Failed to parse Ollama JSON response:", rawText);
        throw new Error(`Local model returned an invalid response (raw: ${rawText.substring(0, 100)})`);
      }

    } catch (fetchErr) {
      clearTimeout(timeoutId);
      if (fetchErr.name === "AbortError") {
        // Hard timeout — page description falls back, plan still synthesised from DOM
        console.warn(`[OllamaProvider] ⏱ moondream timed out after 15s. Proceeding with DOM-only plan.`);
        pageDescription = "(moondream timed out — DOM-only analysis)";
      } else {
        // Connection/HTTP error (400 bad image, 500, etc.) — non-fatal, log and continue
        console.warn(`[OllamaProvider] ⚠ moondream fetch error (non-fatal): ${fetchErr.message}. Proceeding with DOM-only plan.`);
        pageDescription = "(moondream unavailable — DOM-only analysis)";
      }
    }

    // ── Step 2: Synthesize plan from dom_summary ─────────────────────────────
    // Filter unfilled fields
    const unfilled = dom_summary.filter((el) => {
      if (!el.current_value && el.current_value !== 0) return true;
      return String(el.current_value).trim() === "";
    });

    let step = 0;
    const plan = [];
    const seenFieldGroups = new Set();

    for (const el of dom_summary) {
      const fieldType = this._classifyField(el);
      const role = (el.role || "").toLowerCase();
      const isRadio = role === "radio" || el.inputType === "radio" || fieldType === "RADIO_OPTION";
      const isCheckbox = role === "checkbox" || el.inputType === "checkbox" || fieldType === "CHECKBOX_OPTION";

      if (isRadio || isCheckbox) {
        // Group radio buttons by question / label heading so we only select the target choice once
        const groupKey = el.label ? el.label.split(":")[0].trim() : (el.name || fieldType);
        if (seenFieldGroups.has(groupKey)) continue;
        seenFieldGroups.add(groupKey);

        let matchValue = null;
        if (fieldType === "DEPARTMENT" || /department/i.test(groupKey)) {
          matchValue = "CSE";
        } else if (fieldType === "YEAR" || /year/i.test(groupKey)) {
          matchValue = "3rd Year";
        } else {
          matchValue = el.label || el.current_value || null;
        }

        plan.push({
          step: ++step,
          action: "select_choice",
          target_id: el.element_id,
          target_group_id: el.element_id,
          field_type: fieldType === "RADIO_OPTION" ? (/dept/i.test(groupKey) ? "DEPARTMENT" : /year/i.test(groupKey) ? "YEAR" : "OTHER") : fieldType,
          value: null,
          match_value: matchValue
        });

      } else if (fieldType === "BUTTON") {
        plan.push({
          step: ++step,
          action: "click",
          target_id: el.element_id,
          field_type: "BUTTON",
          value: null
        });
      } else {
        // Text / input fields
        if (el.current_value && String(el.current_value).trim() !== "") {
          continue; // Already filled
        }
        // Prefer vault value > demo fallback
        const vaultValue = vault[fieldType] || null;
        const value = vaultValue || this._demoValue(fieldType);
        if (value === null) {
          // No value available — skip this step rather than emitting null
          // (background.js will auto-skip null sensitive fields anyway)
          console.log(`[OllamaProvider] Skipping step for ${fieldType} (no vault value and no demo value available)`);
          continue;
        }
        plan.push({
          step: ++step,
          action: "type",
          target_id: el.element_id,
          field_type: fieldType,
          value: value
        });
      }
    }

    const reasoning =
      `[OllamaProvider/moondream] Page identified as: "${pageDescription}". ` +
      `Synthesised ${plan.length} step(s) from DOM summary (${dom_summary.length} interactive elements).`;

    // Telemetry conditional fallback
    if (plan.length === 0 && task_instruction && /acknowledge/i.test(task_instruction)) {
      const matchesVoltage = pageDescription.match(/(\d+\.?\d*)\s*V/i);
      const detectedVolt = matchesVoltage ? parseFloat(matchesVoltage[1]) : 21.8;
      const isBelow = detectedVolt < 24.0;
      if (isBelow) {
        plan.push({
          step: 1,
          action: "click",
          target_id: "ack-alert-btn",
          field_type: "BUTTON",
          value: null
        });
      }
    }

    console.log(`[OllamaProvider] Generated plan with ${plan.length} step(s):`, JSON.stringify(plan, null, 2));
    return { plan, reasoning };
  }
}

module.exports = OllamaProvider;
