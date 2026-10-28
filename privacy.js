(() => {
  "use strict";

  const CONSENT_KEY = "vuConsent";
  const CONSENT_VERSION = "1.0.0";
  const WITHDRAW_CONFIRM_MS = 4000;

  const elements = {};
  const startupSource = new URLSearchParams(window.location.search).get("source") === "startup";

  let consentRecord = null;
  let withdrawArmed = false;
  let withdrawTimer = 0;
  let busy = false;

  document.addEventListener("DOMContentLoaded", init, { once: true });

  async function init() {
    cacheElements();
    bindEvents();

    elements.copyrightYear.textContent = String(new Date().getFullYear());
    elements.acceptedVersion.textContent = CONSENT_VERSION;

    const stored = await storageGet(CONSENT_KEY);
    consentRecord = stored[CONSENT_KEY] ?? null;
    renderConsent();
  }

  function cacheElements() {
    elements.statusPill = document.getElementById("consentStatus");
    elements.statusText = document.getElementById("consentStatusText");
    elements.intro = document.getElementById("consentIntro");
    elements.notice = document.getElementById("consentNotice");
    elements.form = document.getElementById("consentForm");
    elements.agreeCheck = document.getElementById("agreeCheck");
    elements.agreeButton = document.getElementById("agreeButton");
    elements.agreeLabel = elements.agreeButton.querySelector(".agree-label");
    elements.declineButton = document.getElementById("declineButton");
    elements.acceptedPanel = document.getElementById("acceptedPanel");
    elements.acceptedDate = document.getElementById("acceptedDate");
    elements.acceptedVersion = document.getElementById("acceptedVersion");
    elements.closeButton = document.getElementById("closeButton");
    elements.withdrawButton = document.getElementById("withdrawButton");
    elements.message = document.getElementById("consentMessage");
    elements.copyrightYear = document.getElementById("copyrightYear");
  }

  function bindEvents() {
    elements.form.addEventListener("submit", (event) => {
      event.preventDefault();
      void acceptConsent();
    });

    elements.agreeCheck.addEventListener("change", () => {
      showMessage("", "");
      syncAgreeButton();
    });

    elements.declineButton.addEventListener("click", declineConsent);
    elements.withdrawButton.addEventListener("click", () => void withdrawConsent());
    elements.closeButton.addEventListener("click", closeCurrentTab);

    chrome.storage.onChanged.addListener(handleStorageChange);
    window.addEventListener("pagehide", () => window.clearTimeout(withdrawTimer), { once: true });
  }

  function renderConsent() {
    const valid = isConsentValid(consentRecord);
    const wasAccepted = Boolean(consentRecord && consentRecord.accepted === true);
    const outdated = wasAccepted && !valid;

    elements.form.hidden = valid;
    elements.acceptedPanel.hidden = !valid;

    elements.statusPill.classList.toggle("is-accepted", valid);
    elements.statusPill.classList.toggle("is-required", !valid);
    elements.statusText.textContent = valid
      ? "Agreement accepted"
      : outdated
        ? "Agreement updated"
        : "Agreement required";

    elements.intro.textContent = valid
      ? "You have accepted the current privacy policy and terms of use. You can withdraw consent at any time."
      : outdated
        ? "The privacy policy or terms have changed. Please review and accept the current version to keep automation active."
        : "Automation is paused until you review and accept the privacy policy and terms of use.";

    if (valid) {
      elements.acceptedDate.textContent = formatDate(consentRecord.acceptedAt);
      elements.acceptedVersion.textContent = consentRecord.version || CONSENT_VERSION;
      elements.notice.hidden = true;
      resetWithdrawButton();
      return;
    }

    elements.agreeCheck.checked = false;
    syncAgreeButton();

    if (outdated) {
      showNotice("The privacy policy or terms have been updated since your last acceptance. Please review and agree again.");
    } else if (startupSource) {
      showNotice("This page opened automatically because automation needs your consent before it can run.");
    } else {
      elements.notice.hidden = true;
    }

    resetWithdrawButton();
  }

  async function acceptConsent() {
    if (busy || !elements.agreeCheck.checked) {
      return;
    }

    const payload = {
      accepted: true,
      version: CONSENT_VERSION,
      acceptedAt: Date.now()
    };

    showMessage("", "");
    setBusy(true);

    const saved = await storageSet({ [CONSENT_KEY]: payload });
    setBusy(false);

    if (!saved) {
      showMessage("Could not save your acceptance. Please try again.", "error");
      return;
    }

    consentRecord = payload;
    renderConsent();
    showMessage("Agreement saved. Automation is now enabled.", "success");

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    elements.acceptedPanel.scrollIntoView({
      behavior: reduceMotion ? "auto" : "smooth",
      block: "center"
    });
  }

  function declineConsent() {
    elements.agreeCheck.checked = false;
    syncAgreeButton();
    showMessage("Automation stays paused. You can review and agree anytime from the extension popup.", "warning");
    elements.agreeCheck.focus({ preventScroll: true });
  }

  async function withdrawConsent() {
    if (!isConsentValid(consentRecord)) {
      return;
    }

    if (!withdrawArmed) {
      withdrawArmed = true;
      elements.withdrawButton.textContent = "Click again to confirm";
      elements.withdrawButton.classList.add("is-confirming");
      showMessage("Withdrawing consent will pause automation. Click again to confirm.", "warning");

      window.clearTimeout(withdrawTimer);
      withdrawTimer = window.setTimeout(resetWithdrawButton, WITHDRAW_CONFIRM_MS);
      return;
    }

    window.clearTimeout(withdrawTimer);

    const removed = await storageRemove(CONSENT_KEY);
    if (!removed) {
      resetWithdrawButton();
      showMessage("Could not withdraw consent. Please try again.", "error");
      return;
    }

    consentRecord = null;
    resetWithdrawButton();
    renderConsent();
    showMessage("Consent withdrawn. Automation is paused.", "warning");
    elements.agreeCheck.focus({ preventScroll: true });
  }

  function resetWithdrawButton() {
    window.clearTimeout(withdrawTimer);
    withdrawTimer = 0;
    withdrawArmed = false;

    if (!elements.withdrawButton) {
      return;
    }

    elements.withdrawButton.textContent = "Withdraw consent";
    elements.withdrawButton.classList.remove("is-confirming");
  }

  function setBusy(value) {
    busy = value;
    elements.agreeButton.classList.toggle("is-loading", value);
    elements.agreeButton.setAttribute("aria-busy", String(value));
    elements.agreeLabel.textContent = value ? "Saving…" : "I Agree";
    elements.agreeCheck.disabled = value;
    elements.declineButton.disabled = value;
    syncAgreeButton();
  }

  function syncAgreeButton() {
    elements.agreeButton.disabled = busy || !elements.agreeCheck.checked;
  }

  function showNotice(message) {
    elements.notice.textContent = message;
    elements.notice.hidden = false;
  }

  function showMessage(message, tone) {
    elements.message.textContent = message;
    elements.message.className = "consent-message" + (tone ? ` is-${tone}` : "");
  }

  function handleStorageChange(changes, areaName) {
    if (areaName !== "local" || !changes[CONSENT_KEY]) {
      return;
    }

    consentRecord = changes[CONSENT_KEY].newValue ?? null;
    renderConsent();
  }

  function closeCurrentTab() {
    try {
      chrome.tabs.getCurrent((tab) => {
        if (chrome.runtime.lastError || !tab?.id) {
          window.close();
          return;
        }

        chrome.tabs.remove(tab.id, () => {
          if (chrome.runtime.lastError) {
            window.close();
          }
        });
      });
    } catch {
      window.close();
    }
  }

  function formatDate(timestamp) {
    const date = new Date(Number(timestamp));

    if (Number.isNaN(date.getTime())) {
      return "—";
    }

    return date.toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short"
    });
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

  function storageGet(key) {
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

  function storageSet(value) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set(value, () => {
          resolve(!chrome.runtime.lastError);
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
          resolve(!chrome.runtime.lastError);
        });
      } catch {
        resolve(false);
      }
    });
  }
})();
