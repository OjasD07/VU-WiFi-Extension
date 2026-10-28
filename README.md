<a href="https://www.ojasdeshpande.in" target="_blank"><img src="https://raw.githubusercontent.com/OjasD07/OjasD07/main/Logo.svg" alt="Logo" style="float: right; width: 88px; height: 88px; background: #ffffff; border-radius: 10px; padding: 8px; margin: 0 0 8px 8px;" /></a>


# VU Wi-Fi Auto Login Extension

A zero-dependency Chrome extension (Manifest V3) that automates the VU Wi-Fi captive portal flow:

1. Fills the campus login form and submits it.
2. Dismisses the authentication keepalive page without clicking logout or closing the keepalive tab.
3. Checks the network policy checkbox and accepts the terms.

On install and browser startup, a compact Privacy & Terms agreement appears inside the popup until the current terms version is accepted. A `!` badge stays on the toolbar icon if the popup cannot open automatically. Automation stays paused until then.

## Install in Chrome

This extension is distributed as a ZIP release on GitHub. Chrome cannot load the ZIP directly, so extract it first.

1. Open the [latest release](https://github.com/OjasD07/VU-WiFi-Extension/releases/latest) and download the release ZIP.
2. Extract the ZIP to a permanent folder you can find again. Chrome loads the extension from this folder, so do not delete or move it while installed.
3. Open `chrome://extensions` in Chrome.
4. Turn on **Developer mode** using the toggle in the top-right corner.
5. Click **Load unpacked** in the top-left corner.
6. Select the extracted folder — the one that contains `manifest.json`.
7. Pin the extension from Chrome's puzzle-piece menu if it is not visible in the toolbar.
8. Open the popup, agree to the brief privacy & terms summary, then open the VU Wi-Fi portal once and sign in.

Because the extension is installed outside the Chrome Web Store, Chrome may warn about developer-mode extensions. That is expected; do not choose **Disable**.

To update, download the newest release, replace the contents of the existing folder, and click **Reload** on `chrome://extensions`.

The extension is enabled by default with these local defaults:

- Username: `vu2student`
- Password: `vu2student`
- Auto-accept network terms: on

Change the credentials in the popup and choose **Save credentials**. Settings are stored in `chrome.storage.local`.

## Behaviour

- Targets the gateway at `10.25.0.1` (all ports, including the `:1000/keepalive` page).
- Also inspects HTTP captive redirects, but only acts on pages that match captive-portal signals. Generic HTTP login pages are not filled.
- Watches the DOM with a `MutationObserver` so asynchronously rendered forms and buttons are handled.
- Marks processed elements with `data-autologin-processed="true"` and uses page-level guards to avoid duplicate clicks and submissions.
- Explicitly excludes any continue control whose text, `href`, or identifying attributes contain logout/sign-out language.
- Opens an external keepalive continuation link in a new tab so the keepalive page remains open in the background.
- Shows a compact privacy & terms agreement inside the popup on install or browser startup when consent is missing or outdated. If Chrome cannot open the popup automatically, the toolbar icon keeps a `!` badge.
- Pauses all automation, including the manual trigger, until consent is stored. Consent can be reviewed or withdrawn from the popup footer.
- Does not close tabs and does not use remote servers or analytics.

## Permissions

| Permission | Why it is needed |
| --- | --- |
| `storage` | Save credentials and extension preferences locally. |
| `activeTab` | Let **Trigger login now** scan the current tab after a user gesture. |
| `scripting` | Inject the automation script after a manual trigger when no content script is present. |
| `*://10.25.0.1/*` | Automate the configured captive gateway on any port. |
| `http://*/*` | Catch fallback HTTP captive redirects. Access is gated by portal detection. |

## Files

- `manifest.json` — Manifest V3 configuration, background worker, and content-script matching.
- `background.js` — sets the `!` toolbar badge and opens the popup on install/startup when consent is missing or outdated.
- `content.js` — consent gating, portal detection, login, keepalive, terms handling, observer, and messages.
- `popup.html`, `popup.css`, `popup.js` — dashboard UI, compact agreement, consent review/withdrawal, storage sync, and manual trigger.
- `icons/` — extension icons.

## Consent storage

- Consent is stored in `chrome.storage.local` under `vuConsent` as an accepted flag, terms version, and acceptance timestamp.
- The popup and content script validate both the flag and the current terms version. An older acceptance is treated as not accepted, so the in-popup agreement reappears after a terms update.
- Consent can be reviewed or withdrawn from the Privacy & terms button in the popup footer.
- Withdrawing consent pauses automation immediately but leaves saved credentials intact. To delete everything, remove the extension or clear its storage.

## Notes

- The keepalive page must remain open for the network session to stay alive.
- Credentials are saved unencrypted in Chrome's local extension storage. Use this extension only on a trusted device.
- If automation is paused in the popup, **Trigger login now** still performs a single explicit scan after consent has been accepted.

---


## Author

Ojas Deshpande [contact@ojasdeshpande.in]