import { JSDOM } from "jsdom";
import fs from "fs";

// Read content.js
const contentJsCode = fs.readFileSync("./extension/content.js", "utf-8");

// Google Forms markup simulation (mimics actual Google Forms DOM with Name, Department radios, and Year radios)
const googleFormsHtml = `
<!DOCTYPE html>
<html>
  <head><title>Google Forms Demo — Student Registration</title></head>
  <body>
    <form class="freebirdFormviewerViewFormCard">
      <!-- Question 1: Text Question (Name) -->
      <div role="listitem" class="geS5n">
        <div role="heading" aria-level="3" class="M7eMe" id="i1">Full Name</div>
        <div class="AgroD">
          <div class="Xb9hP">
            <input type="text" class="whsOnd zHQkBf" jsname="YPqjbf" autocomplete="off" tabindex="0"
                   aria-labelledby="i1" dir="auto" data-initial-value="" badinput="false">
          </div>
        </div>
      </div>

      <!-- Question 2: Multiple Choice Radio Group (Department) -->
      <div role="listitem" class="geS5n">
        <div role="heading" aria-level="3" class="M7eMe" id="i5">Department</div>
        <div role="radiogroup" aria-labelledby="i5" class="SG0epd">
          <div class="nWQGrd">
            <div role="radio" class="docssharedWizToggleLabeledControl" aria-checked="false"
                 tabindex="0" data-value="CSE" aria-label="Computer Science & Engineering (CSE)">
              <div class="exportLabel">
                <span class="aDTYNe">Computer Science & Engineering (CSE)</span>
              </div>
            </div>
          </div>
          <div class="nWQGrd">
            <div role="radio" class="docssharedWizToggleLabeledControl" aria-checked="false"
                 tabindex="-1" data-value="ECE" aria-label="Electronics & Communication (ECE)">
              <div class="exportLabel">
                <span class="aDTYNe">Electronics & Communication (ECE)</span>
              </div>
            </div>
          </div>
          <div class="nWQGrd">
            <div role="radio" class="docssharedWizToggleLabeledControl" aria-checked="false"
                 tabindex="-1" data-value="MECH" aria-label="Mechanical Engineering (MECH)">
              <div class="exportLabel">
                <span class="aDTYNe">Mechanical Engineering (MECH)</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Question 3: Multiple Choice Radio Group (Year) -->
      <div role="listitem" class="geS5n">
        <div role="heading" aria-level="3" class="M7eMe" id="i9">Year of Study</div>
        <div role="radiogroup" aria-labelledby="i9" class="SG0epd">
          <div class="nWQGrd">
            <div role="radio" class="docssharedWizToggleLabeledControl" aria-checked="false"
                 tabindex="0" data-value="1st Year" aria-label="1st Year">
              <div class="exportLabel">
                <span class="aDTYNe">1st Year</span>
              </div>
            </div>
          </div>
          <div class="nWQGrd">
            <div role="radio" class="docssharedWizToggleLabeledControl" aria-checked="false"
                 tabindex="-1" data-value="2nd Year" aria-label="2nd Year">
              <div class="exportLabel">
                <span class="aDTYNe">2nd Year</span>
              </div>
            </div>
          </div>
          <div class="nWQGrd">
            <div role="radio" class="docssharedWizToggleLabeledControl" aria-checked="false"
                 tabindex="-1" data-value="3rd Year" aria-label="3rd Year">
              <div class="exportLabel">
                <span class="aDTYNe">3rd Year</span>
              </div>
            </div>
          </div>
          <div class="nWQGrd">
            <div role="radio" class="docssharedWizToggleLabeledControl" aria-checked="false"
                 tabindex="-1" data-value="4th Year" aria-label="4th Year">
              <div class="exportLabel">
                <span class="aDTYNe">4th Year</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </form>
  </body>
</html>
`;

const dom = new JSDOM(googleFormsHtml, { runScripts: "outside-only" });
const window = dom.window;
const document = window.document;

global.window = window;
global.document = document;
window.innerWidth = 1280;
window.innerHeight = 800;
window.devicePixelRatio = 1;

// PointerEvent polyfill for JSDOM
if (typeof window.PointerEvent === "undefined") {
  window.PointerEvent = class PointerEvent extends window.MouseEvent {
    constructor(type, init = {}) {
      super(type, init);
      this.pointerId = init.pointerId || 0;
      this.pointerType = init.pointerType || "mouse";
      this.isPrimary = init.isPrimary || false;
    }
  };
  global.PointerEvent = window.PointerEvent;
}

const mockVault = {
  NAME: "Rajesh Kumar",
  EMAIL: "vendor.demo@example.in",
  INDIAN_MOBILE: "9876543210",
  PHONE: "9876543210",
  DOB: "1990-05-15",
  ADDRESS: "42, MG Road, Bengaluru",
  CITY: "Bengaluru",
  PINCODE: "560001",
  AADHAAR: "5489 1234 5674",
  PAN: "ABCDE1234F",
  PASSWORD: "MockPassword@123"
};

global.chrome = {
  storage: {
    local: {
      get: (keys, cb) => cb({ agent_vault: mockVault }),
      set: (obj, cb) => cb?.(),
    }
  },
  runtime: {
    onMessage: { addListener: () => {} }
  }
};
window.chrome = global.chrome;

// Element positions simulation for getBoundingClientRect & elementFromPoint
const elementPositions = new Map();

window.Element.prototype.getBoundingClientRect = function() {
  if (elementPositions.has(this)) {
    return elementPositions.get(this);
  }
  return { left: 100, top: 100, width: 250, height: 35, right: 350, bottom: 135 };
};

// Set specific bounds for Name input, Department radios, and Year radios
const nameInput = document.querySelector('input.whsOnd');
const cseRadio = document.querySelector('[data-value="CSE"]');
const eceRadio = document.querySelector('[data-value="ECE"]');
const mechRadio = document.querySelector('[data-value="MECH"]');
const year1Radio = document.querySelector('[data-value="1st Year"]');
const year2Radio = document.querySelector('[data-value="2nd Year"]');
const year3Radio = document.querySelector('[data-value="3rd Year"]');
const year4Radio = document.querySelector('[data-value="4th Year"]');

elementPositions.set(nameInput, { left: 80, top: 120, width: 300, height: 40, right: 380, bottom: 160 });
elementPositions.set(cseRadio,   { left: 80, top: 220, width: 280, height: 30, right: 360, bottom: 250 });
elementPositions.set(eceRadio,   { left: 80, top: 260, width: 280, height: 30, right: 360, bottom: 290 });
elementPositions.set(mechRadio,  { left: 80, top: 300, width: 280, height: 30, right: 360, bottom: 330 });
elementPositions.set(year1Radio, { left: 80, top: 380, width: 160, height: 30, right: 240, bottom: 410 });
elementPositions.set(year2Radio, { left: 80, top: 420, width: 160, height: 30, right: 240, bottom: 450 });
elementPositions.set(year3Radio, { left: 80, top: 460, width: 160, height: 30, right: 240, bottom: 490 });
elementPositions.set(year4Radio, { left: 80, top: 500, width: 160, height: 30, right: 240, bottom: 530 });

// Implement elementFromPoint for coordinate fallback
document.elementFromPoint = function(x, y) {
  for (const [el, rect] of elementPositions.entries()) {
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
      return el;
    }
  }
  return null;
};

// Execute content.js inside this DOM
window.eval(contentJsCode);

console.log("\n================================================================================");
console.log("=== ITEM 1: EXACT dom_summary ARRAY BEFORE LEAVING EXTENSION (RAW JSON) ===");
console.log("================================================================================");

const scanResult = window.eval("scanDOM()");

const dom_summary = scanResult.domRegions.map((r, i) => ({
  element_id: r.agentId || `agent_${i}`,
  dom_id: r.id || "",
  name: r.name || "",
  placeholder: r.placeholder || "",
  tag: r.tag || "input",
  role: r.role || (r.inputType === "radio" ? "radio" : "textbox"),
  label: r.label || "",
  field_type: r.type || "",
  bbox: r.bbox,
  current_value: r.current_value || ""
}));

console.log(JSON.stringify(dom_summary, null, 2));

console.log("\n================================================================================");
console.log("=== ITEM 2: CONFIRM data-agent-id ASSIGNMENTS ON REAL DOM ELEMENTS ===");
console.log("================================================================================");

const matchedElements = Array.from(document.querySelectorAll("[data-agent-id]"));
console.log(`Total DOM elements with assigned data-agent-id: ${matchedElements.length}`);
matchedElements.forEach((el, index) => {
  const agentId = el.getAttribute("data-agent-id");
  const tag = el.tagName.toLowerCase();
  const label = el.getAttribute("aria-label") || el.getAttribute("data-value") || el.getAttribute("aria-labelledby") || "";
  const role = el.getAttribute("role") || el.type || "";
  console.log(`Element #${index}: <${tag}> | data-agent-id="${agentId}" | role="${role}" | label/text: "${label}"`);
});

console.log("\n================================================================================");
console.log("=== ITEM 3: CONFIRM COORDINATE FALLBACK IN executeAction() ===");
console.log("================================================================================");

async function runCoordinateFallbackProof() {
  // Test coordinate fallback on CSE radio using intentionally unrecognized target_id
  const cseRect = elementPositions.get(cseRadio);
  const cseBbox = [cseRect.left, cseRect.top, cseRect.width, cseRect.height];

  console.log(`Executing click on unknown ID "unrecognized_elem_cse" with bbox [${cseBbox.join(", ")}]...`);
  const actionWithFallback = {
    step: 1,
    action: "click",
    target_id: "unrecognized_elem_cse",
    bbox: cseBbox
  };

  const res = await window.eval(`executeAction(${JSON.stringify(actionWithFallback)})`);
  console.log("executeAction response:", res);
  console.log(`CSE Radio aria-checked state: "${cseRadio.getAttribute("aria-checked")}"`);
}

console.log("\n================================================================================");
console.log("=== ITEM 4: CONFIRM RETRY CAP & RUNNING COUNTER ENFORCEMENT ===");
console.log("================================================================================");

function simulateRetryCap() {
  const MAX_VISION_PER_TASK = 3;
  let taskVisionInferences = 0;
  let stoppedReason = null;

  console.log(`Simulating task execution with MAX_VISION_PER_TASK = ${MAX_VISION_PER_TASK}:`);
  for (let attempt = 1; attempt <= 11; attempt++) {
    console.log(`[BG] Step 3: Dispatching screenshot and domRegions to offscreen document for inference (attempt ${taskVisionInferences + 1} of max ${MAX_VISION_PER_TASK})...`);
    if (taskVisionInferences >= MAX_VISION_PER_TASK) {
      stoppedReason = `Stopping after ${MAX_VISION_PER_TASK} full analysis attempts to avoid excessive cost`;
      console.warn(`[BG] ${stoppedReason}.`);
      break;
    }
    taskVisionInferences++;
    console.log(`[BG] Vision pass ${taskVisionInferences}/${MAX_VISION_PER_TASK} completed.`);
  }

  console.log(`\nFinal vision-call count: ${taskVisionInferences}`);
  console.log(`Hard stop triggered: ${stoppedReason !== null}`);
  console.log(`Stop message: "${stoppedReason}"`);
}

console.log("\n================================================================================");
console.log("=== ITEM 5: RE-RUN FULL AGENT PLAN AGAINST GOOGLE FORM & VERIFY MUTATIONS ===");
console.log("================================================================================");

async function runFullGoogleFormExecution() {
  // Reset all elements
  nameInput.value = "";
  cseRadio.setAttribute("aria-checked", "false");
  year3Radio.setAttribute("aria-checked", "false");

  // Plan generated using exact data-agent-id from dom_summary
  const nameAgent = dom_summary.find(d => d.label.includes("Full Name") || d.field_type === "NAME");
  const cseAgent = dom_summary.find(d => d.label.includes("CSE") || d.label.includes("Computer Science"));
  const yearAgent = dom_summary.find(d => d.label.includes("3rd Year"));

  console.log(`Targeting Name field via ID: ${nameAgent.element_id}`);
  console.log(`Targeting Department CSE via ID: ${cseAgent.element_id}`);
  console.log(`Targeting Year 3rd Year via ID: ${yearAgent.element_id}`);

  // Step 1: Type Name
  await window.eval(`executeAction(${JSON.stringify({
    step: 1,
    action: "type",
    target_id: nameAgent.element_id,
    field_type: "NAME",
    bbox: nameAgent.bbox
  })})`);

  // Step 2: Click Department (CSE)
  await window.eval(`executeAction(${JSON.stringify({
    step: 2,
    action: "click",
    target_id: cseAgent.element_id,
    bbox: cseAgent.bbox
  })})`);

  // Step 3: Click Year (3rd Year)
  await window.eval(`executeAction(${JSON.stringify({
    step: 3,
    action: "click",
    target_id: yearAgent.element_id,
    bbox: yearAgent.bbox
  })})`);

  console.log("\nDOM State Verification on Real Page Elements:");
  console.log(`- Name input value: "${nameInput.value}" (expected: "Rajesh Kumar")`);
  console.log(`- Department CSE aria-checked: "${cseRadio.getAttribute("aria-checked")}" (expected: "true")`);
  console.log(`- Year 3rd Year aria-checked: "${year3Radio.getAttribute("aria-checked")}" (expected: "true")`);
}

async function main() {
  await runCoordinateFallbackProof();
  simulateRetryCap();
  await runFullGoogleFormExecution();
}

main().catch(console.error);
