/**
 * test_ollama_e2e.js
 * End-to-end test for OllamaProvider
 */
"use strict";

const OllamaProvider = require("./server/providers/OllamaProvider");

const dom_summary = [
  { element_id: "elem_name",    tag: "input", role: "textbox", label: "Full Name",      field_type: "NAME",       current_value: "" },
  { element_id: "elem_email",   tag: "input", role: "textbox", label: "Email Address",  field_type: "EMAIL",      current_value: "" },
  { element_id: "elem_aadhaar", tag: "input", role: "textbox", label: "Aadhaar Number", field_type: "AADHAAR",    current_value: "" },
  { element_id: "elem_pan",     tag: "input", role: "textbox", label: "PAN Card",       field_type: "PAN",        current_value: "" },
  { element_id: "elem_dept",    tag: "input", role: "radio",   label: "Department",     field_type: "DEPARTMENT", current_value: "" },
];

const vault = {
  NAME:    "Sathvik Test User",
  EMAIL:   "sathvik@test.example.com",
  AADHAAR: "1234 5678 9012",
  PAN:     "ABCDE1234F",
};

// Tiny 1x1 white JPEG in base64
const TINY_IMAGE_B64 = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAARC AABAAEDASIAAhEBAxEB/8QAFgABAQEAAAAAAAAAAAAAAAAABgUEB//EAB8QAAIBBAMBAAAAAAAAAAAAAAABAgMEEQUSITH/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AqtBRRQB//9k=";

async function runTest() {
  console.log("=".repeat(60));
  console.log("OllamaProvider End-to-End Test");
  console.log("=".repeat(60));

  // Test 1: Check Ollama reachable
  console.log("\n[TEST 1] Checking Ollama /api/tags...");
  try {
    const tagsRes = await fetch("http://127.0.0.1:11434/api/tags");
    const tags = await tagsRes.json();
    const models = (tags.models || []).map(m => m.name);
    console.log("  PASS - Models:", models.join(", ") || "(none)");
  } catch (e) {
    console.error("  FAIL - Cannot reach Ollama:", e.message);
    process.exit(1);
  }

  // Test 2: Call analyze()
  console.log("\n[TEST 2] Calling OllamaProvider.analyze() with vault + DOM...");
  const provider = new OllamaProvider();
  const startMs = Date.now();
  let result;
  try {
    result = await provider.analyze({
      task_instruction: "Fill the registration form",
      redacted_image: TINY_IMAGE_B64,
      manifest: [],
      dom_summary,
      vault,
    });
  } catch (err) {
    console.error("  FAIL - analyze() threw:", err.message);
    process.exit(1);
  }
  const elapsed = Date.now() - startMs;
  console.log("  PASS - Returned in", elapsed + "ms");
  console.log("  Plan (" + result.plan.length + " step(s)):");
  for (const s of result.plan) {
    const v = s.value !== null ? '"' + s.value + '"' : s.match_value !== null ? 'match:"' + s.match_value + '"' : "SKIPPED(null)";
    console.log("    Step " + s.step + ": " + s.action + " " + s.target_id + " (" + s.field_type + ") -> " + v);
  }

  // Test 3: Check vault values in plan
  console.log("\n[TEST 3] Checking vault values appear in plan...");
  const nameStep  = result.plan.find(s => s.field_type === "NAME");
  const emailStep = result.plan.find(s => s.field_type === "EMAIL");
  console.log("  NAME step value :", nameStep ? nameStep.value : "(no step)");
  console.log("  EMAIL step value:", emailStep ? emailStep.value : "(no step)");
  console.log("  Expected NAME   :", vault.NAME);
  console.log("  Expected EMAIL  :", vault.EMAIL);
  if (nameStep && nameStep.value === vault.NAME) console.log("  PASS - NAME matches vault");
  else console.warn("  WARN - NAME mismatch or missing");
  if (emailStep && emailStep.value === vault.EMAIL) console.log("  PASS - EMAIL matches vault");
  else console.warn("  WARN - EMAIL mismatch or missing");

  // Test 4: Sensitive fields should NOT emit null plan steps (skip instead)
  console.log("\n[TEST 4] Verifying no null-value steps in plan...");
  const nullSteps = result.plan.filter(s => s.value === null && s.match_value === null);
  if (nullSteps.length === 0) {
    console.log("  PASS - No null-value steps in plan (hang-free)");
  } else {
    console.warn("  WARN - " + nullSteps.length + " step(s) still have null value:");
    for (const s of nullSteps) {
      console.warn("    Step " + s.step + ": " + s.field_type + " (target: " + s.target_id + ")");
    }
  }

  // Test 5: Timing
  console.log("\n[TEST 5] Timing check (must be < 15000ms)...");
  if (elapsed < 15000) {
    console.log("  PASS - " + elapsed + "ms < 15000ms");
  } else {
    console.error("  FAIL - " + elapsed + "ms exceeds 15s hard timeout");
  }

  console.log("\n" + "=".repeat(60));
  console.log("ALL TESTS COMPLETE");
  console.log("=".repeat(60));
}

runTest().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
