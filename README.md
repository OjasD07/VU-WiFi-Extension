<a href="https://www.ojasdeshpande.in" target="_blank"><img src="https://raw.githubusercontent.com/OjasD07/OjasD07/main/Logo.svg" alt="Logo" style="float: right; width: 88px; height: 88px; background: #ffffff; border-radius: 10px; padding: 8px; margin: 0 0 8px 8px;" /></a>


# VU Wi-Fi Auto Login

A zero-dependency Chrome extension (Manifest V3) that automates the VU Wi-Fi captive portal flow:

1. Fills the campus login form and submits it.
2. Dismisses the authentication keepalive page without clicking logout or closing the keepalive tab.
3. Checks the network policy checkbox and accepts the terms.

## Install

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this folder.
4. Open the VU Wi-Fi portal once and sign in. The extension fills and submits the form automatically.

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

- `manifest.json` — Manifest V3 configuration and content-script matching.
- `content.js` — portal detection, login, keepalive, terms handling, observer, and messages.
- `popup.html`, `popup.css`, `popup.js` — dashboard UI, storage sync, and manual trigger.
- `icons/` — extension icons.

## Notes

- The keepalive page must remain open for the network session to stay alive.
- Credentials are saved unencrypted in Chrome's local extension storage. Use this extension only on a trusted device.
- If the automatic flow is paused, **Trigger login now** still performs a single explicit scan.

--


## Author

Ojas Deshpande [contact@ojasdeshpande.in]