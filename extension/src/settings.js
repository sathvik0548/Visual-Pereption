/**
 * settings.js — Settings Page Script
 *
 * Reads/writes from chrome.storage.local under the "agent_vault" key.
 * Never touches the network.
 */

const STORAGE_KEY = "agent_vault";

// All 15 supported fields
const ALL_FIELDS = [
  "NAME", "EMAIL", "PHONE", "DEPARTMENT", "YEAR", "DOB",
  "ADDRESS", "CITY", "PINCODE",
  "AADHAAR", "PAN", "GSTIN", "IFSC", "BANK_ACCOUNT", "PASSWORD"
];

// Field labels for completeness display
const FIELD_LABELS = {
  NAME: "Full Name",
  EMAIL: "Email",
  PHONE: "Phone / Mobile",
  DEPARTMENT: "Department",
  YEAR: "Year of Study",
  DOB: "Date of Birth",
  ADDRESS: "Address",
  CITY: "City",
  PINCODE: "Pincode",
  AADHAAR: "Aadhaar",
  PAN: "PAN",
  GSTIN: "GSTIN",
  IFSC: "IFSC",
  BANK_ACCOUNT: "Bank Account",
  PASSWORD: "Password",
};

// Demo profile values for instant testing
const DEMO_PROFILE = {
  NAME: "Rajesh Kumar",
  EMAIL: "rajesh.kumar@example.in",
  PHONE: "9876543210",
  DEPARTMENT: "CSE",
  YEAR: "3rd Year",
  DOB: "1990-05-15",
  ADDRESS: "42, MG Road",
  CITY: "Bengaluru",
  PINCODE: "560001",
  AADHAAR: "5489 1234 5674",
  PAN: "ABCDE1234F",
  GSTIN: "29ABCDE1234F1Z5",
  IFSC: "HDFC0001234",
  BANK_ACCOUNT: "12345678901234",
  PASSWORD: "VaultPassword@2026"
};

// ---------------------------------------------------------------------------
// Aadhaar auto-formatter: groups digits as XXXX XXXX XXXX
// ---------------------------------------------------------------------------
function formatAadhaar(raw) {
  const digits = raw.replace(/\D/g, "").slice(0, 12);
  const parts = [];
  for (let i = 0; i < digits.length; i += 4) {
    parts.push(digits.slice(i, i + 4));
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Collect current form values from UI
// ---------------------------------------------------------------------------
function getFormValues() {
  const vault = {};
  for (const key of ALL_FIELDS) {
    const input = document.getElementById(`field-${key}`);
    if (input) {
      const val = input.value.trim();
      if (val) vault[key] = val;
    }
  }
  // Bridge common aliases
  if (vault["PHONE"] && !vault["INDIAN_MOBILE"]) vault["INDIAN_MOBILE"] = vault["PHONE"];
  if (vault["INDIAN_MOBILE"] && !vault["PHONE"]) vault["PHONE"] = vault["INDIAN_MOBILE"];
  if (vault["PINCODE"] && !vault["POSTAL_CODE"]) vault["POSTAL_CODE"] = vault["PINCODE"];
  return vault;
}

// ---------------------------------------------------------------------------
// Load saved values from chrome.storage.local
// ---------------------------------------------------------------------------
function loadVault() {
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    chrome.storage.local.get([STORAGE_KEY], (data) => {
      const vault = data?.[STORAGE_KEY] ?? {};
      for (const key of ALL_FIELDS) {
        const input = document.getElementById(`field-${key}`);
        if (input && vault[key]) {
          input.value = vault[key];
        }
      }
      updateCompleteness(vault);
      console.log("[Settings] Loaded vault with", Object.keys(vault).length, "field(s):", vault);
    });
  } else {
    // Fallback to localStorage if chrome.storage is not ready
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const vault = JSON.parse(raw);
        for (const key of ALL_FIELDS) {
          const input = document.getElementById(`field-${key}`);
          if (input && vault[key]) input.value = vault[key];
        }
        updateCompleteness(vault);
      }
    } catch (e) {}
  }
}

// ---------------------------------------------------------------------------
// Save all values to chrome.storage.local & localStorage
// ---------------------------------------------------------------------------
function saveVault(isSilent = false) {
  const vault = getFormValues();

  // Save to chrome.storage.local
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    chrome.storage.local.set({ [STORAGE_KEY]: vault }, () => {
      onSaveSuccess(vault, isSilent);
    });
  } else {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(vault));
      onSaveSuccess(vault, isSilent);
    } catch (e) {
      console.error("[Settings] Storage save error:", e);
    }
  }
}

function onSaveSuccess(vault, isSilent) {
  updateCompleteness(vault);
  
  const banner = document.getElementById("savedConfirmationBanner");
  const countSpan = document.getElementById("savedFieldsCount");
  const saveBtn = document.getElementById("saveBtn");

  if (banner) {
    banner.style.display = "flex";
    if (countSpan) countSpan.textContent = `(${Object.keys(vault).length} fields stored)`;
  }

  if (!isSilent) {
    showToast(`✓ Profile saved! (${Object.keys(vault).length} fields persisted)`, "success");
    if (saveBtn) {
      const origText = saveBtn.textContent;
      saveBtn.textContent = "✓ Saved!";
      saveBtn.style.background = "#16a34a";
      setTimeout(() => {
        saveBtn.textContent = origText;
        saveBtn.style.background = "#1a1a2e";
      }, 2000);
    }
  }

  console.log("[Settings] ✓ Successfully saved vault:", Object.keys(vault).length, "fields:", vault);
}

// ---------------------------------------------------------------------------
// Demo fill
// ---------------------------------------------------------------------------
function fillDemoValues() {
  for (const key of ALL_FIELDS) {
    const input = document.getElementById(`field-${key}`);
    if (input && DEMO_PROFILE[key]) {
      input.value = DEMO_PROFILE[key];
    }
  }
  saveVault(false);
}

// ---------------------------------------------------------------------------
// Clear all values
// ---------------------------------------------------------------------------
function clearVault() {
  if (!confirm("Clear all stored profile values? This cannot be undone.")) return;
  
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    chrome.storage.local.remove([STORAGE_KEY], () => {
      resetUI();
    });
  } else {
    localStorage.removeItem(STORAGE_KEY);
    resetUI();
  }
}

function resetUI() {
  for (const key of ALL_FIELDS) {
    const input = document.getElementById(`field-${key}`);
    if (input) input.value = "";
  }
  updateCompleteness({});
  const banner = document.getElementById("savedConfirmationBanner");
  if (banner) banner.style.display = "none";
  showToast("✗ Vault cleared", "error");
}

// ---------------------------------------------------------------------------
// Completeness bar
// ---------------------------------------------------------------------------
function updateCompleteness(vault) {
  const currentVault = vault || getFormValues();
  const filled = ALL_FIELDS.filter(k => currentVault[k] && String(currentVault[k]).trim() !== "");
  const total = ALL_FIELDS.length;
  const count = filled.length;

  const progress = document.getElementById("completenessProgress");
  const text = document.getElementById("completenessText");
  const missing = document.getElementById("missingList");

  if (progress) { progress.value = count; progress.max = total; }
  if (text) text.textContent = `${count} / ${total} fields`;

  const missingKeys = ALL_FIELDS.filter(k => !currentVault[k] || String(currentVault[k]).trim() === "");
  if (missing) {
    if (missingKeys.length === 0) {
      missing.textContent = "✓ All fields complete — agent will automatically fill any form field.";
      missing.style.color = "#16a34a";
    } else {
      missing.textContent = `Missing: ${missingKeys.map(k => FIELD_LABELS[k] || k).join(", ")}`;
      missing.style.color = "#94a3b8";
    }
  }
}

// ---------------------------------------------------------------------------
// Toast notification
// ---------------------------------------------------------------------------
function showToast(message, type = "success") {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.textContent = message;
  toast.className = type;
  toast.style.display = "block";
  setTimeout(() => { toast.style.display = "none"; }, 3500);
}

// ---------------------------------------------------------------------------
// Attach live input listeners for instant feedback & auto-save
// ---------------------------------------------------------------------------
let autoSaveTimer = null;

ALL_FIELDS.forEach((key) => {
  const input = document.getElementById(`field-${key}`);
  if (input) {
    input.addEventListener("input", (e) => {
      if (key === "AADHAAR") {
        e.target.value = formatAadhaar(e.target.value);
      } else if (["PAN", "GSTIN", "IFSC"].includes(key)) {
        e.target.value = e.target.value.toUpperCase();
      }
      // Live completeness update as user types
      updateCompleteness(getFormValues());

      // Debounced auto-save
      clearTimeout(autoSaveTimer);
      autoSaveTimer = setTimeout(() => {
        saveVault(true); // silent auto-save
      }, 800);
    });

    input.addEventListener("blur", () => {
      saveVault(true);
    });
  }
});

document.getElementById("saveBtn")?.addEventListener("click", () => saveVault(false));
document.getElementById("demoBtn")?.addEventListener("click", fillDemoValues);
document.getElementById("clearBtn")?.addEventListener("click", clearVault);

// Run load immediately
loadVault();

// Also run on DOMContentLoaded or window load in case DOM was parsing
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", loadVault);
}
