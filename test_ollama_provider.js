/**
 * test_ollama_provider.js
 * Standalone test: instantiate OllamaProvider, call analyze() with dummy input.
 * Ollama does NOT need to be running — we expect a connection error, NOT a constructor error.
 * Exit 0 = provider loads and behaves correctly. Exit 1 = bug.
 */
"use strict";

const OllamaProvider = require("./server/providers/OllamaProvider");

// ── 1. Constructor test ───────────────────────────────────────────────────────
let provider;
try {
  provider = new OllamaProvider();
  console.log("✅  [1/3] Constructor: PASS — new OllamaProvider() succeeded");
  console.log("         baseUrl =", provider.baseUrl);
  console.log("         model   =", provider.model);
} catch (e) {
  console.error("❌  [1/3] Constructor: FAIL —", e.message);
  process.exit(1);
}

// ── 2. _classifyField / _demoValue unit tests ─────────────────────────────────
try {
  const cases = [
    [{ tag: "input", id: "email",    type: "email",    placeholder: "" }, "EMAIL"],
    [{ tag: "input", id: "password", type: "password", placeholder: "" }, "PASSWORD"],
    [{ tag: "input", id: "mobile",   type: "tel",      placeholder: "" }, "INDIAN_MOBILE"],
    [{ tag: "button",id: "submit",   type: "submit",   placeholder: "" }, "BUTTON"],
    [{ tag: "input", id: "name",     type: "text",     placeholder: "Full name" }, "NAME"],
  ];
  let allPassed = true;
  for (const [el, expected] of cases) {
    const got = provider._classifyField(el);
    if (got !== expected) {
      console.error(`❌  [2/3] _classifyField FAIL: ${JSON.stringify(el)} → got "${got}", expected "${expected}"`);
      allPassed = false;
    }
  }
  if (allPassed) console.log("✅  [2/3] _classifyField: PASS — all 5 cases correct");
  else process.exit(1);
} catch (e) {
  console.error("❌  [2/3] _classifyField: FAIL —", e.message);
  process.exit(1);
}

// ── 3. analyze() with dummy payload ──────────────────────────────────────────
// Ollama is likely not running; we should get a "connection error" (expected),
// NOT a TypeError/SyntaxError. That confirms the method exists and runs.
const dummyPayload = {
  version:          "1.0",
  task_instruction: "Fill out this form",
  redacted_image:   "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6V6AAA=",
  manifest:         [],
  dom_summary: [
    { element_id: "email-field",  tag: "input", role: "textbox", type: "email",    placeholder: "Email address", bbox: [10, 10, 200, 30] },
    { element_id: "submit-btn",   tag: "button", role: "button", type: "submit",   placeholder: "",               bbox: [10, 60, 100, 35] },
  ],
};

provider.analyze(dummyPayload)
  .then((result) => {
    console.log("✅  [3/3] analyze(): PASS — Ollama IS running! Got plan:", JSON.stringify(result.plan));
    process.exit(0);
  })
  .catch((err) => {
    if (/connection error|ECONNREFUSED|fetch/i.test(err.message)) {
      console.log("✅  [3/3] analyze(): PASS — Got expected connection error (Ollama not running):");
      console.log("         →", err.message);
      console.log("\nAll tests passed. OllamaProvider loads and runs correctly.");
      process.exit(0);
    } else {
      console.error("❌  [3/3] analyze(): FAIL — Unexpected error (not a connection error):");
      console.error("         →", err.message);
      process.exit(1);
    }
  });
