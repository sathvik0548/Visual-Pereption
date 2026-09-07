/**
 * content.js — Content Script (injected into every page)
 *
 * Broadened DOM scanner and robust action executor:
 *   - classifyInputField() — multi-signal weighted classifier (autocomplete, labels, aria, name/id, placeholder, nearby text)
 *   - scanDOM()            — queries inputs, textareas, selects, [role="radio"], [role="checkbox"],
 *                            [role="textbox"], [contenteditable], assigns stable data-agent-id
 *   - simulatePointerSequence() — realistic pointerdown, mousedown, focus, mouseup, click, pointerup
 *   - executeAction()      — resolves via data-agent-id, query, or coordinate-based fallback (bbox center)
 */

console.log("[Content] Browser Agent content script loaded on:", window.location.href);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
window._agentElements = [];

// Structural validator helpers for DOM attributes/values
function isAadhaarStr(v) {
  if (!v || typeof v !== "string") return false;
  const c = v.replace(/[\s\-]/g, "");
  return /^[2-9]\d{11}$/.test(c);
}
function isPANStr(v) {
  if (!v || typeof v !== "string") return false;
  return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(v.trim().toUpperCase());
}
function isGSTINStr(v) {
  if (!v || typeof v !== "string") return false;
  const c = v.trim().toUpperCase();
  if (c.length !== 15) return false;
  const sc = parseInt(c.slice(0, 2), 10);
  return sc >= 1 && sc <= 38 && isPANStr(c.slice(2, 12));
}
function isIFSCStr(v) {
  if (!v || typeof v !== "string") return false;
  return /^[A-Z]{4}0[A-Z0-9]{6}$/.test(v.trim().toUpperCase());
}
function isIndianMobileStr(v) {
  if (!v || typeof v !== "string") return false;
  const c = v.trim().replace(/[\s\-\(\)]/g, "");
  return /^(?:\+91|91|0)?[6-9]\d{9}$/.test(c);
}

// ---------------------------------------------------------------------------
// Vault Profile Helper — reads strictly from chrome.storage.local
// ---------------------------------------------------------------------------
function getVaultValue(fieldType) {
  return new Promise((resolve) => {
    if (typeof chrome === "undefined" || !chrome.storage?.local) {
      resolve(null);
      return;
    }
    chrome.storage.local.get(["agent_vault"], (data) => {
      const vault = data?.agent_vault || {};
      if (!fieldType) {
        resolve(null);
        return;
      }
      if (vault[fieldType]) {
        resolve(vault[fieldType]);
        return;
      }
      // Common Aliases & Fallbacks
      if (fieldType === "PHONE" && vault["INDIAN_MOBILE"]) {
        resolve(vault["INDIAN_MOBILE"]);
        return;
      }
      if (fieldType === "INDIAN_MOBILE" && vault["PHONE"]) {
        resolve(vault["PHONE"]);
        return;
      }
      if (fieldType === "POSTAL_CODE" && vault["PINCODE"]) {
        resolve(vault["PINCODE"]);
        return;
      }
      if (fieldType === "PINCODE" && vault["POSTAL_CODE"]) {
        resolve(vault["POSTAL_CODE"]);
        return;
      }
      if (fieldType === "ZIP" && vault["PINCODE"]) {
        resolve(vault["PINCODE"]);
        return;
      }
      resolve(null);
    });
  });
}

// ---------------------------------------------------------------------------
// Context Label Extractor (supports Google Forms, standard labels, ARIA)
// ---------------------------------------------------------------------------
function getElementContextLabel(el, labelMap) {
  // 1. Associated label via ID
  if (el.id && labelMap.has(el.id)) {
    return labelMap.get(el.id);
  }

  // 2. Direct aria-label
  const ariaLabel = (el.getAttribute("aria-label") || "").trim();
  if (ariaLabel) return ariaLabel;

  // 3. aria-labelledby references
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const textParts = labelledBy.split(/\s+/).map(id => {
      const lblEl = document.getElementById(id);
      return lblEl ? (lblEl.innerText || lblEl.textContent || "").trim() : "";
    }).filter(Boolean);
    if (textParts.length > 0) return textParts.join(" ");
  }

  // 4. Wrapping <label>
  const wrap = el.closest("label");
  if (wrap) {
    const wrapText = (wrap.innerText || wrap.textContent || "").trim();
    if (wrapText) return wrapText;
  }

  // 5. Radio / Checkbox data-value or internal span
  const dataVal = (el.getAttribute("data-value") || "").trim();
  if (dataVal) return dataVal;

  // 6. Parent question container (Google Forms, SurveyMonkey, multi-row forms)
  const questionContainer = el.closest('[role="listitem"], [role="radiogroup"], .geS5n, .Qr7Oae, .form-group, .field, tr');
  if (questionContainer) {
    const heading = questionContainer.querySelector('[role="heading"], .M7eMe, label, legend, .title');
    const headingText = heading ? (heading.innerText || heading.textContent || "").trim() : "";
    const optionText = (el.innerText || el.textContent || "").trim();
    if (headingText && optionText && headingText !== optionText) {
      return `${headingText}: ${optionText}`;
    }
    if (headingText) return headingText;
  }

  // 7. Preceding sibling text
  const prev = el.previousElementSibling;
  if (prev && prev.tagName !== "INPUT" && prev.tagName !== "BUTTON") {
    const prevText = (prev.innerText || prev.textContent || "").trim();
    if (prevText) return prevText;
  }

  return el.placeholder || el.name || "";
}

// ---------------------------------------------------------------------------
// Multi-Signal Field Classifier
// ---------------------------------------------------------------------------
const CLASSIFIER_RULES = [
  {
    type: "PASSWORD",
    exactInputTypes: ["password"],
    autocomplete: ["current-password", "new-password", "password"],
    patterns: [/\b(?:pass|password|passwd|pwd)\b/i],
    baseWeight: 1.0,
  },
  {
    type: "AADHAAR",
    autocomplete: [],
    patterns: [/\b(?:aadhaar|aadhar|uidai)\b/i, /unique[-_]?id/i],
    valueValidator: isAadhaarStr,
    baseWeight: 1.0,
  },
  {
    type: "PAN",
    autocomplete: [],
    patterns: [/\bpan\b/i, /pan[-_]?card/i, /pan[-_]?no/i, /pan[-_]?number/i, /pancard/i],
    valueValidator: isPANStr,
    baseWeight: 0.98,
  },
  {
    type: "GSTIN",
    autocomplete: [],
    patterns: [/\bgstin\b/i, /gst[-_]?no/i, /gst[-_]?number/i, /gst[-_]?in/i],
    valueValidator: isGSTINStr,
    baseWeight: 0.98,
  },
  {
    type: "IFSC",
    autocomplete: [],
    patterns: [/\bifsc\b/i, /ifsc[-_]?code/i],
    valueValidator: isIFSCStr,
    baseWeight: 0.98,
  },
  {
    type: "CARD",
    autocomplete: ["cc-number", "cc-csc", "cc-exp", "cc-name", "cc-type", "cc-exp-month", "cc-exp-year"],
    patterns: [/\b(?:card[-_]?num|card[-_]?no|credit[-_]?card|debit[-_]?card|cvv|cvc)\b/i, /\bcc[-_]?num\b/i],
    baseWeight: 0.98,
  },
  {
    type: "EMAIL",
    exactInputTypes: ["email"],
    autocomplete: ["email"],
    patterns: [/\b(?:email|e-mail|mail)\b/i, /user[-_]?email/i],
    baseWeight: 0.95,
  },
  {
    type: "INDIAN_MOBILE",
    exactInputTypes: ["tel"],
    autocomplete: ["tel", "mobile"],
    patterns: [/\b(?:mobile|cell|whatsapp)\b/i, /mobile[-_]?no/i, /phone[-_]?no/i],
    valueValidator: isIndianMobileStr,
    baseWeight: 0.94,
  },
  {
    type: "PHONE",
    exactInputTypes: ["tel"],
    autocomplete: ["tel", "tel-national", "tel-country-code"],
    patterns: [/\b(?:phone|telephone|contact|contact[-_]?no)\b/i],
    baseWeight: 0.90,
  },
  {
    type: "DOB",
    exactInputTypes: ["date"],
    autocomplete: ["bday", "bday-day", "bday-month", "bday-year"],
    patterns: [/\b(?:dob|birth|birthdate|birthday)\b/i, /date[-_]?of[-_]?birth/i],
    baseWeight: 0.92,
  },
  {
    type: "PINCODE",
    autocomplete: ["postal-code"],
    patterns: [/\b(?:pincode|pin[-_]?code|postal[-_]?code|zip|zipcode|postcode)\b/i, /\bpin\b/i],
    baseWeight: 0.92,
  },
  {
    type: "CITY",
    autocomplete: ["address-level2"],
    patterns: [/\b(?:city|town|district)\b/i],
    baseWeight: 0.90,
  },
  {
    type: "ADDRESS",
    autocomplete: ["street-address", "address-line1", "address-line2", "address-level1"],
    patterns: [/\b(?:address|street|addr|residence|house[-_]?no)\b/i, /address[-_]?line/i],
    baseWeight: 0.88,
  },
  {
    type: "NAME",
    autocomplete: ["name", "given-name", "family-name", "additional-name"],
    patterns: [
      /\b(?:fullname|full[-_]?name|your[-_]?name|first[-_]?name|last[-_]?name|customer[-_]?name)\b/i,
      /\bname\b/i,
      /\bfname\b/i,
      /\blname\b/i
    ],
    baseWeight: 0.85,
  },
  {
    type: "DEPARTMENT",
    autocomplete: [],
    patterns: [/\b(?:department|dept|division|team|unit)\b/i],
    baseWeight: 0.85,
  },
  {
    type: "YEAR",
    autocomplete: [],
    patterns: [/\b(?:year|year\s*of\s*study|academic\s*year|batch|graduating\s*year|semester)\b/i],
    baseWeight: 0.85,
  }
];

/**
 * Classifies an individual interactive element by combining multiple signals
 */
function classifyInputField(el, labelMap) {
  const attrType     = (el.getAttribute("type") || el.type || "text").toLowerCase();
  const role         = (el.getAttribute("role") || "").toLowerCase();
  const autocomplete = (el.getAttribute("autocomplete") || "").toLowerCase().trim();
  const ariaLabel    = (el.getAttribute("aria-label") || "").trim();
  const labelText    = getElementContextLabel(el, labelMap);
  const nameId       = `${el.name || ""} ${el.id || ""} ${el.getAttribute("data-value") || ""}`.trim();
  const placeholder  = (el.placeholder || "").trim();
  const currentVal   = el.value || el.getAttribute("data-value") || (el.isContentEditable ? el.innerText : "") || "";

  let bestRule = null;
  let bestScore = 0;

  for (const rule of CLASSIFIER_RULES) {
    let score = 0;

    // 1. Exact input type match (+0.95)
    if (rule.exactInputTypes && rule.exactInputTypes.includes(attrType)) {
      score += 0.95;
    }

    // 2. Autocomplete match (+0.90)
    if (autocomplete && rule.autocomplete && rule.autocomplete.includes(autocomplete)) {
      score += 0.90;
    }

    // 3. Structural value validator match (+0.95)
    if (rule.valueValidator && currentVal && rule.valueValidator(currentVal)) {
      score += 0.95;
    }

    const testPatterns = (text) => {
      if (!text) return false;
      return rule.patterns.some(p => p.test(text));
    };

    // 4. aria-label match (+0.85)
    if (testPatterns(ariaLabel)) {
      score += 0.85;
    }

    // 5. Context label match (+0.85)
    if (testPatterns(labelText)) {
      score += 0.85;
    }

    // 6. name / id / data-value match (+0.75)
    if (testPatterns(nameId)) {
      score += 0.75;
    }

    // 7. placeholder match (+0.65)
    if (testPatterns(placeholder)) {
      score += 0.65;
    }

    if (score > bestScore) {
      bestScore = score;
      bestRule = rule;
    }
  }

  // Minimum composite score threshold to classify
  if (bestScore >= 0.50 && bestRule) {
    return {
      type: bestRule.type,
      confidence: Math.min(0.99, Number((bestScore * bestRule.baseWeight).toFixed(2))),
      score: bestScore
    };
  }

  // Fallbacks based strictly on HTML input type or ARIA role
  if (attrType === "password") return { type: "PASSWORD", confidence: 1.0, score: 1.0 };
  if (attrType === "email")    return { type: "EMAIL", confidence: 0.95, score: 0.95 };
  if (attrType === "tel")      return { type: "PHONE", confidence: 0.90, score: 0.90 };
  if (attrType === "date")     return { type: "DOB", confidence: 0.90, score: 0.90 };
  if (role === "radio" || attrType === "radio") return { type: "RADIO_OPTION", confidence: 0.85, score: 0.85 };
  if (role === "checkbox" || attrType === "checkbox") return { type: "CHECKBOX_OPTION", confidence: 0.85, score: 0.85 };

  return null;
}

// ---------------------------------------------------------------------------
// DOM scanner — maps visible interactive & sensitive fields
// ---------------------------------------------------------------------------
function scanDOM() {
  const results = [];
  window._agentElements = [];
  const dpr = window.devicePixelRatio || 1;

  function addRegion(el, type, confidence = 1.0, extraLabel = "") {
    if (!el) return;
    if (window._agentElements.some(ae => ae.el === el)) return;

    const r = el.getBoundingClientRect();
    const isVisible = r.width > 0 && r.height > 0 &&
                      r.bottom >= 0 && r.top <= window.innerHeight &&
                      r.right >= 0 && r.left <= window.innerWidth;

    if (!isVisible) {
      return;
    }

    const elemIndex = window._agentElements.length;
    const agentId = `agent_${elemIndex}`;
    el.setAttribute("data-agent-id", agentId);

    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role") || (el.type ? el.type : (tag === "textarea" ? "textbox" : (tag === "select" ? "combobox" : "textbox")));

    const currentVal = el.value || el.getAttribute("data-value") || (el.isContentEditable ? el.innerText : "") || "";

    const region = {
      bbox: [
        Math.round(r.left   * dpr),
        Math.round(r.top    * dpr),
        Math.round(r.width  * dpr),
        Math.round(r.height * dpr),
      ],
      agentId,
      type,
      confidence,
      source: "dom",
      id: el.id || agentId,
      name: el.name || "",
      placeholder: el.placeholder || "",
      tag,
      role,
      label: extraLabel || getElementContextLabel(el, new Map()),
      inputType: el.type || role || "text",
      current_value: currentVal
    };

    window._agentElements.push({ el, type, id: el.id || agentId, agentId, bbox: region.bbox });
    results.push(region);
    console.log(`[Content][scanDOM] ✓ Classified & mapped region [${agentId}]: ${type} (role: ${role}) label: "${region.label}"`, region);
  }

  // 1. Build label map for all labels on the page
  const labelMap = new Map();
  document.querySelectorAll("label").forEach((lbl) => {
    const forId = lbl.getAttribute("for");
    const txt = (lbl.innerText || lbl.textContent || "").trim();
    if (forId && txt) {
      labelMap.set(forId, txt);
    }
  });

  // 2. Broadened candidate selectors: query inputs, textareas, selects, and ARIA roles
  const candidateSelectors = [
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]):not([type="file"])',
    'textarea',
    'select',
    '[role="textbox"]',
    '[role="radio"]',
    '[role="checkbox"]',
    '[role="combobox"]',
    '[role="listbox"]',
    '[contenteditable="true"]',
    '[contenteditable=""]'
  ].join(", ");

  const candidateElements = document.querySelectorAll(candidateSelectors);

  candidateElements.forEach((el) => {
    const classification = classifyInputField(el, labelMap);
    const label = getElementContextLabel(el, labelMap);
    const role = el.getAttribute("role") || el.type || "";

    if (classification) {
      addRegion(el, classification.type, classification.confidence, label);
    } else if (role === "radio" || el.type === "radio") {
      addRegion(el, "RADIO_OPTION", 0.85, label);
    } else if (role === "checkbox" || el.type === "checkbox") {
      addRegion(el, "CHECKBOX_OPTION", 0.85, label);
    } else if (role === "textbox" || el.isContentEditable) {
      addRegion(el, "FORM_FIELD", 0.80, label);
    }
  });

  // 3. Media elements (img, video, canvas) for Face Detection Constraint
  const mediaRegions = [];
  document.querySelectorAll("img, video, canvas").forEach((el) => {
    const r = el.getBoundingClientRect();
    const isVisible = r.width >= 20 && r.height >= 20 &&
                      r.bottom >= 0 && r.top <= window.innerHeight &&
                      r.right >= 0 && r.left <= window.innerWidth;
    if (isVisible) {
      mediaRegions.push({
        tag: el.tagName.toLowerCase(),
        id: el.id || "",
        src: el.src || el.currentSrc || "",
        bbox: [
          Math.round(r.left   * dpr),
          Math.round(r.top    * dpr),
          Math.round(r.width  * dpr),
          Math.round(r.height * dpr),
        ]
      });
    }
  });

  return { domRegions: results, mediaRegions };
}

function computeDOMHash() {
  const text = document.body.innerText || "";
  const inputs = Array.from(document.querySelectorAll("input, button, textarea, select, [role='radio'], [role='textbox']"))
                      .map(e => (e.id || "") + (e.name || "") + (e.value || "") + (e.getAttribute("aria-checked") || "")).join("|");
  const raw = text + inputs;
  
  let hash = 5381;
  for (let i = 0; i < raw.length; i++) {
    hash = ((hash << 5) + hash) + raw.charCodeAt(i);
  }
  return hash.toString();
}

// ---------------------------------------------------------------------------
// Element Resolver (prioritizes stable data-agent-id)
// ---------------------------------------------------------------------------
function resolveElement(target_id) {
  if (!target_id) return null;
  const cleanId = target_id.replace(/^#/, "");

  // 1. Direct data-agent-id query (fastest & most stable across re-renders)
  if (!target_id.includes('"') && !target_id.includes("'")) {
    try {
      const byAgentId = document.querySelector(`[data-agent-id="${target_id}"]`);
      if (byAgentId) return byAgentId;
    } catch (e) {}
  }

  // 2. Look up in window._agentElements by agentId or index
  if (window._agentElements && window._agentElements.length > 0) {
    const match = window._agentElements.find(ae => ae.agentId === target_id || ae.id === target_id);
    if (match && document.contains(match.el)) return match.el;

    if (target_id.startsWith("agent_") || target_id.startsWith("elem_") || target_id.startsWith("region_")) {
      const idx = parseInt(target_id.split("_")[1], 10);
      if (!isNaN(idx) && window._agentElements[idx] && document.contains(window._agentElements[idx].el)) {
        return window._agentElements[idx].el;
      }
    }
  }

  // 3. Direct getElementById (only for simple IDs)
  if (!target_id.includes("[") && !target_id.includes(" ") && !target_id.includes(">") && !target_id.includes(".")) {
    try {
      const byId = document.getElementById(cleanId);
      if (byId) return byId;
    } catch (e) {}
  }

  // 4. By querySelector / name attribute
  try {
    const byQuery = document.querySelector(target_id);
    if (byQuery) return byQuery;
  } catch (e) {}

  if (!target_id.includes("[")) {
    try {
      const byName = document.querySelector(`[name="${target_id}"]`) ||
                     document.querySelector(`[name="${cleanId}"]`);
      if (byName) return byName;
    } catch (e) {}
  }

  // 5. Case-insensitive search across interactive elements
  const candidates = Array.from(document.querySelectorAll(
    'input, button, select, textarea, a, [role="radio"], [role="checkbox"], [role="textbox"], [contenteditable="true"]'
  ));
  const lower = cleanId.toLowerCase();
  const match = candidates.find(el =>
    (el.id && el.id.toLowerCase() === lower) ||
    (el.name && el.name.toLowerCase() === lower) ||
    (el.getAttribute("data-agent-id") && el.getAttribute("data-agent-id").toLowerCase() === lower) ||
    (el.getAttribute("data-value") && el.getAttribute("data-value").toLowerCase() === lower) ||
    (el.getAttribute("aria-label") && el.getAttribute("aria-label").toLowerCase().includes(lower)) ||
    (el.placeholder && el.placeholder.toLowerCase().includes(lower)) ||
    (el.innerText && el.innerText.toLowerCase().includes(lower))
  );
  if (match) return match;

  return null;
}

// ---------------------------------------------------------------------------
// Realistic Simulated Pointer Event Sequence
// ---------------------------------------------------------------------------
function simulatePointerSequence(el, clientX = 0, clientY = 0) {
  if (!clientX && !clientY && el && typeof el.getBoundingClientRect === "function") {
    const rect = el.getBoundingClientRect();
    clientX = Math.round(rect.left + rect.width / 2);
    clientY = Math.round(rect.top + rect.height / 2);
  }

  const screenX = clientX + (window.screenX || 0);
  const screenY = clientY + (window.screenY || 0);
  const pageX   = clientX + (window.scrollX || 0);
  const pageY   = clientY + (window.scrollY || 0);

  const eventInit = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX,
    clientY,
    screenX,
    screenY,
    pageX,
    pageY,
    button: 0,
    buttons: 1,
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true
  };

  try {
    if (typeof window !== "undefined" && typeof window.PointerEvent === "function") {
      el.dispatchEvent(new window.PointerEvent("pointerdown", eventInit));
    }
  } catch (e) {}

  try {
    const MouseEv = (typeof window !== "undefined" && window.MouseEvent) || MouseEvent;
    el.dispatchEvent(new MouseEv("mousedown", eventInit));
  } catch (e) {}

  if (typeof el.focus === "function") {
    try { el.focus(); } catch (e) {}
  }

  const releaseInit = { ...eventInit, buttons: 0 };

  try {
    const MouseEv = (typeof window !== "undefined" && window.MouseEvent) || MouseEvent;
    el.dispatchEvent(new MouseEv("mouseup", releaseInit));
    el.dispatchEvent(new MouseEv("click", releaseInit));
  } catch (e) {}

  try {
    if (typeof window !== "undefined" && typeof window.PointerEvent === "function") {
      el.dispatchEvent(new window.PointerEvent("pointerup", releaseInit));
    }
  } catch (e) {}

  // Ensure radio / checkbox updates aria-checked
  try {
    if (el.getAttribute("role") === "radio" || el.type === "radio") {
      el.setAttribute("aria-checked", "true");
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
  } catch (e) {}
}

// ---------------------------------------------------------------------------
// UI Helpers & Execution Logic
// ---------------------------------------------------------------------------
function highlightElement(el) {
  return new Promise(resolve => {
    if (!el || typeof el.getBoundingClientRect !== "function") {
      resolve();
      return;
    }
    const rect = el.getBoundingClientRect();
    const overlay = document.createElement("div");
    overlay.style.position = "fixed";
    overlay.style.left = `${rect.left}px`;
    overlay.style.top = `${rect.top}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
    overlay.style.border = "3px solid #f0f";
    overlay.style.boxSizing = "border-box";
    overlay.style.zIndex = "999999";
    overlay.style.pointerEvents = "none";
    overlay.style.transition = "opacity 0.3s";
    document.body.appendChild(overlay);

    setTimeout(() => {
      overlay.style.opacity = "0";
      setTimeout(() => {
        overlay.remove();
        resolve();
      }, 300);
    }, 300);
  });
}

function appendToLogPanel(text) {
  let panel = document.getElementById("agent-log-panel");
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "agent-log-panel";
    panel.style.position = "fixed";
    panel.style.bottom = "20px";
    panel.style.right = "20px";
    panel.style.background = "rgba(15, 23, 42, 0.9)";
    panel.style.color = "#94a3b8";
    panel.style.padding = "12px";
    panel.style.borderRadius = "8px";
    panel.style.zIndex = "999998";
    panel.style.fontFamily = "monospace";
    panel.style.fontSize = "12px";
    panel.style.maxWidth = "300px";
    panel.style.maxHeight = "200px";
    panel.style.overflowY = "auto";
    panel.style.pointerEvents = "none";
    document.body.appendChild(panel);
  }
  const entry = document.createElement("div");
  entry.textContent = `> ${text}`;
  entry.style.marginTop = "4px";
  panel.appendChild(entry);
  panel.scrollTop = panel.scrollHeight;
}

async function executeAction(actionJson) {
  const { action, value, field_type, reasoning, bbox } = actionJson;
  const target_id = actionJson.target_id || actionJson.target_group_id || "";
  console.log("[Content][executeAction] Received action request:", actionJson);

  // ── Dispatch select_choice ──────────────────────────────────────────────
  if (action === "select_choice") {
    const resolvedFieldType = field_type || "";
    let matchValue = actionJson.match_value || value;
    if (!matchValue && resolvedFieldType) {
      matchValue = await getVaultValue(resolvedFieldType);
    }

    if (!matchValue) {
      const errMsg = `Couldn't select choice for ${resolvedFieldType || "field"} — no match_value provided or found in profile`;
      appendToLogPanel(`❌ ${errMsg}`);
      console.warn(`[Content][executeAction][select_choice] ${errMsg}`, { target_id, resolvedFieldType });
      return { ok: false, error: errMsg, field_type: resolvedFieldType, target_id };
    }

    // 1. Gather candidate choice elements (radios, checkboxes, options, listitems)
    let candidateOptions = [];
    const targetGroupEl = resolveElement(target_id);

    if (targetGroupEl) {
      const insideOptions = Array.from(targetGroupEl.querySelectorAll(
        '[role="radio"], [role="checkbox"], [role="option"], input[type="radio"], input[type="checkbox"], option, .docssharedWizToggleLabeledControl'
      ));
      if (insideOptions.length > 0) {
        candidateOptions = insideOptions;
      } else {
        const parentContainer = targetGroupEl.closest('[role="listitem"], [role="radiogroup"], .geS5n, .Qr7Oae, .form-group, tr');
        if (parentContainer) {
          candidateOptions = Array.from(parentContainer.querySelectorAll(
            '[role="radio"], [role="checkbox"], [role="option"], input[type="radio"], input[type="checkbox"], option, .docssharedWizToggleLabeledControl'
          ));
        } else {
          candidateOptions = [targetGroupEl];
        }
      }
    }

    if (candidateOptions.length === 0) {
      // Search globally across the document for choice elements
      candidateOptions = Array.from(document.querySelectorAll(
        '[role="radio"], [role="checkbox"], [role="option"], input[type="radio"], input[type="checkbox"], option, .docssharedWizToggleLabeledControl'
      ));
    }

    // 2. Match candidate options against matchValue (exact first, word/acronym match, then case-insensitive partial)
    const cleanTarget = matchValue.trim().toLowerCase();
    let bestOption = null;
    let bestScore = -1;
    let chosenOptionText = "";

    candidateOptions.forEach((optEl) => {
      const optLabel = getElementContextLabel(optEl, new Map());
      const ariaLabel = (optEl.getAttribute("aria-label") || "").trim();
      const dataVal = (optEl.getAttribute("data-value") || "").trim();
      const innerTxt = (optEl.innerText || optEl.textContent || "").trim();
      const combined = `${ariaLabel} ${dataVal} ${optLabel} ${innerTxt}`.toLowerCase();

      let score = 0;
      // Exact match on data-value or aria-label (+100)
      if (dataVal.toLowerCase() === cleanTarget || ariaLabel.toLowerCase() === cleanTarget) {
        score = 100;
      } else if (optLabel.toLowerCase() === cleanTarget || innerTxt.toLowerCase() === cleanTarget) {
        score = 90;
      } else if (new RegExp(`\\b${cleanTarget.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, "i").test(combined)) {
        // Word or acronym match, e.g. "CSE" in "Computer Science & Engineering (CSE)" (+80)
        score = 80;
      } else if (combined.includes(cleanTarget)) {
        // Substring contains (+50)
        score = 50;
      } else if (cleanTarget.includes(dataVal.toLowerCase()) && dataVal.length > 1) {
        score = 40;
      }

      if (score > bestScore) {
        bestScore = score;
        bestOption = optEl;
        chosenOptionText = ariaLabel || dataVal || optLabel || innerTxt;
      }
    });

    if (!bestOption || bestScore < 30) {
      const errMsg = `No matching choice option found for "${matchValue}"`;
      appendToLogPanel(`❌ ${errMsg}`);
      return { ok: false, error: errMsg, match_value: matchValue };
    }

    console.log(`[Content][select_choice] match_value: "${matchValue}" -> Chosen Option Text: "${chosenOptionText}" (score: ${bestScore}) on element:`, {
      tagName: bestOption.tagName,
      dataAgentId: bestOption.getAttribute("data-agent-id"),
      dataValue: bestOption.getAttribute("data-value"),
      role: bestOption.getAttribute("role")
    });

    appendToLogPanel(`Selected "${chosenOptionText}" for ${resolvedFieldType || "choice"}`);
    await highlightElement(bestOption);
    simulatePointerSequence(bestOption);

    if (typeof bestOption.click === "function") {
      bestOption.click();
    }

    if (bestOption.tagName === "OPTION" && bestOption.parentElement && bestOption.parentElement.tagName === "SELECT") {
      bestOption.parentElement.value = bestOption.value;
      bestOption.parentElement.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      if (bestOption.getAttribute("role") === "radio" || bestOption.type === "radio") {
        bestOption.setAttribute("aria-checked", "true");
        bestOption.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (bestOption.getAttribute("role") === "checkbox" || bestOption.type === "checkbox") {
        const currentChecked = bestOption.getAttribute("aria-checked") === "true";
        bestOption.setAttribute("aria-checked", currentChecked ? "false" : "true");
        bestOption.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }

    return {
      ok: true,
      mutated: true,
      action: "select_choice",
      target_id: bestOption.getAttribute("data-agent-id") || target_id,
      match_value: matchValue,
      chosenOption: chosenOptionText
    };
  }

  if (!target_id && !bbox) {
    appendToLogPanel(`Action failed: No target_id or bbox provided`);
    return { ok: false, error: "No target_id or bbox provided" };
  }

  let el = resolveElement(target_id);
  let usedCoordinateFallback = false;
  let fallbackCoords = null;

  // ── Coordinate-Based Fallback Execution ─────────────────────────────────
  // If element not resolved via query, simulate click at the CENTER of the bounding box
  if (!el && bbox && Array.isArray(bbox) && bbox.length === 4) {
    const dpr = window.devicePixelRatio || 1;
    const [bx, by, bw, bh] = bbox;
    const clientX = Math.round((bx + bw / 2) / dpr);
    const clientY = Math.round((by + bh / 2) / dpr);
    fallbackCoords = { clientX, clientY };

    console.log(`COORDINATE FALLBACK TRIGGERED for step ${actionJson.step || target_id}`);
    console.log(`[Content][executeAction] 📍 Target "${target_id}" not found via query. Using coordinate fallback at (${clientX}, ${clientY}) [bbox: [${bx},${by},${bw},${bh}], DPR: ${dpr}]`);

    if (typeof document.elementFromPoint === "function") {
      const elAtPoint = document.elementFromPoint(clientX, clientY);
      if (elAtPoint) {
        console.log(`[Content][executeAction] ✓ Found element at coordinate (${clientX}, ${clientY}): <${elAtPoint.tagName.toLowerCase()} role="${elAtPoint.getAttribute("role") || ''}">`);
        el = elAtPoint;
        usedCoordinateFallback = true;
      }
    }
  }

  if (!el) {
    console.error(`[Content][executeAction] ❌ Could not resolve target_id "${target_id}" to any DOM element and coordinate fallback found no target.`);
    appendToLogPanel(`Action failed: Element ${target_id} not found`);
    return { ok: false, error: `Element ${target_id} not found` };
  }

  console.log(`[Content][executeAction] ✓ Ready to execute on element:`, {
    target_id,
    tagName: el.tagName,
    id: el.id,
    dataAgentId: el.getAttribute("data-agent-id"),
    role: el.getAttribute("role"),
    usedCoordinateFallback
  });

  // 1. Highlight
  appendToLogPanel(`Focusing ${target_id}${usedCoordinateFallback ? " (coords)" : ""}...`);
  await highlightElement(el);

  // 2. Execute DOM Mutation
  if (action === "click") {
    appendToLogPanel(`Clicked ${target_id}${usedCoordinateFallback ? " (via coords)" : ""}`);
    console.log(`[Content][executeAction] >>> REAL DOM MUTATION: Executing pointer click sequence on:`, {
      target_id,
      id: el.id,
      tagName: el.tagName,
      role: el.getAttribute("role"),
      usedCoordinateFallback
    });

    simulatePointerSequence(el, fallbackCoords?.clientX, fallbackCoords?.clientY);

    if (typeof el.click === "function") {
      el.click();
    }

    // If part of radio group, update radio state
    const radioEl = el.getAttribute("role") === "radio" ? el : el.closest('[role="radio"]');
    if (radioEl) {
      radioEl.setAttribute("aria-checked", "true");
      radioEl.dispatchEvent(new Event("change", { bubbles: true }));
    }

    return { ok: true, mutated: true, action: "click", target_id, fallback: usedCoordinateFallback };

  } else if (action === "type") {
    // 1. Click first to focus (especially important for custom Google Forms text inputs)
    simulatePointerSequence(el, fallbackCoords?.clientX, fallbackCoords?.clientY);

    // 2. Determine target input element (active element or resolved element)
    let inputEl = (document.activeElement && (document.activeElement.tagName === "INPUT" || document.activeElement.tagName === "TEXTAREA" || document.activeElement.isContentEditable || document.activeElement.getAttribute("role") === "textbox"))
      ? document.activeElement
      : el;

    if (!("value" in inputEl) && !inputEl.isContentEditable) {
      const nestedInput = inputEl.querySelector('input, textarea, [contenteditable="true"], [role="textbox"]');
      if (nestedInput) inputEl = nestedInput;
    }

    const agentMatch = (window._agentElements || []).find(ae => ae.el === inputEl || ae.el === el);
    const resolvedFieldType = field_type || agentMatch?.type || "";

    // Read stored profile value from chrome.storage.local vault
    let typeValue = await getVaultValue(resolvedFieldType);

    // For sensitive fields, NEVER trust or use server-supplied values
    const SENSITIVE_STUB_TYPES = [
      "PASSWORD", "CARD", "AADHAAR", "PAN", "GSTIN", "IFSC", "INDIAN_MOBILE", "BANK_ACCOUNT"
    ];

    if (!typeValue && !SENSITIVE_STUB_TYPES.includes(resolvedFieldType) && inputEl.type !== "password") {
      typeValue = value;
    }

    if (!typeValue) {
      const errMsg = `Couldn't fill the ${resolvedFieldType || "requested"} field — no value stored in your profile`;
      appendToLogPanel(`❌ ${errMsg}`);
      console.warn(`[Content][executeAction] ${errMsg}`, { target_id, resolvedFieldType });
      return { ok: false, error: errMsg, field_type: resolvedFieldType, target_id };
    }

    appendToLogPanel(`Typed into ${target_id} (${resolvedFieldType})${usedCoordinateFallback ? " (via coords)" : ""}`);
    console.log(`[Content][executeAction] >>> REAL DOM MUTATION: Setting element value on:`, {
      target_id,
      tagName: inputEl.tagName,
      role: inputEl.getAttribute("role"),
      isContentEditable: inputEl.isContentEditable,
      field_type: resolvedFieldType,
      usedCoordinateFallback,
      newValue: (resolvedFieldType === "PASSWORD" || inputEl.type === "password") ? "••••••••" : typeValue
    });

    if (typeof inputEl.focus === "function") inputEl.focus();

    // Standard input or textarea
    if ("value" in inputEl) {
      inputEl.value = typeValue;
      inputEl.dispatchEvent(new Event("input", { bubbles: true }));
      inputEl.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      // Contenteditable or custom textbox div (Google Forms paragraph or custom field)
      inputEl.innerText = typeValue;
      try {
        if (typeof document.execCommand === "function") {
          document.execCommand("insertText", false, typeValue);
        }
      } catch (e) {}
      inputEl.dispatchEvent(new Event("input", { bubbles: true }));
      inputEl.dispatchEvent(new Event("change", { bubbles: true }));
    }

    // Keyboard events sequence to notify modern frameworks (React, Angular, Google Forms closure)
    try {
      inputEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      inputEl.dispatchEvent(new KeyboardEvent("keypress", { key: "Enter", bubbles: true }));
      inputEl.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
    } catch (e) {}

    if (typeof inputEl.blur === "function") inputEl.blur();

    return { ok: true, mutated: true, action: "type", target_id, value: typeValue, fallback: usedCoordinateFallback };

  } else if (action === "select_choice") {
    // ── Select Choice Action Execution ────────────────────────────────────
    // Handles radio button groups, checkboxes, and select dropdowns by matching option label
    const resolvedFieldType = field_type || "";
    let matchValue = actionJson.match_value || value;
    if (!matchValue && resolvedFieldType) {
      matchValue = await getVaultValue(resolvedFieldType);
    }

    if (!matchValue) {
      const errMsg = `Couldn't select choice for ${resolvedFieldType || "field"} — no match_value provided or found in profile`;
      appendToLogPanel(`❌ ${errMsg}`);
      console.warn(`[Content][executeAction][select_choice] ${errMsg}`, { target_id, resolvedFieldType });
      return { ok: false, error: errMsg, field_type: resolvedFieldType, target_id };
    }

    // 1. Gather candidate choice elements (radios, checkboxes, options, listitems)
    let candidateOptions = [];
    const targetGroupEl = resolveElement(actionJson.target_group_id || target_id);

    if (targetGroupEl) {
      const insideOptions = Array.from(targetGroupEl.querySelectorAll(
        '[role="radio"], [role="checkbox"], [role="option"], input[type="radio"], input[type="checkbox"], option, .docssharedWizToggleLabeledControl'
      ));
      if (insideOptions.length > 0) {
        candidateOptions = insideOptions;
      } else {
        // If targetGroupEl itself is a choice element or question container
        const parentContainer = targetGroupEl.closest('[role="listitem"], [role="radiogroup"], .geS5n, .Qr7Oae, .form-group, tr');
        if (parentContainer) {
          candidateOptions = Array.from(parentContainer.querySelectorAll(
            '[role="radio"], [role="checkbox"], [role="option"], input[type="radio"], input[type="checkbox"], option, .docssharedWizToggleLabeledControl'
          ));
        } else {
          candidateOptions = [targetGroupEl];
        }
      }
    }

    if (candidateOptions.length === 0) {
      // Search globally across the document for choice elements
      candidateOptions = Array.from(document.querySelectorAll(
        '[role="radio"], [role="checkbox"], [role="option"], input[type="radio"], input[type="checkbox"], option, .docssharedWizToggleLabeledControl'
      ));
    }

    // 2. Match candidate options against matchValue (exact first, word/acronym match, then case-insensitive partial)
    const cleanTarget = matchValue.trim().toLowerCase();
    let bestOption = null;
    let bestScore = -1;
    let chosenOptionText = "";

    candidateOptions.forEach((optEl) => {
      const optLabel = getElementContextLabel(optEl, new Map());
      const ariaLabel = (optEl.getAttribute("aria-label") || "").trim();
      const dataVal = (optEl.getAttribute("data-value") || "").trim();
      const innerTxt = (optEl.innerText || optEl.textContent || "").trim();
      const combined = `${ariaLabel} ${dataVal} ${optLabel} ${innerTxt}`.toLowerCase();

      let score = 0;
      // Exact match on data-value or aria-label (+100)
      if (dataVal.toLowerCase() === cleanTarget || ariaLabel.toLowerCase() === cleanTarget) {
        score = 100;
      } else if (optLabel.toLowerCase() === cleanTarget || innerTxt.toLowerCase() === cleanTarget) {
        score = 90;
      } else if (new RegExp(`\\b${cleanTarget.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, "i").test(combined)) {
        // Word or acronym match, e.g. "CSE" in "Computer Science & Engineering (CSE)" (+80)
        score = 80;
      } else if (combined.includes(cleanTarget)) {
        // Substring contains (+50)
        score = 50;
      } else if (cleanTarget.includes(dataVal.toLowerCase()) && dataVal.length > 1) {
        score = 40;
      }

      if (score > bestScore) {
        bestScore = score;
        bestOption = optEl;
        chosenOptionText = ariaLabel || dataVal || optLabel || innerTxt;
      }
    });

    if (!bestOption || bestScore < 30) {
      if (el) {
        bestOption = el;
        chosenOptionText = getElementContextLabel(el, new Map()) || el.getAttribute("aria-label") || el.getAttribute("data-value") || "";
      } else {
        const errMsg = `No matching choice option found for "${matchValue}"`;
        appendToLogPanel(`❌ ${errMsg}`);
        return { ok: false, error: errMsg, match_value: matchValue };
      }
    }

    console.log(`[Content][select_choice] match_value: "${matchValue}" -> Chosen Option Text: "${chosenOptionText}" (score: ${bestScore}) on element:`, {
      tagName: bestOption.tagName,
      dataAgentId: bestOption.getAttribute("data-agent-id"),
      dataValue: bestOption.getAttribute("data-value"),
      role: bestOption.getAttribute("role")
    });

    appendToLogPanel(`Selected "${chosenOptionText}" for ${resolvedFieldType || "choice"}`);
    await highlightElement(bestOption);
    simulatePointerSequence(bestOption, fallbackCoords?.clientX, fallbackCoords?.clientY);

    if (typeof bestOption.click === "function") {
      bestOption.click();
    }

    if (bestOption.tagName === "OPTION" && bestOption.parentElement && bestOption.parentElement.tagName === "SELECT") {
      bestOption.parentElement.value = bestOption.value;
      bestOption.parentElement.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      if (bestOption.getAttribute("role") === "radio" || bestOption.type === "radio") {
        bestOption.setAttribute("aria-checked", "true");
        bestOption.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (bestOption.getAttribute("role") === "checkbox" || bestOption.type === "checkbox") {
        const currentChecked = bestOption.getAttribute("aria-checked") === "true";
        bestOption.setAttribute("aria-checked", currentChecked ? "false" : "true");
        bestOption.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }

    return {
      ok: true,
      mutated: true,
      action: "select_choice",
      target_id: bestOption.getAttribute("data-agent-id") || target_id,
      match_value: matchValue,
      chosenOption: chosenOptionText
    };

  } else {
    appendToLogPanel(`Unsupported action: ${action}`);
    return { ok: false, error: `Unsupported action: ${action}` };
  }
}

// ---------------------------------------------------------------------------
// Message listeners
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {

  // ── DOM scan request from background.js ────────────────────────────────
  if (message.type === "SCAN_DOM") {
    const { domRegions, mediaRegions } = scanDOM();
    const domHash = computeDOMHash();
    console.log(`[Content] DOM scan: ${domRegions.length} interactive field(s), ${mediaRegions.length} media element(s) found. Hash: ${domHash}`);
    sendResponse({ domRegions, mediaRegions, domHash });
    return; // synchronous response
  }

  // ── Stats update from background.js ────────────────────────────────────
  if (message.type === "UPDATE_STATS") {
    let panel = document.getElementById("agent-log-panel");
    if (!panel) return;
    let statsEl = document.getElementById("agent-stats-header");
    if (!statsEl) {
      statsEl = document.createElement("div");
      statsEl.id = "agent-stats-header";
      statsEl.style.borderBottom = "1px solid #334155";
      statsEl.style.paddingBottom = "8px";
      statsEl.style.marginBottom = "8px";
      statsEl.style.color = "#cbd5e1";
      statsEl.style.fontWeight = "bold";
      panel.insertBefore(statsEl, panel.firstChild);
    }
    const s = message.payload;
    const avg = s.framesCaptured > 0 ? (s.totalLatencyMs / s.framesCaptured).toFixed(0) : 0;
    statsEl.innerHTML = `🏁 ${s.framesCaptured} frames | 👁️ ${s.visionInferences} full visions | ⏱️ Avg latency: ${avg}ms`;
    return;
  }

  // ── Execute action ─────────────────────────────────────────────────────
  if (message.type === "EXECUTE_ACTION") {
    const actionJson = message.payload ?? {};
    console.log("[Content] Received action:", actionJson);
    executeAction(actionJson).then(res => sendResponse(res));
    return true; // async response
  }
});
