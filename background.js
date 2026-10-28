(() => {
  "use strict";

  const CONSENT_KEY = "vuConsent";
  const CONSENT_VERSION = "1.0.0";
  const CONSENT_TAB_KEY = "vuConsentTabId";
  const CONSENT_PAGE_PATH = "privacy.html?source=startup";

  let fallbackConsentTabId = 0;

  chrome.runtime.onInstalled.addListener(() => {
    void ensureConsentPage();
  });

  chrome.runtime.onStartup.addListener(() => {
    void ensureConsentPage();
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    void forgetConsentTab(tabId);
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[CONSENT_KEY]) {
      return;
    }

    if (isConsentValid(changes[CONSENT_KEY].newValue)) {
      void setConsentTabId(0);
    }
  });

  async function ensureConsentPage() {
    const stored = await storageLocalGet(CONSENT_KEY);

    if (isConsentValid(stored[CONSENT_KEY])) {
      await setConsentTabId(0);
      return;
    }

    await openConsentPage();
  }

  async function openConsentPage() {
    const existingTab = await getConsentTab();

    if (existingTab && await focusTab(existingTab)) {
      return;
    }

    await setConsentTabId(0);

    const tab = await createTab(chrome.runtime.getURL(CONSENT_PAGE_PATH));
    if (tab?.id != null) {
      await setConsentTabId(tab.id);
    }
  }

  async function getConsentTab() {
    const tabId = await getConsentTabId();
    return tabId ? await getTab(tabId) : null;
  }

  async function getConsentTabId() {
    const stored = await storageSessionGet(CONSENT_TAB_KEY);
    const value = Number(stored[CONSENT_TAB_KEY]);

    if (Number.isInteger(value) && value > 0) {
      return value;
    }

    return fallbackConsentTabId;
  }

  async function setConsentTabId(tabId) {
    const value = Number(tabId);
    fallbackConsentTabId = Number.isInteger(value) && value > 0 ? value : 0;

    if (fallbackConsentTabId) {
      await storageSessionSet({ [CONSENT_TAB_KEY]: fallbackConsentTabId });
    } else {
      await storageSessionRemove(CONSENT_TAB_KEY);
    }
  }

  async function forgetConsentTab(tabId) {
    const trackedTabId = await getConsentTabId();
    if (trackedTabId === tabId) {
      await setConsentTabId(0);
    }
  }

  async function focusTab(tab) {
    if (!tab || tab.id == null) {
      return false;
    }

    const updated = await updateTab(tab.id, { active: true });
    if (!updated) {
      return false;
    }

    if (typeof tab.windowId === "number") {
      await focusWindow(tab.windowId);
    }

    return true;
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

  function storageSessionGet(key) {
    return new Promise((resolve) => {
      try {
        if (!chrome.storage.session) {
          resolve({});
          return;
        }

        chrome.storage.session.get(key, (result) => {
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

  function storageSessionSet(value) {
    return new Promise((resolve) => {
      try {
        if (!chrome.storage.session) {
          resolve(false);
          return;
        }

        chrome.storage.session.set(value, () => {
          resolve(!chrome.runtime.lastError);
        });
      } catch {
        resolve(false);
      }
    });
  }

  function storageSessionRemove(key) {
    return new Promise((resolve) => {
      try {
        if (!chrome.storage.session) {
          resolve(false);
          return;
        }

        chrome.storage.session.remove(key, () => {
          resolve(!chrome.runtime.lastError);
        });
      } catch {
        resolve(false);
      }
    });
  }

  function getTab(tabId) {
    return new Promise((resolve) => {
      try {
        chrome.tabs.get(tabId, (tab) => {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          resolve(tab || null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  function createTab(url) {
    return new Promise((resolve) => {
      try {
        chrome.tabs.create({ url, active: true }, (tab) => {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          resolve(tab || null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  function updateTab(tabId, properties) {
    return new Promise((resolve) => {
      try {
        chrome.tabs.update(tabId, properties, () => {
          resolve(!chrome.runtime.lastError);
        });
      } catch {
        resolve(false);
      }
    });
  }

  function focusWindow(windowId) {
    return new Promise((resolve) => {
      try {
        chrome.windows.update(windowId, { focused: true }, () => {
          resolve(!chrome.runtime.lastError);
        });
      } catch {
        resolve(false);
      }
    });
  }
})();
