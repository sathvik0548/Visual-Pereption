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
const { validateAgentRequestV1 } = require("../schema/AgentRequestV1");
const AnthropicProvider = require("./providers/AnthropicProvider");
const { logMetric } = require("./utils/logger");

const app  = express();
const PORT = 3000;
const vlmProvider = new AnthropicProvider();

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

  const { version, task_instruction, redacted_image, manifest, dom_summary } = req.body;

  console.log(`\n[Server] /analyze received AgentRequestV1`);
  console.log(`  Task Instruction : ${task_instruction}`);
  console.log(`  Redacted Image   : ${redacted_image ? `${redacted_image.length} base64 chars` : "missing"}`);
  console.log(`  Manifest regions : ${manifest.length}`);
  console.log(`  DOM summary items: ${dom_summary.length}`);

  const startTime = Date.now();
  try {
    const actionResult = await vlmProvider.analyze(req.body);
    const latencyMs = Date.now() - startTime;
    
    console.log(`[Server] Action decided in ${latencyMs}ms:`, actionResult.action);
    logMetric(task_instruction, actionResult, latencyMs);
    
    return res.json(actionResult);
  } catch (error) {
    console.error(`[Server] VLM analysis failed:`, error);
    return res.status(500).json({ error: `VLM error: ${error.message}` });
  }
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get("/health", (_req, res) => res.json({ status: "ok" }));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`\n🚀  Browser Agent Server running on http://localhost:${PORT}`);
  console.log(`    POST http://localhost:${PORT}/analyze`);
  console.log(`    GET  http://localhost:${PORT}/health\n`);
});
