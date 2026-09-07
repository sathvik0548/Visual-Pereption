const fs = require("fs");
const path = require("path");

async function main() {
  console.log("=== TELEMETRY VISUAL PERCEPTION PIPELINE TEST ===\n");

  // 1. Check screenshot
  const screenshotPath = path.join(__dirname, "telemetry_screenshot.png");
  if (!fs.existsSync(screenshotPath)) {
    throw new Error("telemetry_screenshot.png not found!");
  }
  const imageBuffer = fs.readFileSync(screenshotPath);
  const base64Image = imageBuffer.toString("base64");
  console.log(`[1] Screenshot loaded: ${imageBuffer.length} bytes, base64 length: ${base64Image.length}`);

  // 2. DOM scan check on telemetry-dashboard.html
  const htmlContent = fs.readFileSync(path.join(__dirname, "server/demo/telemetry-dashboard.html"), "utf8");
  // Check if any telemetry numbers or parameter names exist in the HTML text
  const params = ["Orbital Velocity", "7.66", "Battery Voltage", "21.8", "Thermal Reading", "34.2", "Signal Strength", "-88"];
  console.log("\n[2] Checking DOM text in telemetry-dashboard.html:");
  let foundInDOM = 0;
  for (const p of params) {
    const inHtml = htmlContent.includes(`>${p}<`) || htmlContent.includes(`>${p} `);
    console.log(`    Parameter "${p}" in readable DOM text: ${inHtml}`);
    if (inHtml) foundInDOM++;
  }
  console.log(`    -> DOM text items found: ${foundInDOM} / ${params.length} (DOM summary: 0 items from canvas)`);

  // 3. Send payload to server
  const payload = {
    version: "1.0",
    task_instruction: "Read the battery voltage and click Acknowledge if it's below 24V.",
    redacted_image: base64Image,
    manifest: [],      // No PII redactions on telemetry
    dom_summary: [],   // 0 items from canvas (proving DOM parsing alone fails)
    demo_mode: false,
    client_stats: { totalLatencyMs: 0 }
  };

  console.log("\n[3] Dispatching AgentRequestV1 to http://localhost:3000/analyze...");
  console.log(`    Task Instruction : "${payload.task_instruction}"`);
  console.log(`    DOM Summary Items: ${payload.dom_summary.length} items`);

  const t0 = Date.now();
  const res = await fetch("http://localhost:3000/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const duration = Date.now() - t0;
  console.log(`    Server HTTP Status: ${res.status} ${res.statusText} (${duration}ms)`);

  const result = await res.json();
  console.log("\n[4] Server Response:");
  console.log(JSON.stringify(result, null, 2));

  console.log("\n=== VERIFICATION SUMMARY ===");
  console.log("Canvas Drawn Voltage  : 21.8 V");
  console.log("DOM Summary Count     : 0 items (DOM cannot read canvas pixels)");
  console.log("Model Reasoning       :", result.reasoning);
  if (result.plan && result.plan.length > 0) {
    console.log("Plan Action           :", result.plan[0].action);
    console.log("Target Element        :", result.plan[0].target_id);
  }
}

main().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});
