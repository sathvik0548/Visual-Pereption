/**
 * vault.js — Local Profile Store
 *
 * Reads/writes user profile data exclusively to chrome.storage.local.
 * No value is ever included in a server payload — the server only receives
 * a field *type* label (e.g. "AADHAAR", "DEPARTMENT") and the client resolves
 * the real value locally here.
 */

// ── Vault field definitions (All 12 core user-requested profile fields + auxiliaries) ─
export const VAULT_FIELDS = [
  {
    key: "NAME",
    label: "Full Name",
    type: "text",
    autocomplete: "name",
    placeholder: "Rajesh Kumar",
    sensitive: false,
  },
  {
    key: "EMAIL",
    label: "Email Address",
    type: "email",
    autocomplete: "email",
    placeholder: "rajesh.kumar@example.in",
    sensitive: false,
  },
  {
    key: "PHONE",
    label: "Phone / Mobile",
    type: "tel",
    autocomplete: "tel",
    placeholder: "9876543210",
    sensitive: false,
  },
  {
    key: "AADHAAR",
    label: "Aadhaar Number",
    type: "text",
    autocomplete: "off",
    placeholder: "5489 1234 5674",
    sensitive: true,
    mask: true,
  },
  {
    key: "PAN",
    label: "PAN Card",
    type: "text",
    autocomplete: "off",
    placeholder: "ABCDE1234F",
    sensitive: true,
    transform: "uppercase",
  },
  {
    key: "GSTIN",
    label: "GSTIN",
    type: "text",
    autocomplete: "off",
    placeholder: "29ABCDE1234F1Z5",
    sensitive: true,
    transform: "uppercase",
  },
  {
    key: "IFSC",
    label: "IFSC Code",
    type: "text",
    autocomplete: "off",
    placeholder: "HDFC0001234",
    sensitive: true,
    transform: "uppercase",
  },
  {
    key: "BANK_ACCOUNT",
    label: "Bank Account",
    type: "text",
    autocomplete: "off",
    placeholder: "12345678901234",
    sensitive: true,
  },
  {
    key: "DEPARTMENT",
    label: "Department",
    type: "text",
    autocomplete: "off",
    placeholder: "CSE",
    sensitive: false,
  },
  {
    key: "YEAR",
    label: "Year of Study",
    type: "text",
    autocomplete: "off",
    placeholder: "3rd Year",
    sensitive: false,
  },
  {
    key: "ADDRESS",
    label: "Address",
    type: "text",
    autocomplete: "address-line1",
    placeholder: "42, MG Road, Bengaluru",
    sensitive: false,
  },
  {
    key: "DOB",
    label: "Date of Birth",
    type: "date",
    autocomplete: "bday",
    placeholder: "1990-05-15",
    sensitive: false,
  },
  {
    key: "CITY",
    label: "City",
    type: "text",
    autocomplete: "address-level2",
    placeholder: "Bengaluru",
    sensitive: false,
  },
  {
    key: "PINCODE",
    label: "Pincode / ZIP",
    type: "text",
    autocomplete: "postal-code",
    placeholder: "560001",
    sensitive: false,
  },
  {
    key: "PASSWORD",
    label: "Default Password",
    type: "password",
    autocomplete: "new-password",
    placeholder: "••••••••",
    sensitive: true,
  },
];

// ── Storage key ─────────────────────────────────────────────────────────────
export const STORAGE_KEY = "agent_vault";

// ── Read a single field ─────────────────────────────────────────────────────
export async function getProfileValue(fieldType) {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY], (data) => {
      const vault = data[STORAGE_KEY] ?? {};
      if (vault[fieldType]) {
        resolve(vault[fieldType]);
        return;
      }
      if (fieldType === "INDIAN_MOBILE" && vault["PHONE"]) return resolve(vault["PHONE"]);
      if (fieldType === "PHONE" && vault["INDIAN_MOBILE"]) return resolve(vault["INDIAN_MOBILE"]);
      if (fieldType === "POSTAL_CODE" && vault["PINCODE"]) return resolve(vault["PINCODE"]);
      if (fieldType === "PINCODE" && vault["POSTAL_CODE"]) return resolve(vault["POSTAL_CODE"]);
      resolve(null);
    });
  });
}

// ── Write a single field ────────────────────────────────────────────────────
export async function setProfileValue(fieldType, value) {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY], (data) => {
      const vault = data[STORAGE_KEY] ?? {};
      vault[fieldType] = value;
      chrome.storage.local.set({ [STORAGE_KEY]: vault }, resolve);
    });
  });
}

// ── Read all fields ─────────────────────────────────────────────────────────
export async function getAllProfileValues() {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY], (data) => {
      resolve(data[STORAGE_KEY] ?? {});
    });
  });
}

// ── Write all fields at once ────────────────────────────────────────────────
export async function saveAllProfileValues(valuesMap) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY]: valuesMap }, resolve);
  });
}

// ── Completeness check ──────────────────────────────────────────────────────
export async function getMissingFields() {
  const vault = await getAllProfileValues();
  return VAULT_FIELDS
    .filter(f => !vault[f.key] || vault[f.key].trim() === "")
    .map(f => f.key);
}
