<a href="https://www.ojasdeshpande.in" target="_blank"><img src="https://raw.githubusercontent.com/OjasD07/OjasD07/main/Logo.svg" alt="Logo" style="float: right; width: 88px; height: 88px; background: #ffffff; border-radius: 10px; padding: 8px; margin: 0 0 8px 8px;" /></a>


# VU Wi-Fi Auto Login Extension

A zero-dependency Chrome extension (Manifest V3) that automates the VU Wi-Fi captive portal flow:

1. Fills the campus login form and submits it.
2. Dismisses the authentication keepalive page without clicking logout or closing the keepalive tab.
3. Checks the network policy checkbox and accepts the terms.

On install and browser startup, a Privacy & Terms page opens until the current terms version is accepted. Automation stays paused until then.

## Install

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this folder.
4. Review and accept the Privacy & Terms page that opens, then open the VU Wi-Fi portal once and sign in. The extension fills and submits the form automatically.

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
- Opens the Privacy & Terms agreement on install or browser startup until the current terms version is accepted.
- Pauses all automation, including the manual trigger, until consent is stored. Consent can be withdrawn from the Privacy & Terms page.
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
- `background.js` — opens the Privacy & Terms page on install/startup when consent is missing or outdated.
- `content.js` — consent gating, portal detection, login, keepalive, terms handling, observer, and messages.
- `popup.html`, `popup.css`, `popup.js` — dashboard UI, consent gate, storage sync, and manual trigger.
- `privacy.html`, `privacy.css`, `privacy.js` — Privacy & Terms page, consent storage, and withdrawal flow.
- `icons/` — extension icons.

## Consent storage

- Consent is stored in `chrome.storage.local` under `vuConsent` as an accepted flag, terms version, and acceptance timestamp.
- The popup and content script validate both the flag and the current terms version. An older acceptance is treated as not accepted, so the page reopens after a terms update.
- Withdrawing consent pauses automation immediately but leaves saved credentials intact. To delete everything, remove the extension or clear its storage.

## Notes

- The keepalive page must remain open for the network session to stay alive.
- Credentials are saved unencrypted in Chrome's local extension storage. Use this extension only on a trusted device.
- If automation is paused in the popup, **Trigger login now** still performs a single explicit scan after consent has been accepted.

---


## Author

Ojas Deshpande [contact@ojasdeshpande.in]