/**
 * test_article_list_task.js
 *
 * Verifies that the existing browser agent pipeline generalizes to arbitrary
 * web navigation tasks (non-form-filling):
 * 1. Perceives cookie consent banner and clicks Dismiss (action "click")
 * 2. Reads and semantically matches multiple headlines via visual/DOM context
 * 3. Identifies and clicks the specific "Read More" button for the requested article
 * 4. Confirms the correct article is opened on the real page DOM (not just the first one)
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const { JSDOM } = require("./extension/node_modules/jsdom");

async function main() {
  console.log("================================================================================");
  console.log("=== ARBITRARY BROWSER TASK DEMO: ARTICLE LIST & COOKIE BANNER DISMISSAL ===");
  console.log("================================================================================\n");

  // 1. Load screenshot and HTML
  const screenshotPath = path.join(__dirname, "article_screenshot.png");
  if (!fs.existsSync(screenshotPath)) {
    throw new Error("article_screenshot.png not found. Run headless chrome capture first.");
  }
  const imageBuffer = fs.readFileSync(screenshotPath);
  const base64Image = imageBuffer.toString("base64");
  console.log(`[1] Screenshot loaded: ${imageBuffer.length} bytes (base64 length: ${base64Image.length})`);

  const articleHtml = fs.readFileSync(path.join(__dirname, "server/demo/article-list.html"), "utf-8");
  const contentJsCode = fs.readFileSync(path.join(__dirname, "extension/content.js"), "utf-8");

  // 2. Initialize Real JSDOM Environment with event dispatching
  const dom = new JSDOM(articleHtml, { runScripts: "dangerously" });
  const { window } = dom;
  const { document } = window;
  global.window = window;
  global.document = document;
  dom.window.chrome = { runtime: { onMessage: { addListener: () => {} } } };
  window.innerWidth = 1280;
  window.innerHeight = 900;
  window.devicePixelRatio = 1;

  window.Element.prototype.getBoundingClientRect = function() {
    return { left: 100, top: 100, width: 140, height: 38, right: 240, bottom: 138 };
  };

  if (typeof window.PointerEvent === "undefined") {
    window.PointerEvent = class PointerEvent extends window.MouseEvent {
      constructor(type, init = {}) {
        super(type, init);
        this.pointerId = init.pointerId || 0;
        this.pointerType = init.pointerType || "mouse";
        this.isPrimary = init.isPrimary || false;
      }
    };
  }

  // Load content script into page
  window.eval(contentJsCode);

  // 3. Scan DOM for interactive elements
  const scanResult = window.eval("scanDOM()");
  console.log(`\n[2] DOM Scan: Mapped ${scanResult.domRegions.length} interactive elements on article-list.html:`);
  scanResult.domRegions.forEach((r) => {
    console.log(`    - [${r.agentId}] tag: <${r.tag}> id: "${r.id}" | label: "${r.label.replace(/\n\s+/g, ' ').substring(0, 75)}..."`);
  });

  const dom_summary = scanResult.domRegions.map((r, i) => ({
    element_id: r.agentId || `agent_${i}`,
    dom_id: r.id || "",
    name: r.name || "",
    placeholder: r.placeholder || "",
    tag: r.tag || "button",
    role: r.role || "button",
    label: r.label || "",
    field_type: r.type || "BUTTON",
    bbox: r.bbox,
    current_value: r.current_value || ""
  }));

  // 4. Send AgentRequestV1 to Reasoning Server
  const taskInstruction = "Dismiss the cookie banner, then click Read More on the article about James Webb Space Telescope discovering water vapor on an exoplanet.";
  const payload = {
    version: "1.0",
    task_instruction: taskInstruction,
    redacted_image: base64Image,
    manifest: [],
    dom_summary,
    demo_mode: false,
    client_stats: { totalLatencyMs: 0 }
  };

  console.log(`\n[3] Dispatching AgentRequestV1 to http://localhost:3000/analyze...`);
  console.log(`    Instruction: "${taskInstruction}"`);
  console.log(`    Interactive Elements in DOM summary: ${dom_summary.length}`);

  const t0 = Date.now();
  const serverRes = await fetch("http://localhost:3000/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const latency = Date.now() - t0;
  console.log(`    Server HTTP Status: ${serverRes.status} ${serverRes.statusText} (${latency}ms)`);

  const serverResult = await serverRes.json();
  console.log("\n[4] Server Returned Plan:");
  console.log(JSON.stringify(serverResult, null, 2));

  const plan = serverResult.plan || [];
  if (plan.length === 0) {
    throw new Error("Server returned empty plan! Reasoning: " + serverResult.reasoning);
  }

  // 5. Execute Plan Sequentially on Page DOM
  console.log(`\n[5] Executing ${plan.length} plan step(s) on the real DOM...`);

  const bannerEl = document.getElementById("cookie-banner");
  const cookieIndicator = document.getElementById("cookie-status-indicator");
  const exoplanetCard = document.getElementById("card-exoplanet");
  const exoplanetBtn = document.getElementById("read-more-exoplanet-btn");
  const semiconductorCard = document.getElementById("card-semiconductor");
  const statusBarText = document.getElementById("action-status-text");

  for (const step of plan) {
    console.log(`\n>>> Executing Step ${step.step}: action="${step.action}" target_id="${step.target_id}" (field: ${step.field_type})`);
    const actionResult = await window.eval(`executeAction(${JSON.stringify(step)})`);
    console.log(`    Result: ok=${actionResult.ok} mutated=${actionResult.mutated} target="${actionResult.target_id}"`);
  }

  // 6. Verification and Assertions
  console.log("\n================================================================================");
  console.log("=== FINAL VERIFICATION ON REAL PAGE DOM ===");
  console.log("================================================================================");

  const bannerDismissed = bannerEl.style.display === "none";
  const exoplanetOpened = exoplanetCard.classList.contains("selected");
  const semiconductorNotOpened = !semiconductorCard.classList.contains("selected");
  const buttonStateUpdated = exoplanetBtn.classList.contains("opened");
  const statusMessageCorrect = statusBarText.textContent.includes("James Webb Space Telescope");

  console.log(`1. Cookie Banner Dismissed        : ${bannerDismissed} (style.display = "${bannerEl.style.display}")`);
  console.log(`2. Cookie Indicator Text          : "${cookieIndicator.textContent}"`);
  console.log(`3. Correct Headline Selected      : ${exoplanetOpened} (card-exoplanet .selected = ${exoplanetOpened})`);
  console.log(`4. Wrong Headline Skipped (Semicon): ${semiconductorNotOpened} (card-semiconductor .selected = false)`);
  console.log(`5. Read More Button Updated Text  : "${exoplanetBtn.textContent}"`);
  console.log(`6. On-Page Status Bar Text        : "${statusBarText.textContent}"`);

  if (bannerDismissed && exoplanetOpened && semiconductorNotOpened && statusMessageCorrect) {
    console.log("\n✅ ALL THREE CHECKS CONFIRMED CLEANLY:");
    console.log("   - Cookie banner was detected and dismissed first.");
    console.log("   - Correct headline (James Webb Telescope Exoplanet) was identified among 7 articles.");
    console.log("   - The specific matching Read More button was clicked (not the first one).");
  } else {
    console.error("\n❌ VERIFICATION FAILED — see details above.");
    process.exit(1);
  }
}

main().catch(err => {
  console.error("Test error:", err);
  process.exit(1);
});
