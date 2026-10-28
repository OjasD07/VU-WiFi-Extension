(() => {
  "use strict";

  const SETTINGS_KEY = "vuSettings";
  const STATUS_KEY = "vuLastStatus";
  const CONSENT_KEY = "vuConsent";
  const CONSENT_VERSION = "1.0.0";
  const WITHDRAW_CONFIRM_MS = 4000;

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    username: "vu2student",
    password: "vu2student",
    autoAcceptTerms: true
  });

  const DEFAULT_STATUS = Object.freeze({
    message: "Waiting for portal",
    tone: "idle",
    kind: "idle",
    timestamp: 0,
    portal: false,
    keepalive: false,
    url: ""
  });

  let settings = { ...DEFAULT_SETTINGS };
  let currentStatus = { ...DEFAULT_STATUS };
  let consent = normalizeConsent(null);
  let hasStoredSettings = false;
  let activeTab = null;
  let saveButtonTimer = 0;
  let triggerButtonTimer = 0;
  let clockTimer = 0;
  let withdrawTimer = 0;
  let withdrawArmed = false;
  let consentBusy = false;
  let consentViewOpen = false;

  const elements = {};

  document.addEventListener("DOMContentLoaded", init, { once: true });

  async function init() {
    cacheElements();
    bindEvents();

    elements.copyrightYear.textContent = String(new Date().getFullYear());

    const stored = await storageGet([SETTINGS_KEY, STATUS_KEY, CONSENT_KEY]);
    const storedHasSettings = Boolean(stored[SETTINGS_KEY] && typeof stored[SETTINGS_KEY] === "object");

    settings = normalizeSettings(stored[SETTINGS_KEY]);
    currentStatus = normalizeStatus(stored[STATUS_KEY]);
    consent = normalizeConsent(stored[CONSENT_KEY]);
    hasStoredSettings = storedHasSettings;

    renderSettings();
    renderStatus();
    renderConsent();

    if (!hasStoredSettings && consent.accepted) {
      await ensureDefaultSettings();
    }

    await refreshActiveTab();

    chrome.storage.onChanged.addListener(handleStorageChange);
    chrome.runtime.onMessage.addListener(handleRuntimeMessage);

    clockTimer = window.setInterval(updateTimeLabel, 30000);
    window.addEventListener("unload", () => {
      window.clearInterval(clockTimer);
      window.clearTimeout(withdrawTimer);
    }, { once: true });
  }

  function cacheElements() {
    elements.form = document.getElementById("credentialsForm");
    elements.enableToggle = document.getElementById("enableToggle");
    elements.username = document.getElementById("username");
    elements.password = document.getElementById("password");
    elements.togglePassword = document.getElementById("togglePassword");
    elements.autoAccept = document.getElementById("autoAccept");
    elements.saveButton = document.getElementById("saveButton");
    elements.saveButtonLabel = elements.saveButton.querySelector("span:last-child");
    elements.formMessage = document.getElementById("formMessage");
    elements.connectionBadge = document.getElementById("connectionBadge");
    elements.badgeText = document.getElementById("badgeText");
    elements.dashboard = document.getElementById("dashboard");
    elements.consentView = document.getElementById("consentView");
    elements.consentKicker = document.getElementById("consentKicker");
    elements.consentHeading = document.getElementById("consentHeading");
    elements.consentIntro = document.getElementById("consentIntro");
    elements.consentForm = document.getElementById("consentForm");
    elements.consentCheck = document.getElementById("consentCheck");
    elements.consentAccept = document.getElementById("consentAccept");
    elements.consentNotNow = document.getElementById("consentNotNow");
    elements.consentReview = document.getElementById("consentReview");
    elements.consentAcceptedText = document.getElementById("consentAcceptedText");
    elements.consentBack = document.getElementById("consentBack");
    elements.consentWithdraw = document.getElementById("consentWithdraw");
    elements.consentMessage = document.getElementById("consentMessage");
    elements.openConsent = document.getElementById("openConsent");
    elements.statusReadout = document.getElementById("statusReadout");
    elements.statusText = document.getElementById("statusText");
    elements.lastUpdated = document.getElementById("lastUpdated");
    elements.triggerButton = document.getElementById("triggerButton");
    elements.triggerLabel = elements.triggerButton.querySelector(".trigger-label");
    elements.eyeOn = elements.togglePassword.querySelector(".icon-eye");
    elements.eyeOff = elements.togglePassword.querySelector(".icon-eye-off");
    elements.copyrightYear = document.getElementById("copyrightYear");
  }

  function bindEvents() {
    elements.form.addEventListener("submit", (event) => {
      event.preventDefault();
      void saveCredentials();
    });

    elements.enableToggle.addEventListener("change", () => {
      void persistToggle("enabled", elements.enableToggle.checked);
    });

    elements.autoAccept.addEventListener("change", () => {
      void persistToggle("autoAcceptTerms", elements.autoAccept.checked);
    });

    elements.togglePassword.addEventListener("click", togglePasswordVisibility);
    elements.triggerButton.addEventListener("click", () => void triggerLogin());
    elements.consentForm.addEventListener("submit", (event) => {
      event.preventDefault();
      void acceptConsent();
    });
    elements.consentCheck.addEventListener("change", () => {
      clearConsentMessage();
      syncConsentAcceptState();
    });
    elements.consentNotNow.addEventListener("click", closePopup);
    elements.consentBack.addEventListener("click", backToDashboard);
    elements.consentWithdraw.addEventListener("click", () => void withdrawConsent());
    elements.openConsent.addEventListener("click", openConsentReview);
  }

  async function saveCredentials() {
    const username = elements.username.value.trim();
    const password = elements.password.value;

    clearFormMessage();

    if (!consent.accepted) {
      showFormMessage("Accept the privacy & terms before saving credentials.", "error");
      return;
    }

    if (!username || !password) {
      showFormMessage("Enter both a username and password.", "error");
      return;
    }

    const nextSettings = normalizeSettings({
      ...settings,
      enabled: elements.enableToggle.checked,
      username,
      password,
      autoAcceptTerms: elements.autoAccept.checked
    });

    const saved = await storageSet({ [SETTINGS_KEY]: nextSettings });

    if (!saved) {
      showFormMessage("Could not save. Reload the extension and try again.", "error");
      return;
    }

    settings = nextSettings;
    elements.username.value = settings.username;
    elements.password.value = settings.password;

    showSavedButton("Saved!");
    showFormMessage("Credentials saved locally.", "success");
  }

  async function persistToggle(key, value) {
    if (!consent.accepted) {
      renderConsent();
      showFormMessage("Accept the privacy & terms first.", "error");
      return;
    }

    const nextSettings = normalizeSettings({ ...settings, [key]: value });
    settings = nextSettings;

    const saved = await storageSet({ [SETTINGS_KEY]: settings });
    if (!saved) {
      showFormMessage("Could not save this setting.", "error");
    } else {
      showFormMessage(key === "enabled"
        ? (value ? "Automation enabled." : "Automation paused.")
        : (value ? "Terms will be accepted automatically." : "Terms acceptance is manual."), "success");
    }
  }

  function togglePasswordVisibility() {
    const showing = elements.password.type === "text";
    const nextType = showing ? "password" : "text";

    elements.password.type = nextType;
    elements.togglePassword.setAttribute("aria-pressed", String(!showing));
    elements.togglePassword.setAttribute("aria-label", showing ? "Show password" : "Hide password");
    elements.eyeOn.hidden = !showing;
    elements.eyeOff.hidden = showing;
    elements.password.focus({ preventScroll: true });
    elements.password.setSelectionRange(elements.password.value.length, elements.password.value.length);
  }

  function showSavedButton(label) {
    window.clearTimeout(saveButtonTimer);
    elements.saveButton.classList.remove("is-error");
    elements.saveButton.classList.add("is-saved");
    elements.saveButton.setAttribute("aria-live", "polite");
    elements.saveButtonLabel.textContent = label;

    saveButtonTimer = window.setTimeout(() => {
      elements.saveButton.classList.remove("is-saved");
      elements.saveButtonLabel.textContent = "Save credentials";
    }, 1700);
  }

  function showFormMessage(message, tone) {
    elements.formMessage.textContent = message;
    elements.formMessage.classList.toggle("is-success", tone === "success");
    elements.formMessage.classList.toggle("is-warning", tone === "warning");
  }

  function clearFormMessage() {
    elements.formMessage.textContent = "";
    elements.formMessage.classList.remove("is-success", "is-warning");
    elements.saveButton.classList.remove("is-error");
  }

  function renderSettings() {
    elements.enableToggle.checked = settings.enabled;
    elements.username.value = settings.username;
    elements.password.value = settings.password;
    elements.autoAccept.checked = settings.autoAcceptTerms;
  }

  function renderConsent() {
    const locked = !consent.accepted;
    const reviewing = consent.accepted && consentViewOpen;
    const visible = locked || reviewing;

    document.body.classList.toggle("is-consent-locked", locked);
    document.body.classList.toggle("is-consent-view", visible);

    elements.consentView.hidden = !visible;
    elements.dashboard.hidden = visible;
    elements.consentForm.hidden = reviewing;
    elements.consentReview.hidden = !reviewing;
    resetWithdrawButton();

    if (reviewing) {
      elements.consentKicker.textContent = "Privacy & terms";
      elements.consentHeading.textContent = "Your agreement";
      elements.consentIntro.textContent = "Withdrawing pauses automation. Saved credentials stay on this device.";
      elements.consentAcceptedText.textContent = formatAcceptedConsent(consent);
    } else if (consent.outdated) {
      elements.consentKicker.textContent = "Action needed";
      elements.consentHeading.textContent = "Terms updated";
      elements.consentIntro.textContent = "The summary changed. Agree again to keep automation active.";
      elements.consentCheck.checked = false;
      syncConsentAcceptState();
    } else {
      elements.consentKicker.textContent = "Before you start";
      elements.consentHeading.textContent = "A quick agreement";
      elements.consentIntro.textContent = "Automation stays paused until you agree.";
      elements.consentCheck.checked = false;
      syncConsentAcceptState();
    }

    elements.enableToggle.disabled = locked;
    elements.username.disabled = locked;
    elements.password.disabled = locked;
    elements.togglePassword.disabled = locked;
    elements.autoAccept.disabled = locked;
    elements.saveButton.disabled = locked;

    syncTriggerButtonState();
  }

  function openConsentReview() {
    if (!consent.accepted) return;

    consentViewOpen = true;
    clearConsentMessage();
    renderConsent();
    elements.consentHeading.focus({ preventScroll: true });
  }

  function backToDashboard() {
    if (!consent.accepted) return;

    consentViewOpen = false;
    clearConsentMessage();
    renderConsent();
    elements.openConsent.focus({ preventScroll: true });
  }

  function closePopup() {
    try {
      window.close();
    } catch {
      // The popup can only be closed by Chrome; leaving it open is harmless.
    }
  }

  async function acceptConsent() {
    if (consentBusy || !elements.consentCheck.checked) {
      return;
    }

    const payload = {
      accepted: true,
      version: CONSENT_VERSION,
      acceptedAt: Date.now()
    };

    clearConsentMessage();
    setConsentBusy(true);

    const saved = await storageSet({ [CONSENT_KEY]: payload });
    setConsentBusy(false);

    if (!saved) {
      showConsentMessage("Could not save your acceptance. Try again.", "error");
      return;
    }

    consent = normalizeConsent(payload);
    consentViewOpen = false;
    renderConsent();

    await ensureDefaultSettings();
    showFormMessage("Agreement saved. Automation is ready.", "success");
    void refreshActiveTab();
  }

  async function withdrawConsent() {
    if (!consent.accepted || consentBusy) {
      return;
    }

    if (!withdrawArmed) {
      withdrawArmed = true;
      elements.consentWithdraw.textContent = "Click again to confirm";
      elements.consentWithdraw.classList.add("is-confirming");
      showConsentMessage("Withdrawing pauses automation. Click again to confirm.", "warning");

      window.clearTimeout(withdrawTimer);
      withdrawTimer = window.setTimeout(cancelWithdrawConfirmation, WITHDRAW_CONFIRM_MS);
      return;
    }

    window.clearTimeout(withdrawTimer);
    withdrawArmed = false;
    elements.consentWithdraw.disabled = true;

    const removed = await storageRemove(CONSENT_KEY);
    elements.consentWithdraw.disabled = false;

    if (!removed) {
      resetWithdrawButton();
      showConsentMessage("Could not withdraw consent. Try again.", "error");
      return;
    }

    consent = normalizeConsent(null);
    consentViewOpen = false;
    resetWithdrawButton();
    renderConsent();
    showConsentMessage("Consent withdrawn. Automation is paused.", "warning");
    elements.consentCheck.focus({ preventScroll: true });
  }

  function resetWithdrawButton() {
    window.clearTimeout(withdrawTimer);
    withdrawTimer = 0;
    withdrawArmed = false;

    if (!elements.consentWithdraw) {
      return;
    }

    elements.consentWithdraw.textContent = "Withdraw consent";
    elements.consentWithdraw.classList.remove("is-confirming");
  }

  function cancelWithdrawConfirmation() {
    resetWithdrawButton();

    if (consent.accepted) {
      clearConsentMessage();
    }
  }

  function setConsentBusy(value) {
    consentBusy = value;
    elements.consentAccept.textContent = value ? "Saving…" : "I agree";
    elements.consentAccept.setAttribute("aria-busy", String(value));
    elements.consentCheck.disabled = value;
    elements.consentNotNow.disabled = value;
    syncConsentAcceptState();
  }

  function syncConsentAcceptState() {
    elements.consentAccept.disabled = consentBusy || !elements.consentCheck.checked;
  }

  function showConsentMessage(message, tone) {
    elements.consentMessage.textContent = message;
    elements.consentMessage.classList.toggle("is-success", tone === "success");
    elements.consentMessage.classList.toggle("is-warning", tone === "warning");
  }

  function clearConsentMessage() {
    elements.consentMessage.textContent = "";
    elements.consentMessage.classList.remove("is-success", "is-warning");
  }

  function formatAcceptedConsent(record) {
    const version = record.version || CONSENT_VERSION;
    const date = new Date(Number(record.acceptedAt));

    if (Number.isNaN(date.getTime())) {
      return `Accepted · v${version}`;
    }

    return `Accepted ${date.toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric"
    })} · v${version}`;
  }

  function syncTriggerButtonState() {
    const loading = elements.triggerButton.classList.contains("is-loading");
    elements.triggerButton.disabled = loading || !consent.accepted;
  }

  function renderStatus() {
    const status = normalizeStatus(currentStatus);
    const tone = status.tone;

    elements.statusText.textContent = status.message || DEFAULT_STATUS.message;
    elements.statusReadout.classList.remove("is-success", "is-active", "is-warning");

    if (tone === "success" || tone === "active" || tone === "warning") {
      elements.statusReadout.classList.add(`is-${tone}`);
    }

    updateTimeLabel();
  }

  function updateTimeLabel() {
    if (!currentStatus.timestamp) {
      elements.lastUpdated.textContent = "No activity";
      elements.lastUpdated.removeAttribute("title");
      return;
    }

    elements.lastUpdated.textContent = relativeTime(currentStatus.timestamp);
    elements.lastUpdated.title = new Date(currentStatus.timestamp).toLocaleString();
  }

  async function refreshActiveTab() {
    activeTab = await queryActiveTab();
    const url = activeTab?.url || activeTab?.pendingUrl || "";
    let pageState = null;

    if (activeTab?.id && isWebUrl(url)) {
      pageState = await sendTabMessage(activeTab.id, { type: "VU_GET_PAGE_STATE" });
    }

    const portalByHost = isPortalHost(url);
    const keepaliveByUrl = /keepalive/i.test(url);
    const portal = Boolean(pageState?.portal || portalByHost);
    const keepalive = Boolean(pageState?.keepalive || (portal && keepaliveByUrl));

    setConnectionState(portal, keepalive);
  }

  function setConnectionState(portal, keepalive) {
    const badge = elements.connectionBadge;
    badge.classList.remove("is-idle", "is-warning", "is-active");

    if (portal) {
      badge.classList.add("is-active");
      elements.badgeText.textContent = keepalive ? "Keepalive active" : "Connected";
      badge.setAttribute("aria-label", keepalive
        ? "Connected. Keepalive is active."
        : "Connected to the captive portal.");
      badge.title = keepalive ? "Keepalive is active" : "Captive portal detected";
    } else {
      badge.classList.add("is-idle");
      elements.badgeText.textContent = "Idle / standby";
      badge.setAttribute("aria-label", "Idle. On standby.");
      badge.title = "No captive portal detected in the active tab";
    }
  }

  async function triggerLogin() {
    if (elements.triggerButton.disabled) return;

    if (!consent.accepted) {
      renderConsent();
      showFormMessage("Accept the privacy & terms before triggering automation.", "error");
      return;
    }

    window.clearTimeout(triggerButtonTimer);
    setTriggerLoading(true);
    clearFormMessage();

    try {
      activeTab = await queryActiveTab();

      if (!activeTab?.id) {
        throw new Error("No active tab available.");
      }

      const url = activeTab.url || activeTab.pendingUrl || "";
      if (url && !isWebUrl(url)) {
        throw new Error("Open the Wi-Fi portal in a normal web tab first.");
      }

      let response = await sendTabMessage(activeTab.id, { type: "VU_TRIGGER_LOGIN" });

      if (!response) {
        await injectContentScript(activeTab.id);
        await wait(180);
        response = await sendTabMessage(activeTab.id, { type: "VU_TRIGGER_LOGIN" });
      }

      if (!response) {
        throw new Error("The page did not respond. Reload it and try again.");
      }

      if (response.status) {
        currentStatus = normalizeStatus(response.status);
        renderStatus();
      } else if (response.message) {
        currentStatus = normalizeStatus({
          ...currentStatus,
          message: response.message,
          tone: response.ok ? "active" : "warning",
          kind: "manual",
          timestamp: Date.now(),
          url
        });
        renderStatus();
      }

      await refreshActiveTab();

      if (response.ok) {
        showTriggerSuccess(response.executed === false ? "No action needed" : "Triggered");
      } else {
        showTriggerError("Trigger failed");
      }
    } catch (error) {
      const message = friendlyError(error);
      currentStatus = normalizeStatus({
        ...currentStatus,
        message,
        tone: "warning",
        kind: "manual",
        timestamp: Date.now()
      });
      renderStatus();
      showTriggerError("Could not trigger");
    } finally {
      setTriggerLoading(false);
    }
  }

  function setTriggerLoading(loading) {
    elements.triggerButton.classList.toggle("is-loading", loading);
    syncTriggerButtonState();
    if (loading) {
      elements.triggerButton.classList.remove("is-feedback");
      elements.triggerLabel.textContent = "Triggering…";
    } else if (!elements.triggerButton.classList.contains("is-feedback")) {
      elements.triggerLabel.textContent = "Trigger login now";
    }
  }

  function showTriggerSuccess(label) {
    window.clearTimeout(triggerButtonTimer);
    elements.triggerButton.classList.add("is-feedback");
    elements.triggerLabel.textContent = label;
    triggerButtonTimer = window.setTimeout(() => {
      elements.triggerButton.classList.remove("is-feedback");
      elements.triggerLabel.textContent = "Trigger login now";
    }, 1600);
  }

  function showTriggerError(label) {
    window.clearTimeout(triggerButtonTimer);
    elements.triggerButton.classList.add("is-feedback");
    elements.triggerLabel.textContent = label;
    triggerButtonTimer = window.setTimeout(() => {
      elements.triggerButton.classList.remove("is-feedback");
      elements.triggerLabel.textContent = "Trigger login now";
    }, 2200);
  }

  async function injectContentScript(tabId) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"]
      });
    } catch (error) {
      throw new Error("Chrome cannot run automation on this page.");
    }
  }

  function handleStorageChange(changes, areaName) {
    if (areaName !== "local") return;

    if (changes[CONSENT_KEY]) {
      const wasAccepted = consent.accepted;
      consent = normalizeConsent(changes[CONSENT_KEY].newValue);
      consentViewOpen = false;
      renderConsent();

      if (!wasAccepted && consent.accepted) {
        void ensureDefaultSettings();
        showFormMessage("Privacy & terms accepted. Automation is ready.", "success");
        void refreshActiveTab();
      } else if (wasAccepted && !consent.accepted) {
        showConsentMessage("Consent withdrawn. Automation is paused.", "warning");
      }
    }

    if (changes[STATUS_KEY]?.newValue) {
      currentStatus = normalizeStatus(changes[STATUS_KEY].newValue);
      renderStatus();
    }

    if (changes[SETTINGS_KEY]?.newValue) {
      hasStoredSettings = true;
      settings = normalizeSettings(changes[SETTINGS_KEY].newValue);
      elements.enableToggle.checked = settings.enabled;
      elements.autoAccept.checked = settings.autoAcceptTerms;
    }
  }

  async function ensureDefaultSettings() {
    if (hasStoredSettings) return;
    hasStoredSettings = await storageSet({ [SETTINGS_KEY]: settings });
  }

  function handleRuntimeMessage(message) {
    if (message?.type !== "VU_STATUS_UPDATE" || !message.status) return;

    currentStatus = normalizeStatus(message.status);
    renderStatus();
  }

  function normalizeSettings(raw) {
    if (!raw || typeof raw !== "object") {
      return { ...DEFAULT_SETTINGS };
    }

    return {
      enabled: raw.enabled !== false,
      username: typeof raw.username === "string" && raw.username.trim()
        ? raw.username.trim()
        : DEFAULT_SETTINGS.username,
      password: typeof raw.password === "string" && raw.password.length
        ? raw.password
        : DEFAULT_SETTINGS.password,
      autoAcceptTerms: raw.autoAcceptTerms !== false
    };
  }

  function normalizeConsent(raw) {
    const acceptedFlag = Boolean(raw && typeof raw === "object" && raw.accepted === true);

    return {
      accepted: isConsentValid(raw),
      outdated: acceptedFlag && !isConsentValid(raw),
      version: raw && typeof raw === "object" && typeof raw.version === "string" ? raw.version : "",
      acceptedAt: raw && typeof raw === "object" && Number.isFinite(Number(raw.acceptedAt))
        ? Number(raw.acceptedAt)
        : 0
    };
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

  function normalizeStatus(raw) {
    if (!raw || typeof raw !== "object") {
      return { ...DEFAULT_STATUS };
    }

    const allowedTones = new Set(["idle", "active", "success", "warning"]);
    const tone = allowedTones.has(raw.tone) ? raw.tone : "idle";
    const timestamp = Number(raw.timestamp);

    return {
      message: typeof raw.message === "string" && raw.message.trim()
        ? raw.message.trim().slice(0, 180)
        : DEFAULT_STATUS.message,
      tone,
      kind: typeof raw.kind === "string" ? raw.kind.slice(0, 32) : "idle",
      timestamp: Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0,
      portal: raw.portal === true,
      keepalive: raw.keepalive === true,
      url: typeof raw.url === "string" ? raw.url.slice(0, 2048) : ""
    };
  }

  function relativeTime(timestamp) {
    const elapsed = Math.max(0, Date.now() - timestamp);

    if (elapsed < 45000) return "Just now";
    if (elapsed < 3600000) return `${Math.floor(elapsed / 60000)}m ago`;
    if (elapsed < 86400000) return `${Math.floor(elapsed / 3600000)}h ago`;
    if (elapsed < 604800000) return `${Math.floor(elapsed / 86400000)}d ago`;

    return new Date(timestamp).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric"
    });
  }

  function isWebUrl(value) {
    return typeof value === "string" && /^https?:\/\//i.test(value);
  }

  function isPortalHost(value) {
    if (!isWebUrl(value)) return false;

    try {
      return new URL(value).hostname === "10.25.0.1";
    } catch {
      return false;
    }
  }

  function friendlyError(error) {
    const message = error instanceof Error ? error.message : "";

    if (/cannot access|chrome:\/\/|chrome-extension:\/\/|edge:\/\/|about:/i.test(message)) {
      return "Open the Wi-Fi portal in a normal web tab first.";
    }

    return message || "Could not reach the automation script.";
  }

  function queryActiveTab() {
    return new Promise((resolve) => {
      try {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          resolve(tabs?.[0] || null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  function sendTabMessage(tabId, message) {
    return new Promise((resolve) => {
      try {
        chrome.tabs.sendMessage(tabId, message, (response) => {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          resolve(response || null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  function storageGet(keys) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(keys, (result) => {
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

  function storageSet(value) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set(value, () => {
          if (chrome.runtime.lastError) {
            resolve(false);
            return;
          }
          resolve(true);
        });
      } catch {
        resolve(false);
      }
    });
  }

  function storageRemove(key) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.remove(key, () => {
          if (chrome.runtime.lastError) {
            resolve(false);
            return;
          }
          resolve(true);
        });
      } catch {
        resolve(false);
      }
    });
  }

  function wait(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }
})();
