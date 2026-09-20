/**
 * serverConfig.js — Shared Server Configuration Helper
 *
 * Default remote server: https://visual-pereption.onrender.com
 * Stored under key "custom_server_url" in chrome.storage.local for popup overrides.
 */

export const DEFAULT_SERVER_URL = "https://visual-pereption.onrender.com";
export const STORAGE_SERVER_KEY = "custom_server_url";

/**
 * Returns the effective base server URL (without trailing slash).
 */
export async function getBaseServerUrl() {
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
    try {
      const data = await new Promise((resolve) => {
        chrome.storage.local.get([STORAGE_SERVER_KEY], resolve);
      });
      if (data && data[STORAGE_SERVER_KEY] && typeof data[STORAGE_SERVER_KEY] === "string" && data[STORAGE_SERVER_KEY].trim()) {
        return data[STORAGE_SERVER_KEY].trim().replace(/\/+$/, "");
      }
    } catch (e) {
      console.warn("[serverConfig] Could not read custom_server_url:", e);
    }
  }
  return DEFAULT_SERVER_URL;
}

/**
 * Persists a new base server URL override (or resets to default if empty).
 */
export async function setBaseServerUrl(url) {
  const clean = (url || "").trim().replace(/\/+$/, "");
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
    if (!clean || clean === DEFAULT_SERVER_URL) {
      await new Promise((resolve) => chrome.storage.local.remove([STORAGE_SERVER_KEY], resolve));
    } else {
      await new Promise((resolve) => chrome.storage.local.set({ [STORAGE_SERVER_KEY]: clean }, resolve));
    }
  }
  return clean || DEFAULT_SERVER_URL;
}
