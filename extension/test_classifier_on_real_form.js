import { JSDOM } from "jsdom";
import fs from "fs";

// Read content.js
const contentJsCode = fs.readFileSync("./extension/content.js", "utf-8");

// Set up JSDOM with httpbin form
const httpbinHtml = `
<!DOCTYPE html>
<html>
  <body>
  <form method="post" action="/post">
   <p><label>Customer name: <input name="custname"></label></p>
   <p><label>Telephone: <input type=tel name="custtel"></label></p>
   <p><label>E-mail address: <input type=email name="custemail"></label></p>
   <fieldset>
    <legend> Pizza Size </legend>
    <p><label> <input type=radio name=size value="small"> Small </label></p>
    <p><label> <input type=radio name=size value="medium"> Medium </label></p>
    <p><label> <input type=radio name=size value="large"> Large </label></p>
   </fieldset>
   <p><label>Preferred delivery time: <input type=time min="11:00" max="21:00" step="900" name="delivery"></label></p>
   <p><label>Delivery instructions: <textarea name="comments"></textarea></label></p>
   <p><button>Submit order</button></p>
  </form>
  </body>
</html>
`;

const dom = new JSDOM(httpbinHtml, { runScripts: "outside-only" });
const window = dom.window;
const document = window.document;

// Mock window globals and functions for scanDOM
global.window = window;
global.document = document;
window.innerWidth = 1280;
window.innerHeight = 800;
window.devicePixelRatio = 1;

// Mock chrome storage
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

// Mock getBoundingClientRect so elements appear visible
window.Element.prototype.getBoundingClientRect = function() {
  return {
    left: 50,
    top: 50,
    width: 200,
    height: 30,
    right: 250,
    bottom: 80
  };
};

// Execute content.js in this context
window.eval(contentJsCode);

// Run scanDOM
console.log("\n=== RUNNING SCANDOM ON HTTPBIN FORM ===");
const scanResult = window.eval("scanDOM()");
console.log(`Found ${scanResult.domRegions.length} classified fields:`);
scanResult.domRegions.forEach(r => {
  console.log(`- [${r.type}] (confidence: ${r.confidence}) name="${r.name}" placeholder="${r.placeholder}" inputType="${r.inputType}"`);
});

// Test executeAction with vault lookup
console.log("\n=== TESTING EXECUTE_ACTION WITH VAULT LOOKUP ===");
async function runActions() {
  try {
    for (const r of scanResult.domRegions) {
      const isRadioOrCheckbox = r.role === "radio" || r.role === "checkbox" || r.inputType === "radio" || r.inputType === "checkbox";
      const action = {
        action: isRadioOrCheckbox ? "click" : "type",
        target_id: r.agentId || (r.name ? `[name="${r.name}"]` : r.id),
        field_type: r.type,
        reasoning: isRadioOrCheckbox ? `Selecting ${r.label}` : `Filling ${r.type} from vault`
      };
      const res = await window.eval(`executeAction(${JSON.stringify(action)})`);
      console.log(`Action result for ${r.type} (${action.target_id}):`, res);
    }

    // Check form values after mutations
    console.log("\n=== FORM VALUES AFTER AGENT MUTATION ===");
    const inputs = document.querySelectorAll("input, textarea");
    inputs.forEach(i => {
      if (i.value && i.type !== "radio" && i.type !== "checkbox") {
        console.log(`✓ <${i.tagName.toLowerCase()} name="${i.name}"> value = "${i.value}"`);
      }
    });

    // Test error handling when a vault value is missing
    console.log("\n=== TESTING MISSING VAULT VALUE ERROR HANDLING ===");
    delete mockVault.DOB;
    delete mockVault.PAN;
    const missingAction = {
      action: "type",
      target_id: `[name="custname"]`,
      field_type: "PAN",
      reasoning: "Testing missing vault value"
    };
    const missingRes = await window.eval(`executeAction(${JSON.stringify(missingAction)})`);
    console.log("Missing field result:", missingRes);
  } catch (err) {
    console.error("Error in runActions stack:", err.stack || err);
  }
}

runActions();
