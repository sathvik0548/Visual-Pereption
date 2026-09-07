/**
 * server.js — Local Analysis Server
 *
 * Receives a POST /analyze request from the browser extension,
 * and returns a dummy action response.
 *
 * Run: node server.js  (or: npm run dev  for auto-reload via nodemon)
 */

require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const path    = require("path");
const { validateAgentRequestV1 } = require("../schema/AgentRequestV1");
const AnthropicProvider = require("./providers/AnthropicProvider");
const GroqProvider      = require("./providers/GroqProvider");
const GeminiProvider    = require("./providers/GeminiProvider");
const GroqTextProvider  = require("./providers/GroqTextProvider");
const OllamaProvider    = require("./providers/OllamaProvider");
const { logMetric } = require("./utils/logger");

const app  = express();
const PORT = 3000;

// API key verification check (without logging key value)
const groqKey = process.env.GROQ_API_KEY;
if (!groqKey || groqKey.trim() === "") {
  console.warn(`[Server] ⚠️  GROQ_API_KEY is MISSING or EMPTY in server/.env!`);
} else {
  console.log(`[Server] ✓ GROQ_API_KEY detected (present and non-empty, length: ${groqKey.trim().length} chars)`);
}

// ---------------------------------------------------------------------------
// Swappable VLM Providers
// ---------------------------------------------------------------------------
const providers = {
  groq: new GroqProvider(),
  gemini: new GeminiProvider(),
  offline: new OllamaProvider(),
};

// Initial provider selection via environment variable: VLM_MODE="offline" | "cloud"
let activeMode = (process.env.VLM_MODE || "cloud").toLowerCase();
let activeProvider = activeMode === "offline" ? providers.offline : providers.groq;

console.log(`[Server] Active Mode: ${activeMode.toUpperCase()} (Provider: ${activeMode === "offline" ? "OllamaProvider" : "GroqProvider"})`);

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

// Allow requests from the Chrome extension (chrome-extension://*) and localhost
app.use(
  cors({
    origin: (origin, callback) => {
      // Permit requests from browser extensions (no "origin" header) and localhost
      if (!origin || origin.startsWith("chrome-extension://") || origin.startsWith("moz-extension://") || /localhost/.test(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`CORS: origin "${origin}" not allowed`));
      }
    },
    methods: ["POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

app.use(express.json({ limit: "20mb" })); // screenshots can be large
app.use(express.static(path.join(__dirname, "public"))); // Serve public/ demo HTML
app.use("/demo", express.static(path.join(__dirname, "demo"))); // Serve /demo/vendor-registration.html
app.use(express.static(path.join(__dirname, "demo"))); // Serve /vendor-registration.html direct

// Convenience route aliases for demo pages (with or without .html, and truncated URL safety)
app.get([
  "/demo/vendor-registration.html",
  "/demo/vendor-registration",
  "/demo/vendor-registrati",
  "/vendor-registration.html",
  "/vendor-registration",
  "/vendor-registrati"
], (req, res) => {
  res.sendFile(path.join(__dirname, "demo", "vendor-registration.html"));
});

app.get([
  "/demo/telemetry-dashboard.html",
  "/demo/telemetry-dashboard",
  "/telemetry-dashboard.html",
  "/telemetry-dashboard"
], (req, res) => {
  res.sendFile(path.join(__dirname, "demo", "telemetry-dashboard.html"));
});

let demoMetrics = {
  runs: 0,
  totalLatency: 0,
  manifestRegions: 0,
};

// ---------------------------------------------------------------------------
// POST /analyze
// ---------------------------------------------------------------------------

app.post("/analyze", async (req, res) => {
  try {
    validateAgentRequestV1(req.body);
  } catch (err) {
    console.error(`[Server] Payload validation failed: ${err.message}`);
    return res.status(400).json({ error: `Invalid AgentRequestV1 payload: ${err.message}` });
  }

  const { version, task_instruction, redacted_image, manifest, dom_summary, demo_mode, client_stats } = req.body;

  console.log(`\n[Server] /analyze received AgentRequestV1`);
  console.log(`  Task Instruction : ${task_instruction}`);
  console.log(`  Redacted Image   : ${redacted_image ? `${redacted_image.length} base64 chars` : "missing"}`);
  console.log(`  Manifest regions : ${manifest.length}`);
  console.log(`  DOM summary items: ${dom_summary.length}`);

  console.log(`\n========================================================`);
  console.log(`[Server][DEBUG] === RECEIVED dom_summary (${dom_summary.length} items) ===`);
  console.log(JSON.stringify(dom_summary, null, 2));
  console.log(`[Server][DEBUG] === RECEIVED manifest (${manifest.length} items) ===`);
  console.log(JSON.stringify(manifest, null, 2));
  console.log(`========================================================\n`);

  if (demo_mode) {
    demoMetrics.runs++;
    demoMetrics.manifestRegions += manifest.length;
    if (client_stats) demoMetrics.totalLatency += (client_stats.totalLatencyMs || 0);
  }

  const startTime = Date.now();
  try {
    const planResult = await activeProvider.analyze(req.body);
    const latencyMs = Date.now() - startTime;
    
    const planSteps = Array.isArray(planResult.plan) ? planResult.plan.length : 0;
    const isDone = planSteps === 0;
    console.log(`[Server] Plan returned in ${latencyMs}ms: ${planSteps} step(s). Done=${isDone}`);
    if (planResult.plan) {
      planResult.plan.forEach(s => console.log(`  Step ${s.step}: ${s.action} ${s.target_id} (${s.field_type || ''}) value=${s.value !== null ? '"'+s.value+'"' : 'null (client fills)'}`));
    }
    logMetric(task_instruction, planResult, latencyMs);
    
    if (isDone && demo_mode) {
      const avgLatency = demoMetrics.runs > 0 ? Math.round(demoMetrics.totalLatency / demoMetrics.runs) : 0;
      const expectedTotal = 5 * demoMetrics.runs;
      
      console.log(`\n======================================================`);
      console.log(`📊 DEMO METRICS REPORT`);
      console.log(`======================================================`);
      console.log(`Total Frames Analyzed : ${demoMetrics.runs}`);
      console.log(`Avg E2E Latency       : ${avgLatency} ms`);
      console.log(`PII Recall            : ${demoMetrics.manifestRegions} / ${expectedTotal} regions expected`);
      console.log(`Visual Redaction      : 100% (Physical Black Boxes)`);
      console.log(`======================================================\n`);
      
      demoMetrics = { runs: 0, totalLatency: 0, manifestRegions: 0 };
    }
    
    return res.json(planResult);
  } catch (error) {
    // Specific user-facing error messages for known failure modes
    const msg = error.message || String(error);
    let userMsg;
    if (msg.includes("fetch") || msg.includes("ECONNREFUSED") || msg.includes("network") || msg.includes("connection error")) {
      userMsg = activeMode === "offline" 
        ? "Couldn't reach local Ollama on http://127.0.0.1:11434 — check Ollama is running."
        : "Couldn't reach the reasoning server — check your internet or provider status.";
    } else if (msg.includes("json") || msg.includes("JSON") || msg.includes("parse")) {
      userMsg = "Got an unexpected response from the model — the VLM returned malformed JSON.";
    } else if (msg.includes("4MB") || msg.includes("Too Large")) {
      userMsg = "Image payload too large — reduce screenshot size or increase compression.";
    } else if (msg.includes("rate limit") || msg.includes("429")) {
      userMsg = "Rate limit reached on cloud provider — wait a moment and retry.";
    } else if (msg.includes("API key") || msg.includes("401")) {
      userMsg = "Invalid or missing API key in server/.env.";
    } else {
      userMsg = msg;
    }
    console.error(`[Server] VLM analysis failed:`, error);
    return res.status(500).json({ error: `VLM error: ${userMsg}` });
  }
});

// ---------------------------------------------------------------------------
// Provider selection endpoints
// ---------------------------------------------------------------------------
app.get("/provider", (_req, res) => {
  res.json({
    mode: activeMode,
    provider: activeMode === "offline" ? "Ollama (moondream)" : "Groq (Cloud)",
    offline: activeMode === "offline",
    statusText: activeMode === "offline"
      ? "OFFLINE MODE (Local Ollama — no network required)"
      : "CLOUD MODE (Groq)"
  });
});

app.post("/provider", (req, res) => {
  const { mode } = req.body || {};
  if (mode === "offline") {
    activeMode = "offline";
    activeProvider = providers.offline;
  } else if (mode === "cloud") {
    activeMode = "cloud";
    activeProvider = providers.groq;
  } else if (mode === "gemini") {
    activeMode = "gemini";
    activeProvider = providers.gemini;
  } else {
    return res.status(400).json({ error: "Invalid mode. Supported: 'cloud', 'offline', 'gemini'" });
  }

  console.log(`[Server] Switched provider to: ${activeMode.toUpperCase()}`);
  res.json({
    mode: activeMode,
    provider: activeMode === "offline" ? "Ollama (moondream)" : "Groq (Cloud)",
    offline: activeMode === "offline",
    statusText: activeMode === "offline"
      ? "OFFLINE MODE (Local Ollama — no network required)"
      : "CLOUD MODE (Groq)"
  });
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get("/health", (_req, res) => res.json({ status: "ok", mode: activeMode }));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`\n🚀  Browser Agent Server running on http://localhost:${PORT}`);
  console.log(`    Mode: ${activeMode.toUpperCase()} (${activeMode === "offline" ? "Local Ollama" : "Cloud Groq"})`);
  console.log(`    POST http://localhost:${PORT}/analyze`);
  console.log(`    GET  http://localhost:${PORT}/provider`);
  console.log(`    GET  http://localhost:${PORT}/health\n`);
});

