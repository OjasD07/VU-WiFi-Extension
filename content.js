(() => {
  "use strict";

  const VERSION = "1.0.0";
  const GLOBAL_KEY = "__vuWifiAutoLoginV1";
  const SETTINGS_KEY = "vuSettings";
  const STATUS_KEY = "vuLastStatus";

  const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    username: "vu2student",
    password: "vu2student",
    autoAcceptTerms: true
  });

  const LOGOUT_RE = /(log\s*out|logout|log\s*off|logoff|sign\s*out|signout|disconnect|end\s+session|terminate)/i;
  const PASSIVE_TEXT_LIMIT = 18000;
  const MUTATION_DELAY = 220;
  const WARMUP_LIFETIME = 12000;
  const KEEPALIVE_GUARD_KEY = "__vuAutoLoginKeepaliveAt";
  const KEEPALIVE_GUARD_MS = 20000;

  const previousInstance = window[GLOBAL_KEY];
  if (previousInstance && typeof previousInstance.trigger === "function") {
    try {
      previousInstance.trigger("reinjected");
    } catch {
      // The existing instance remains the active one.
    }
    return;
  }

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    initialized: false,
    observer: null,
    observerPermanent: false,
    warmupTimer: 0,
    scanTimer: 0,
    actionLock: false,
    portalActive: false,
    keepalivePage: false,
    loginSubmitted: false,
    keepaliveClicked: false,
    termsAccepted: false,
    portalAnnounced: false,
    lastStatus: null,
    lastStatusFingerprint: "",
    lastStatusAt: 0,
    lastAssessment: null
  };

  let resolveReady;
  const readyPromise = new Promise((resolve) => {
    resolveReady = resolve;
  });

  // ---------------------------------------------------------------------------
  // Message routing
  // ---------------------------------------------------------------------------

  try {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || typeof message.type !== "string") {
        return false;
      }

      if (message.type === "VU_GET_PAGE_STATE") {
        sendResponse(buildPageState());
        return false;
      }

      if (message.type === "VU_TRIGGER_LOGIN") {
        handleManualTrigger()
          .then(sendResponse)
          .catch((error) => {
            sendResponse({
              ok: false,
              executed: false,
              message: "Could not scan this page.",
              error: error instanceof Error ? error.message : String(error),
              pageState: buildPageState()
            });
          });
        return true;
      }

      return false;
    });
  } catch {
    // Extension context may have been invalidated. The page remains untouched.
  }

  try {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local" || !changes[SETTINGS_KEY]) {
        return;
      }

      const wasEnabled = state.settings.enabled;
      state.settings = normalizeSettings(changes[SETTINGS_KEY].newValue);

      if (!state.settings.enabled) {
        stopObserver();
        return;
      }

      if (!wasEnabled && state.initialized) {
        window.setTimeout(() => {
          const assessment = assessPage();
          if (assessment.portal) {
            activatePortal(assessment);
            scanPage("settings-enabled");
          } else {
            beginWarmupIfUseful(assessment);
          }
        }, 60);
      }
    });
  } catch {
    // Storage events are optional; message scans still work.
  }

  // ---------------------------------------------------------------------------
  // Shared utilities
  // ---------------------------------------------------------------------------

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

  function compact(value) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  }

  function lower(value) {
    return compact(value).toLowerCase();
  }

  function getBodyText(limit = PASSIVE_TEXT_LIMIT) {
    if (!document.body) {
      return "";
    }

    let text = "";
    try {
      text = document.body.innerText || document.body.textContent || "";
    } catch {
      text = document.body.textContent || "";
    }

    return compact(text).slice(0, limit);
  }

  function getControlText(element) {
    if (!(element instanceof Element)) {
      return "";
    }

    const parts = [];
    if (element instanceof HTMLInputElement) {
      parts.push(element.value);
    } else {
      parts.push(element.textContent || "");
    }
    parts.push(element.getAttribute("aria-label") || "");
    parts.push(element.getAttribute("title") || "");

    return compact(parts.join(" "));
  }

  function getAccessibleText(element) {
    if (!(element instanceof Element)) {
      return "";
    }

    const parts = [
      getControlText(element),
      element.getAttribute("name") || "",
      element.getAttribute("id") || "",
      element.getAttribute("placeholder") || ""
    ];

    if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement) {
      try {
        if (element.labels) {
          for (const label of element.labels) {
            parts.push(label.textContent || "");
          }
        }
      } catch {
        // Cross-root labels may not be enumerable.
      }
    }

    const wrappingLabel = element.closest("label");
    if (wrappingLabel) {
      parts.push(wrappingLabel.textContent || "");
    }

    return lower(parts.join(" "));
  }

  function isUsable(element, allowHidden = false) {
    if (!(element instanceof Element) || !element.isConnected) {
      return false;
    }

    if (element.hidden) {
      return false;
    }

    if ("disabled" in element && element.disabled) {
      return false;
    }

    if (element.getAttribute("aria-disabled") === "true") {
      return false;
    }

    if (!allowHidden && element.getAttribute("aria-hidden") === "true") {
      return false;
    }

    let style;
    try {
      style = window.getComputedStyle(element);
    } catch {
      return false;
    }

    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") {
      return false;
    }

    const rect = element.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) {
      return allowHidden;
    }

    return true;
  }

  function isLogoutControl(element) {
    if (!(element instanceof Element)) {
      return false;
    }

    const anchor = element.closest("a");
    const values = [
      getControlText(element),
      element.getAttribute("aria-label") || "",
      element.getAttribute("title") || "",
      element.getAttribute("id") || "",
      element.getAttribute("name") || "",
      element.getAttribute("class") || "",
      element.getAttribute("href") || "",
      element.getAttribute("formaction") || "",
      element.getAttribute("data-action") || "",
      element.getAttribute("onclick") || ""
    ];

    if (anchor && anchor !== element) {
      values.push(anchor.textContent || "");
      values.push(anchor.getAttribute("href") || "");
      values.push(anchor.getAttribute("data-action") || "");
      values.push(anchor.getAttribute("onclick") || "");
    }

    if (element instanceof HTMLButtonElement && element.form) {
      values.push(element.form.getAttribute("action") || "");
    }

    return LOGOUT_RE.test(lower(values.join(" ")));
  }

  function isTargetHost() {
    return window.location.hostname === "10.25.0.1";
  }

  function isKnownCaptiveProbe() {
    const host = window.location.hostname.toLowerCase();
    return [
      "captive.apple.com",
      "connectivitycheck.gstatic.com",
      "clients3.google.com",
      "detectportal.firefox.com",
      "msftconnecttest.com",
      "www.msftconnecttest.com",
      "msftncsi.com",
      "www.msftncsi.com",
      "nmcheck.gnome.org",
      "networkcheck.kde.org"
    ].includes(host);
  }

  function isPrivateHost() {
    const host = window.location.hostname.toLowerCase();

    if (!host) {
      return false;
    }

    if (host === "localhost" || host.endsWith(".local") || host === "::1") {
      return true;
    }

    return /^(127\.|10\.|192\.168\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)
      || /^(fc|fd|fe80:)/i.test(host);
  }

  function setProcessed(element) {
    if (element instanceof Element) {
      element.dataset.autologinProcessed = "true";
    }
  }

  // ---------------------------------------------------------------------------
  // Storage, status, and page state
  // ---------------------------------------------------------------------------

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

  function sendExtensionMessage(message) {
    try {
      chrome.runtime.sendMessage(message, () => {
        // Accessing lastError prevents an unchecked runtime error when the
        // popup is closed and no receiver exists.
        void chrome.runtime.lastError;
      });
    } catch {
      // Extension context was invalidated.
    }
  }

  function publishStatus(message, tone = "idle", kind = "status", extras = {}) {
    const now = Date.now();
    const payload = {
      message: compact(message).slice(0, 180) || "Waiting for portal",
      tone: ["idle", "active", "success", "warning"].includes(tone) ? tone : "idle",
      kind,
      timestamp: now,
      portal: extras.portal !== undefined ? Boolean(extras.portal) : state.portalActive,
      keepalive: extras.keepalive !== undefined ? Boolean(extras.keepalive) : state.keepalivePage,
      url: window.location.href,
      version: VERSION
    };

    const fingerprint = `${payload.message}|${payload.tone}|${payload.kind}|${payload.url}`;
    if (fingerprint === state.lastStatusFingerprint && now - state.lastStatusAt < 1500) {
      return state.lastStatus;
    }

    state.lastStatus = payload;
    state.lastStatusFingerprint = fingerprint;
    state.lastStatusAt = now;

    void storageSet({ [STATUS_KEY]: payload });
    sendExtensionMessage({ type: "VU_STATUS_UPDATE", status: payload });

    return payload;
  }

  function buildPageState() {
    return {
      portal: Boolean(isTargetHost() || state.portalActive),
      target: isTargetHost(),
      keepalive: Boolean(state.keepalivePage),
      enabled: Boolean(state.settings.enabled),
      url: window.location.href,
      action: state.lastStatus?.kind || "idle",
      message: state.lastStatus?.message || "",
      updatedAt: state.lastStatus?.timestamp || 0,
      version: VERSION
    };
  }

  async function loadSettings() {
    const stored = await storageGet(SETTINGS_KEY);
    state.settings = normalizeSettings(stored[SETTINGS_KEY]);
    return state.settings;
  }

  // ---------------------------------------------------------------------------
  // Portal detection
  // ---------------------------------------------------------------------------

  const STRONG_PORTAL_PATTERNS = [
    /authentication\s+keepalive/,
    /keep\s+your\s+authentication\s+session\s+active/,
    /browser\s+window\s+is\s+used\s+to\s+keep/,
    /click\s+here\s+to\s+continue\s+with\s+your\s+browsing/,
    /sign\s*in\s+to\s+(the\s+)?(wi-?fi|wireless|network|internet)/,
    /(wi-?fi|wireless)\s+(login|sign\s*in|authentication|access)/,
    /captive\s+portal/,
    /network\s+authentication/,
    /acceptable\s+use\s+policy/,
    /network\s+access\s+policy/,
    /authentication\s+required/
  ];

  const URL_PORTAL_RE = /(keepalive|keep-alive|portal|captive|login|log-in|signin|sign-in|auth|agree|terms|welcome|redirect|hotspot)/i;
  const NETWORK_CONTEXT_RE = /(wi-?fi|wireless|hotspot|network\s+access|internet\s+access|university\s+network|campus\s+network|captive|authentication)/i;

  function assessPage() {
    const target = isTargetHost();
    const privateHost = isPrivateHost();
    const knownProbe = isKnownCaptiveProbe();
    const bodyText = getBodyText();
    const title = lower(document.title);
    const href = (() => {
      try {
        return decodeURIComponent(window.location.href);
      } catch {
        return window.location.href;
      }
    })();
    const urlText = lower(href);
    const haystack = lower(`${title} ${urlText} ${bodyText}`);

    const passwordFields = getVisiblePasswordInputs();
    const textFields = getVisibleTextInputs(document);
    const hasLoginFields = passwordFields.length > 0;
    const urlSignal = URL_PORTAL_RE.test(urlText);
    const networkContext = NETWORK_CONTEXT_RE.test(haystack);
    const strongCount = STRONG_PORTAL_PATTERNS.reduce(
      (count, pattern) => count + (pattern.test(haystack) ? 1 : 0),
      0
    );

    const hasTermsWords = /(terms|agreement|acceptable\s+use|usage\s+policy|network\s+policy|privacy\s+policy|conditions)/i.test(haystack);
    const hasAcceptWords = /(i\s+agree|agree|accept|consent)/i.test(haystack);
    const termsScreen = hasTermsWords && hasAcceptWords;

    const keepalivePage = /(^|[/?&=_-])keep-?alive([/?&=_-]|$)/i.test(urlText)
      || /authentication\s+keepalive/i.test(haystack)
      || /keep\s+your\s+authentication\s+session\s+active/i.test(haystack)
      || /browser\s+window\s+is\s+used\s+to\s+keep/i.test(haystack);

    let portal = target || keepalivePage;

    if (!portal) {
      if (strongCount > 0 && (hasLoginFields || termsScreen || privateHost || knownProbe || urlSignal)) {
        portal = true;
      } else if (strongCount >= 2) {
        portal = true;
      } else if (privateHost && hasLoginFields && networkContext) {
        portal = true;
      } else if (privateHost && termsScreen && networkContext) {
        portal = true;
      } else if (knownProbe && (hasLoginFields || strongCount > 0)) {
        portal = true;
      } else if (urlSignal && networkContext && (hasLoginFields || termsScreen)) {
        portal = true;
      }
    }

    const assessment = {
      portal,
      target,
      privateHost,
      knownProbe,
      keepalivePage,
      termsScreen,
      urlSignal,
      networkContext,
      strongCount,
      hasLoginFields,
      passwordFieldCount: passwordFields.length,
      textFieldCount: textFields.length
    };

    state.lastAssessment = assessment;
    return assessment;
  }

  function activatePortal(assessment) {
    window.clearTimeout(state.warmupTimer);
    state.portalActive = true;
    state.keepalivePage = Boolean(assessment.keepalivePage);

    if (state.settings.enabled) {
      state.observerPermanent = true;
      startObserver();
    }
  }

  function beginWarmupIfUseful(assessment) {
    if (!state.settings.enabled || state.observerPermanent) {
      return;
    }

    const useful = assessment.target
      || assessment.privateHost
      || assessment.knownProbe
      || assessment.hasLoginFields
      || assessment.urlSignal;

    if (!useful) {
      return;
    }

    startObserver(true);
    scheduleScan("warmup-start", 140);
  }

  // ---------------------------------------------------------------------------
  // Step 1: credentials and form submission
  // ---------------------------------------------------------------------------

  const USERNAME_HINT_RE = /(user|login|email|e-mail|student|account|roll|registration|userid|user-id|identity)/i;
  const USERNAME_AVOID_RE = /(search|captcha|otp|one[-\s]?time|token|remember|terms|agree|newsletter|promo|coupon)/i;
  const SUBMIT_TEXT_RE = /(log\s*in|login|sign\s*in|signin|connect|authenticate|submit|continue|access|go)/i;
  const SUBMIT_AVOID_RE = /(log\s*out|logout|sign\s*out|signout|forgot|reset|cancel|register|sign\s*up|create\s+account|back|help|close)/i;

  function getVisiblePasswordInputs() {
    return Array.from(document.querySelectorAll('input[type="password"]'))
      .filter((input) => isUsable(input) && !input.readOnly)
      .slice(0, 8);
  }

  function getVisibleTextInputs(scope) {
    const allowedTypes = new Set(["text", "email", "tel", "number", "url"]);
    const root = scope && typeof scope.querySelectorAll === "function" ? scope : document;

    return Array.from(root.querySelectorAll("input"))
      .filter((input) => {
        if (!(input instanceof HTMLInputElement) || !isUsable(input) || input.readOnly) {
          return false;
        }
        const type = (input.getAttribute("type") || "text").toLowerCase();
        return allowedTypes.has(type);
      })
      .slice(0, 20);
  }

  function scoreUsernameInput(input) {
    const hints = lower([
      input.getAttribute("autocomplete") || "",
      input.getAttribute("name") || "",
      input.getAttribute("id") || "",
      input.getAttribute("placeholder") || "",
      input.getAttribute("aria-label") || "",
      getAccessibleText(input)
    ].join(" "));

    let score = 0;
    if (/(^|\s)username(\s|$)/.test(hints) || /(^|\s)user-name(\s|$)/.test(hints)) score += 8;
    if (input.getAttribute("autocomplete") === "username") score += 10;
    if (/(email|e-mail|student|account|userid|user-id|login|user)/i.test(hints)) score += 5;
    if (/password|search|captcha|otp|token/i.test(hints)) score -= 12;
    if (USERNAME_AVOID_RE.test(hints)) score -= 7;
    if (input.type === "email") score += 3;
    if (input.type === "number") score -= 2;

    return score;
  }

  function findUsernameInput(scope, passwordInput) {
    const inputs = getVisibleTextInputs(scope)
      .filter((input) => input !== passwordInput)
      .map((input) => ({ input, score: scoreUsernameInput(input) }))
      .sort((a, b) => b.score - a.score);

    if (!inputs.length) {
      return null;
    }

    const best = inputs[0];
    if (best.score <= -8) {
      return null;
    }

    return best.input;
  }

  function findLoginScope(passwordInput) {
    const form = passwordInput.closest("form");
    if (form) {
      return form;
    }

    let node = passwordInput.parentElement;
    for (let depth = 0; node && depth < 7; depth += 1) {
      const inputs = node.querySelectorAll("input");
      const textInputs = getVisibleTextInputs(node);
      if (inputs.length >= 2 && inputs.length <= 12 && textInputs.length > 0) {
        return node;
      }
      node = node.parentElement;
    }

    return document.body;
  }

  function findLoginCandidate() {
    const passwords = getVisiblePasswordInputs();
    const candidates = [];

    for (const passwordInput of passwords) {
      const form = passwordInput.closest("form");
      const scope = form || findLoginScope(passwordInput);
      if (!scope) {
        continue;
      }

      const usernameInput = findUsernameInput(scope, passwordInput);
      const scopeText = lower((() => {
        let value = "";
        try {
          value = scope.innerText || scope.textContent || "";
        } catch {
          value = scope.textContent || "";
        }
        return value;
      })().slice(0, 5000));

      const passwordCount = Array.from(scope.querySelectorAll('input[type="password"]'))
        .filter((input) => isUsable(input)).length;

      let score = 0;
      if (form) score += 5;
      if (usernameInput) score += 6;
      if (usernameInput && scoreUsernameInput(usernameInput) >= 5) score += 3;
      if (/(sign\s*in|log\s*in|login|authenticate|username|password)/i.test(scopeText)) score += 3;
      if (/(create\s+account|sign\s*up|register|confirm\s+password|new\s+password)/i.test(scopeText)) score -= 10;
      if (passwordCount > 1) score -= 5;
      if (passwordInput.autocomplete === "current-password") score += 5;
      if (passwordInput.autocomplete === "new-password") score -= 8;

      const action = lower(form?.getAttribute("action") || "");
      if (/(login|log-in|signin|sign-in|auth|portal)/i.test(action)) score += 3;

      if (score < 0) {
        continue;
      }

      candidates.push({
        form,
        scope,
        usernameInput,
        passwordInput,
        score,
        passwordCount
      });
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0] || null;
  }

  function dispatchFieldEvents(input) {
    try {
      input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    } catch {
      // Some locked-down pages reject synthetic events; the value is still set.
    }
  }

  function setInputValue(input, value) {
    if (!(input instanceof HTMLInputElement)) {
      return;
    }

    try {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
      if (descriptor?.set) {
        descriptor.set.call(input, value);
      } else {
        input.value = value;
      }
    } catch {
      input.value = value;
    }

    dispatchFieldEvents(input);
  }

  function findSubmitControl(scope, form) {
    const controls = [];
    const selectors = [
      "button",
      'input[type="submit"]',
      'input[type="image"]',
      'input[type="button"]',
      '[role="button"]'
    ];

    if (scope) {
      controls.push(...scope.querySelectorAll(selectors.join(",")));
    }

    if (form?.id) {
      try {
        const escapedId = CSS.escape(form.id);
        controls.push(...document.querySelectorAll(
          `button[form="${escapedId}"], input[form="${escapedId}"]`
        ));
      } catch {
        // Ignore malformed IDs.
      }
    }

    const seen = new Set();
    const ranked = [];

    for (const control of controls) {
      if (!(control instanceof Element) || seen.has(control) || !isUsable(control)) {
        continue;
      }
      seen.add(control);

      if (isLogoutControl(control) || SUBMIT_AVOID_RE.test(getControlText(control))) {
        continue;
      }

      const type = lower(control.getAttribute("type") || "");
      const text = lower(getControlText(control));
      let score = 0;

      if (type === "submit" || type === "image") score += 8;
      if (SUBMIT_TEXT_RE.test(text)) score += 5;
      if (control.tagName === "BUTTON" && (type === "submit" || !type)) score += 3;
      if (type === "button" && !SUBMIT_TEXT_RE.test(text)) score -= 3;
      if (!text) score -= 1;

      if (score > 0) {
        ranked.push({ control, score });
      }
    }

    ranked.sort((a, b) => b.score - a.score);
    return ranked[0]?.control || null;
  }

  function requestFormSubmit(form) {
    if (!(form instanceof HTMLFormElement)) {
      return false;
    }

    try {
      if (typeof form.requestSubmit === "function") {
        form.requestSubmit();
        return true;
      }
    } catch {
      // requestSubmit can fail validation or because of page script errors.
    }

    try {
      form.submit();
      return true;
    } catch {
      return false;
    }
  }

  function submitLogin(candidate) {
    if (!candidate || state.loginSubmitted) {
      return { executed: false, action: "login", reason: "already-submitted" };
    }

    state.loginSubmitted = true;

    if (candidate.usernameInput) {
      setInputValue(candidate.usernameInput, state.settings.username);
      setProcessed(candidate.usernameInput);
    }
    setInputValue(candidate.passwordInput, state.settings.password);
    setProcessed(candidate.passwordInput);

    const submitControl = findSubmitControl(candidate.scope, candidate.form);
    let submitted = false;

    if (submitControl) {
      setProcessed(submitControl);
      try {
        submitControl.click();
        submitted = true;
      } catch {
        submitted = requestFormSubmit(candidate.form);
      }
    } else if (candidate.form) {
      submitted = requestFormSubmit(candidate.form);
    } else {
      const fallback = Array.from(candidate.scope.querySelectorAll("button, [role=\"button\"], input[type=\"button\"]"))
        .find((control) => {
          if (!isUsable(control) || isLogoutControl(control)) return false;
          return SUBMIT_TEXT_RE.test(getControlText(control));
        });

      if (fallback) {
        setProcessed(fallback);
        try {
          fallback.click();
          submitted = true;
        } catch {
          submitted = false;
        }
      }
    }

    const message = submitted
      ? `Logged in as ${state.settings.username}`
      : "Login fields filled; submit button not found";

    publishStatus(message, submitted ? "success" : "warning", "login", {
      portal: true,
      keepalive: false
    });

    return {
      executed: submitted,
      action: "login",
      message,
      submitted
    };
  }

  // ---------------------------------------------------------------------------
  // Step 2: keepalive continuation (never logout, never close the tab)
  // ---------------------------------------------------------------------------

  function findContinueControl() {
    const selectors = [
      "a",
      "button",
      'input[type="button"]',
      'input[type="submit"]',
      '[role="button"]'
    ];

    const candidates = [];

    for (const element of document.querySelectorAll(selectors.join(","))) {
      if (!isUsable(element)) {
        continue;
      }

      const text = getControlText(element);
      if (!/\bclick\s+here\b/i.test(text)) {
        continue;
      }

      if (isLogoutControl(element)) {
        continue;
      }

      const anchor = element.closest("a");
      const href = anchor?.getAttribute("href") || element.getAttribute("href") || "";
      if (LOGOUT_RE.test(href)) {
        continue;
      }

      let score = 0;
      if (/click\s+here\s+to\s+continue/i.test(text)) score += 4;
      if (anchor) score += 2;
      if (/(continue|browsing|proceed)/i.test(text)) score += 2;

      candidates.push({ element, anchor, score });
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates[0] || null;
  }

  function preserveKeepaliveTab(anchor) {
    if (!(anchor instanceof HTMLAnchorElement)) {
      return;
    }

    const href = compact(anchor.getAttribute("href"));
    if (!href || /^(#|javascript:|mailto:|tel:)/i.test(href)) {
      return;
    }

    const target = lower(anchor.getAttribute("target"));
    if (!target || target === "_self") {
      // The keepalive page must remain open in the background.
      anchor.setAttribute("target", "_blank");

      const rel = new Set(lower(anchor.getAttribute("rel")).split(/\s+/).filter(Boolean));
      rel.add("noopener");
      anchor.setAttribute("rel", Array.from(rel).join(" "));
    }
  }

  function keepaliveWasRecentlyContinued() {
    try {
      const lastAttempt = Number(window.localStorage.getItem(KEEPALIVE_GUARD_KEY));
      return Number.isFinite(lastAttempt) && Date.now() - lastAttempt < KEEPALIVE_GUARD_MS;
    } catch {
      return false;
    }
  }

  function rememberKeepaliveContinue() {
    try {
      window.localStorage.setItem(KEEPALIVE_GUARD_KEY, String(Date.now()));
    } catch {
      // localStorage may be blocked; per-page guards still prevent repeats.
    }
  }

  function continueKeepalive() {
    if (state.keepaliveClicked) {
      return { executed: false, action: "keepalive", reason: "already-clicked" };
    }

    // Prevent a captive portal that redirects the continuation target back to
    // its keepalive page from spawning an endless chain of tabs.
    if (keepaliveWasRecentlyContinued()) {
      return { executed: false, action: "keepalive", reason: "recently-clicked" };
    }

    const match = findContinueControl();
    if (!match) {
      return { executed: false, action: "keepalive", reason: "not-found" };
    }

    state.keepaliveClicked = true;
    rememberKeepaliveContinue();
    setProcessed(match.element);
    if (match.anchor) {
      setProcessed(match.anchor);
      preserveKeepaliveTab(match.anchor);
    }

    try {
      match.element.click();
    } catch {
      publishStatus("Keepalive link could not be clicked", "warning", "keepalive", {
        portal: true,
        keepalive: true
      });
      return { executed: false, action: "keepalive", reason: "click-failed" };
    }

    const message = "Bypassed keepalive screen";
    publishStatus(message, "success", "keepalive", {
      portal: true,
      keepalive: true
    });

    return { executed: true, action: "keepalive", message };
  }

  // ---------------------------------------------------------------------------
  // Step 3: network terms acceptance
  // ---------------------------------------------------------------------------

  function getCheckboxLabel(element) {
    if (!(element instanceof Element)) {
      return null;
    }

    if (element.id) {
      try {
        const label = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
        if (label) return label;
      } catch {
        // Ignore malformed IDs.
      }
    }

    const wrappingLabel = element.closest("label");
    if (wrappingLabel) {
      return wrappingLabel;
    }

    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const target = labelledBy
        .split(/\s+/)
        .map((id) => {
          try {
            return document.getElementById(id);
          } catch {
            return null;
          }
        })
        .find(Boolean);
      if (target) {
        return target;
      }
    }

    return null;
  }

  function checkboxIsChecked(element) {
    if (element instanceof HTMLInputElement) {
      return element.checked;
    }

    const ariaChecked = element.getAttribute("aria-checked");
    if (ariaChecked !== null) {
      return ariaChecked === "true";
    }

    return element.dataset.state === "checked";
  }

  function findTermsCheckbox() {
    const all = Array.from(document.querySelectorAll('input[type="checkbox"], [role="checkbox"]'));
    const positive = /(agree|accept|terms|policy|consent|conditions|eula|tos)/i;
    const negative = /(remember|newsletter|marketing|analytics|advertising|ads|cookie\s+preferences?)/i;
    const matches = [];

    for (const element of all) {
      const label = getCheckboxLabel(element);
      if (!isUsable(element, true) && !(label && isUsable(label))) {
        continue;
      }

      const meta = lower([
        element.getAttribute("id") || "",
        element.getAttribute("name") || "",
        element.getAttribute("class") || "",
        element.getAttribute("value") || "",
        element.getAttribute("aria-label") || "",
        element.getAttribute("data-testid") || "",
        getAccessibleText(element),
        label?.textContent || ""
      ].join(" "));

      if (negative.test(meta) || !positive.test(meta)) {
        continue;
      }

      matches.push({ element, label, checked: checkboxIsChecked(element) });
    }

    if (matches.length > 0) {
      const unchecked = matches.find((match) => !match.checked);
      return unchecked || matches[0];
    }

    // Conservative fallback for a terms screen with one unlabeled checkbox.
    if (state.lastAssessment?.termsScreen && getVisiblePasswordInputs().length === 0) {
      const usable = all.filter((element) => {
        const label = getCheckboxLabel(element);
        if (!isUsable(element, true) && !(label && isUsable(label))) return false;
        const meta = getAccessibleText(element);
        return !negative.test(meta);
      });
      if (usable.length === 1) {
        return {
          element: usable[0],
          label: getCheckboxLabel(usable[0]),
          checked: checkboxIsChecked(usable[0])
        };
      }
    }

    return null;
  }

  function ensureCheckboxChecked(match) {
    const { element, label } = match;

    setProcessed(element);
    if (label) {
      setProcessed(label);
    }

    if (checkboxIsChecked(element)) {
      return true;
    }

    const clickTarget = isUsable(element) ? element : (label && isUsable(label) ? label : element);

    try {
      clickTarget.click();
    } catch {
      // Fall back to setting the native state below.
    }

    if (!checkboxIsChecked(element) && element instanceof HTMLInputElement) {
      try {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked");
        if (descriptor?.set) {
          descriptor.set.call(element, true);
        } else {
          element.checked = true;
        }
      } catch {
        element.checked = true;
      }

      try {
        element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      } catch {
        // Requirement fulfilled via the native checked state.
      }
    } else if (!checkboxIsChecked(element) && element.getAttribute("role") === "checkbox") {
      element.setAttribute("aria-checked", "true");
      try {
        element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      } catch {
        // Custom checkbox state is still marked.
      }
    }

    return checkboxIsChecked(element);
  }

  function findAgreeButton() {
    const selectors = [
      "button",
      'input[type="submit"]',
      'input[type="button"]',
      "a",
      '[role="button"]'
    ];
    const negative = /(disagree|decline|reject|cancel|close|back|logout|log\s*out|sign\s*out|cookie|newsletter)/i;
    const agreeLabel = /^(?:i\s+)?(?:agree|accept)(?:\s+(?:to|the))*\s*(?:(?:terms|policy|conditions|agreement|use|access)(?:\s+(?:and|&)\s+conditions)?)?\s*(?:(?:and|&)\s*(?:continue|proceed))?[.!]*$/i;
    const matches = [];

    for (const element of document.querySelectorAll(selectors.join(","))) {
      if (!isUsable(element) || isLogoutControl(element)) {
        continue;
      }

      const text = compact(getControlText(element));
      if (!text || negative.test(text) || !agreeLabel.test(text)) {
        continue;
      }

      let score = 0;
      if (element.tagName === "BUTTON" || element instanceof HTMLInputElement) score += 2;
      if (/^(?:i\s+)?accept/i.test(text)) score += 1;
      matches.push({ element, score });
    }

    matches.sort((a, b) => b.score - a.score);
    return matches[0]?.element || null;
  }

  function acceptTerms() {
    if (!state.settings.autoAcceptTerms || state.termsAccepted) {
      return { executed: false, action: "terms", reason: "disabled" };
    }

    const checkbox = findTermsCheckbox();

    if (checkbox && !checkbox.checked) {
      const checked = ensureCheckboxChecked(checkbox);
      if (!checked) {
        return { executed: false, action: "terms", reason: "checkbox-failed" };
      }

      publishStatus("Terms checkbox selected", "active", "terms", {
        portal: true,
        keepalive: state.keepalivePage
      });
      scheduleScan("terms-checked", 280);

      return { executed: true, action: "terms", message: "Terms checkbox selected" };
    }

    const button = findAgreeButton();
    if (!button) {
      return { executed: false, action: "terms", reason: "no-agree-button" };
    }

    setProcessed(button);
    state.termsAccepted = true;

    try {
      button.click();
    } catch {
      state.termsAccepted = false;
      publishStatus("Terms button could not be clicked", "warning", "terms", {
        portal: true,
        keepalive: state.keepalivePage
      });
      return { executed: false, action: "terms", reason: "click-failed" };
    }

    const message = "Terms accepted";
    publishStatus(message, "success", "terms", {
      portal: true,
      keepalive: state.keepalivePage
    });

    return { executed: true, action: "terms", message };
  }

  // ---------------------------------------------------------------------------
  // Action orchestration and dynamic DOM observation
  // ---------------------------------------------------------------------------

  function scheduleScan(reason, delay = MUTATION_DELAY) {
    if (!state.settings.enabled) {
      return;
    }

    window.clearTimeout(state.scanTimer);
    state.scanTimer = window.setTimeout(() => {
      state.scanTimer = 0;
      try {
        scanPage(reason);
      } catch {
        // A malformed page must never break the observer.
      }
    }, delay);
  }

  function performPageAction(assessment, options = {}) {
    if (state.actionLock) {
      return { executed: false, action: "none", reason: "busy", message: "Automation is busy" };
    }

    state.actionLock = true;

    try {
      if (state.settings.enabled || options.manual) {
        const loginCandidate = findLoginCandidate();
        if (loginCandidate && !state.loginSubmitted) {
          const loginResult = submitLogin(loginCandidate);
          state.portalAnnounced = true;
          if (loginResult.executed) {
            scheduleScan("post-login", 1000);
          }
          if (loginResult.reason !== "already-submitted") {
            return loginResult;
          }
        }

        if (assessment.keepalivePage && !state.keepaliveClicked) {
          const keepaliveResult = continueKeepalive();
          if (keepaliveResult.executed || keepaliveResult.reason === "click-failed") {
            state.portalAnnounced = true;
            return keepaliveResult;
          }
        }

        if (state.settings.autoAcceptTerms && assessment.termsScreen && !state.termsAccepted) {
          const termsResult = acceptTerms();
          if (termsResult.executed || termsResult.reason === "checkbox-failed" || termsResult.reason === "click-failed") {
            state.portalAnnounced = true;
            return termsResult;
          }
        }
      }

      if (!state.portalAnnounced) {
        state.portalAnnounced = true;
        const message = assessment.keepalivePage
          ? "Keepalive page detected · watching"
          : "Portal reached · waiting";
        publishStatus(message, "active", "portal", {
          portal: true,
          keepalive: assessment.keepalivePage
        });
      }

      return {
        executed: false,
        action: "none",
        reason: "no-pending-action",
        message: "No pending portal action found"
      };
    } finally {
      state.actionLock = false;
    }
  }

  function scanPage(reason = "scan") {
    if (!document.body) {
      return { executed: false, reason: "no-body" };
    }

    const assessment = assessPage();

    if (!assessment.portal) {
      return { executed: false, reason: "not-portal" };
    }

    activatePortal(assessment);

    if (!state.settings.enabled) {
      return { executed: false, reason: "disabled" };
    }

    const result = performPageAction(assessment, { manual: false });
    return { ...result, assessment, scanReason: reason };
  }

  function startObserver(temporary = false) {
    if (!state.settings.enabled) {
      return;
    }

    if (!document.body) {
      document.addEventListener("DOMContentLoaded", () => {
        if (state.settings.enabled) startObserver(temporary);
      }, { once: true });
      return;
    }

    if (!state.observer) {
      state.observer = new MutationObserver(() => {
        if (!state.settings.enabled || state.actionLock) {
          return;
        }
        scheduleScan("mutation", MUTATION_DELAY);
      });

      state.observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [
          "type",
          "name",
          "id",
          "disabled",
          "hidden",
          "role",
          "aria-checked",
          "aria-disabled"
        ]
      });
    }

    if (temporary && !state.observerPermanent) {
      window.clearTimeout(state.warmupTimer);
      state.warmupTimer = window.setTimeout(() => {
        if (!state.observerPermanent) {
          stopObserver();
        }
      }, WARMUP_LIFETIME);
    }
  }

  function stopObserver() {
    window.clearTimeout(state.warmupTimer);
    window.clearTimeout(state.scanTimer);
    state.warmupTimer = 0;
    state.scanTimer = 0;

    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }

    state.observerPermanent = false;
  }

  async function handleManualTrigger() {
    await readyPromise;

    if (!document.body) {
      return {
        ok: false,
        executed: false,
        message: "The page is still loading. Try again in a moment.",
        pageState: buildPageState()
      };
    }

    const assessment = assessPage();

    if (!assessment.portal) {
      state.portalActive = false;
      state.keepalivePage = false;

      const message = "No captive portal controls found on this tab.";
      publishStatus(message, "warning", "manual", {
        portal: false,
        keepalive: false
      });

      return {
        ok: false,
        executed: false,
        action: "none",
        reason: "not-portal",
        message,
        pageState: buildPageState(),
        status: state.lastStatus
      };
    }

    activatePortal(assessment);
    state.portalAnnounced = false;

    const result = performPageAction(assessment, { manual: true });
    let message = result.message || "Portal is open · no pending action found";
    let tone = "active";

    if (!result.executed) {
      if (result.reason === "busy") {
        message = "Automation is busy. Try again in a moment.";
        tone = "warning";
      } else if (result.reason === "no-pending-action" || result.reason === "already-clicked" || result.reason === "already-submitted") {
        message = "Portal is open · no pending action found";
        tone = "active";
      } else if (result.reason === "not-found" || result.reason === "no-agree-button") {
        message = "Portal is open · no pending action found";
        tone = "active";
      } else if (result.reason === "checkbox-failed" || result.reason === "click-failed") {
        message = "The portal control could not be activated.";
        tone = "warning";
      }

      publishStatus(message, tone, "manual", {
        portal: true,
        keepalive: assessment.keepalivePage
      });
    }

    return {
      ok: true,
      executed: Boolean(result.executed),
      action: result.action,
      reason: result.reason,
      message,
      pageState: buildPageState(),
      status: state.lastStatus
    };
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  async function init() {
    try {
      await loadSettings();
    } catch {
      state.settings = { ...DEFAULT_SETTINGS };
    }

    state.initialized = true;
    resolveReady();

    if (!state.settings.enabled) {
      return;
    }

    const assessment = assessPage();
    if (assessment.portal) {
      activatePortal(assessment);
      scanPage("init");
    } else {
      beginWarmupIfUseful(assessment);
    }

    // Delayed passes catch late client-side renders on pages that did not
    // qualify for the short-lived warmup observer.
    for (const delay of [1200, 3500, 7000]) {
      window.setTimeout(() => {
        if (!state.settings.enabled || state.observer || state.portalActive) {
          return;
        }
        const lateAssessment = assessPage();
        if (lateAssessment.portal) {
          activatePortal(lateAssessment);
          scanPage("late-init");
        } else {
          beginWarmupIfUseful(lateAssessment);
        }
      }, delay);
    }

    window.addEventListener("hashchange", () => scheduleScan("hashchange", 180));
    window.addEventListener("popstate", () => scheduleScan("popstate", 180));
    window.addEventListener("pageshow", (event) => {
      if (event.persisted) scheduleScan("pageshow", 250);
    });
  }

  const publicApi = Object.freeze({
    version: VERSION,
    trigger() {
      void handleManualTrigger();
    },
    getState: buildPageState
  });

  try {
    Object.defineProperty(window, GLOBAL_KEY, {
      value: publicApi,
      configurable: true,
      enumerable: false,
      writable: false
    });
  } catch {
    window[GLOBAL_KEY] = publicApi;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      void init();
    }, { once: true });
  } else {
    void init();
  }
})();
