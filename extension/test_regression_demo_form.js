import { JSDOM } from "jsdom";
import fs from "fs";

const contentJsCode = fs.readFileSync("./extension/content.js", "utf-8");
const demoHtml = fs.readFileSync("./server/demo/vendor-registration.html", "utf-8");

const dom = new JSDOM(demoHtml, { runScripts: "outside-only" });
const window = dom.window;
const document = window.document;

global.window = window;
global.document = document;
window.innerWidth = 1280;
window.innerHeight = 800;
window.devicePixelRatio = 1;

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

window.Element.prototype.getBoundingClientRect = function() {
  return { left: 50, top: 50, width: 200, height: 30, right: 250, bottom: 80 };
};

window.eval(contentJsCode);

console.log("\n=== RUNNING SCANDOM ON VENDOR REGISTRATION DEMO ===");
const scanResult = window.eval("scanDOM()");
console.log(`Found ${scanResult.domRegions.length} sensitive/classified fields:`);
const foundTypes = new Set();
scanResult.domRegions.forEach(r => {
  foundTypes.add(r.type);
  console.log(`- [${r.type}] (conf: ${r.confidence}) id="${r.id}" name="${r.name}"`);
});

const expectedTypes = ["NAME", "EMAIL", "INDIAN_MOBILE", "PASSWORD", "AADHAAR", "PAN", "GSTIN", "IFSC", "CARD"];
console.log("\nVerifying detected types:");
expectedTypes.forEach(t => {
  const ok = foundTypes.has(t);
  console.log(`  ${ok ? "✓" : "✗"} ${t}`);
});

console.log("\n=== ALL REGRESSION CHECKS COMPLETE ===");
