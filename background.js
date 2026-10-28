(() => {
  "use strict";

  const CONSENT_KEY = "vuConsent";
  const CONSENT_VERSION = "1.0.0";
  const DEFAULT_TITLE = "VU Wi-Fi Auto Login";
  const CONSENT_TITLE = "VU Wi-Fi Auto Login — accept privacy & terms";

  chrome.runtime.onInstalled.addListener(() => {
    void promptForConsent();
  });

  chrome.runtime.onStartup.addListener(() => {
    void promptForConsent();
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[CONSENT_KEY]) {
      return;
    }

    void setConsentBadge(!isConsentValid(changes[CONSENT_KEY].newValue));
  });

  // Keep the toolbar state accurate whenever the worker starts. Opening the
  // popup is intentionally limited to install/startup so a background wake
  // does not interrupt the user.
  void syncConsentBadge();

  async function syncConsentBadge() {
    const stored = await storageLocalGet(CONSENT_KEY);
    await setConsentBadge(!isConsentValid(stored[CONSENT_KEY]));
  }

  async function promptForConsent() {
    const stored = await storageLocalGet(CONSENT_KEY);
    const required = !isConsentValid(stored[CONSENT_KEY]);

    await setConsentBadge(required);

    if (required) {
      openPopupBestEffort();
    }
  }

  function openPopupBestEffort() {
    try {
      if (typeof chrome.action?.openPopup !== "function") {
        return;
      }

      const pending = chrome.action.openPopup();
      if (pending && typeof pending.catch === "function") {
        pending.catch(() => {
          // Chrome may block a programmatic popup. The badge remains.
        });
      }
    } catch {
      // The popup cannot open here; the toolbar badge is the fallback.
    }
  }

  async function setConsentBadge(required) {
    try {
      await chrome.action.setBadgeText({ text: required ? "!" : "" });

      if (required) {
        await chrome.action.setBadgeBackgroundColor({ color: "#f59e0b" });
      }

      await chrome.action.setTitle({ title: required ? CONSENT_TITLE : DEFAULT_TITLE });
    } catch {
      // Badge updates are best effort and should never break the worker.
    }
  }

  function isConsentValid(raw) {
    return Boolean(
      raw
      && typeof raw === "object"
      && raw.accepted === true
      && raw.version === CONSENT_VERSION
      && Number.isFinite(Number(raw.acceptedAt))
      && Number(raw.acceptedAt) > 0
    );
  }

  function storageLocalGet(key) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(key, (result) => {
          if (chrome.runtime.lastError) {
            resolve({});
            return;
          }
          resolve(result || {});
        });
      } catch {
        resolve({});
      }
    });
  }
})();
