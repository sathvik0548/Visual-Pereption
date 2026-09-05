/**
 * content.js — Content Script (injected into every page)
 *
 * v0.2 additions:
 *   - scanDOM()       — locates sensitive input fields and maps them to
 *                       screenshot pixel coordinates (pre-scaled by devicePixelRatio)
 *   - SCAN_DOM handler — called by background.js before each analysis run
 *
 * Future uses:
 *   - Execute DOM actions dictated by the VLM (click, type, scroll, etc.)
 *   - Extract structured page metadata (accessibility tree, element bounds)
 */

console.log("[Content] Browser Agent content script loaded on:", window.location.href);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
window._agentElements = [];
const MOCK_STORE = {
  "PASSWORD": "mock_password_123",
  "CARD": "4000123456789010"
};

// ---------------------------------------------------------------------------
// DOM scanner — maps visible sensitive fields to screenshot pixel coordinates
// ---------------------------------------------------------------------------
function scanDOM() {
  const results = [];
  window._agentElements = [];
  const dpr     = window.devicePixelRatio || 1;

  /**
   * Add a sensitive region from a DOM element.
   * Filters out off-screen elements and zero-size elements.
   * Scales coordinates from CSS px → physical px (matching captureVisibleTab).
   */
  function addRegion(el, type, confidence = 1.0) {
    const r = el.getBoundingClientRect();
    // Skip invisible or off-viewport elements
    if (r.width <= 0 || r.height <= 0)         return;
    if (r.bottom < 0 || r.top  > window.innerHeight) return;
    if (r.right  < 0 || r.left > window.innerWidth)  return;

    window._agentElements.push({ el, type });

    results.push({
      bbox:       [
        Math.round(r.left   * dpr),
        Math.round(r.top    * dpr),
        Math.round(r.width  * dpr),
        Math.round(r.height * dpr),
      ],
      type,
      confidence,
      source: "dom",
    });
  }

  // ── PASSWORD fields ────────────────────────────────────────────────────
  document.querySelectorAll('input[type="password"]')
    .forEach((el) => addRegion(el, "PASSWORD"));

  // ── EMAIL fields ───────────────────────────────────────────────────────
  document.querySelectorAll(
    'input[type="email"], input[autocomplete="email"]'
  ).forEach((el) => addRegion(el, "EMAIL"));

  // ── PHONE fields ───────────────────────────────────────────────────────
  document.querySelectorAll(
    'input[type="tel"], input[autocomplete="tel"]'
  ).forEach((el) => addRegion(el, "PHONE"));

  // ── CARD fields (autocomplete attributes + common name/id patterns) ────
  document.querySelectorAll([
    'input[autocomplete="cc-number"]',
    'input[autocomplete="cc-csc"]',
    'input[autocomplete="cc-exp"]',
    'input[autocomplete="cc-name"]',
    'input[autocomplete="cc-exp-month"]',
    'input[autocomplete="cc-exp-year"]',
    'input[name*="card"][type="text"]',
    'input[name*="credit"]',
    'input[name*="cvv"]',
    'input[id*="card-number"]',
  ].join(",")).forEach((el) => addRegion(el, "CARD", 0.9));

  // ── Generic PII autocomplete hints ─────────────────────────────────────
  const nameAutos = ["name", "given-name", "family-name", "additional-name"];
  nameAutos.forEach((ac) => {
    document.querySelectorAll(`input[autocomplete="${ac}"]`)
      .forEach((el) => addRegion(el, "NAME", 0.8));
  });

  return results;
}

// ---------------------------------------------------------------------------
// UI Helpers & Execution Logic
// ---------------------------------------------------------------------------
function highlightElement(el) {
  return new Promise(resolve => {
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
    overlay.style.transition = "opacity 0.5s";
    document.body.appendChild(overlay);

    setTimeout(() => {
      overlay.style.opacity = "0";
      setTimeout(() => {
        overlay.remove();
        resolve();
      }, 500);
    }, 500);
  });
}

function showConfirmDialog(actionText) {
  return new Promise(resolve => {
    const dialog = document.createElement("div");
    dialog.style.position = "fixed";
    dialog.style.bottom = "20px";
    dialog.style.left = "50%";
    dialog.style.transform = "translateX(-50%)";
    dialog.style.background = "#1e293b";
    dialog.style.color = "#fff";
    dialog.style.padding = "16px";
    dialog.style.borderRadius = "8px";
    dialog.style.zIndex = "999999";
    dialog.style.boxShadow = "0 4px 12px rgba(0,0,0,0.5)";
    dialog.style.fontFamily = "system-ui";
    dialog.style.fontSize = "14px";
    
    dialog.innerHTML = `
      <div style="margin-bottom: 12px">⚠️ Sensitive Action: <strong>${actionText}</strong></div>
      <div style="display: flex; gap: 8px; justify-content: flex-end">
        <button id="agent-cancel-btn" style="padding: 6px 12px; background: #334155; color: white; border: none; border-radius: 4px; cursor: pointer">Cancel</button>
        <button id="agent-confirm-btn" style="padding: 6px 12px; background: #ef4444; color: white; border: none; border-radius: 4px; cursor: pointer">Confirm</button>
      </div>
    `;
    
    document.body.appendChild(dialog);
    
    document.getElementById("agent-cancel-btn").onclick = () => {
      dialog.remove();
      resolve(false);
    };
    document.getElementById("agent-confirm-btn").onclick = () => {
      dialog.remove();
      resolve(true);
    };
  });
}

const SENSITIVE_KEYWORDS = ["delete", "submit", "transfer", "confirm", "pay"];

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
  entry.textContent = \`> \${text}\`;
  entry.style.marginTop = "4px";
  panel.appendChild(entry);
  panel.scrollTop = panel.scrollHeight;
}

async function executeAction(actionJson) {
  const { action, target_id, value, reasoning } = actionJson;
  
  if (!target_id) {
    appendToLogPanel(\`Action failed: No target_id\`);
    return { ok: false, error: "No target_id provided" };
  }
  
  const isElem = target_id.startsWith("elem_");
  const idx = parseInt(target_id.split("_")[1], 10);
  
  if (!isElem || isNaN(idx) || !window._agentElements[idx]) {
    appendToLogPanel(\`Action failed: Element \${target_id} not found\`);
    return { ok: false, error: "Element not found" };
  }
  
  const { el, type } = window._agentElements[idx];
  
  // 1. Highlight
  appendToLogPanel(\`Focusing \${target_id}...\`);
  await highlightElement(el);
  
  // 2. Guardrail Check
  const intentText = (reasoning || "") + " " + (el.innerText || "") + " " + (el.value || "");
  const isSensitive = SENSITIVE_KEYWORDS.some(kw => intentText.toLowerCase().includes(kw));
  const isSensitiveClick = action === "click" && SENSITIVE_KEYWORDS.some(kw => (el.innerText || el.value || "").toLowerCase().includes(kw));
  
  if (isSensitive || isSensitiveClick) {
    const confirmed = await showConfirmDialog(\`\${action.toUpperCase()} on \${target_id}\`);
    if (!confirmed) {
      appendToLogPanel(\`Action cancelled by user\`);
      return { ok: false, error: "User cancelled sensitive action" };
    }
  }
  
  // 3. Execute
  if (action === "click") {
    appendToLogPanel(\`Clicked \${target_id}\`);
    el.click();
  } else if (action === "type") {
    let typeValue = value;
    if (type === "PASSWORD" || type === "CARD") {
      typeValue = MOCK_STORE[type] || value;
      appendToLogPanel(\`Stubbing value for \${type} field\`);
    }
    appendToLogPanel(\`Typed into \${target_id}\`);
    el.value = typeValue;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } else {
    appendToLogPanel(\`Unsupported action: \${action}\`);
    return { ok: false, error: "Unsupported action" };
  }
  
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Message listeners
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {

  // ── DOM scan request from background.js ────────────────────────────────
  if (message.type === "SCAN_DOM") {
    const domRegions = scanDOM();
    console.log(\`[Content] DOM scan: \${domRegions.length} sensitive field(s) found.\`);
    sendResponse({ domRegions });
    return; // synchronous response — no need to return true
  }

  // ── Execute action (future VLM-driven actions) ─────────────────────────
  if (message.type === "EXECUTE_ACTION") {
    const actionJson = message.payload ?? {};
    console.log("[Content] Received action:", actionJson);
    executeAction(actionJson).then(res => sendResponse(res));
    return true; // async response
  }
});
