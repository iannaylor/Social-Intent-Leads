// The side panel is only useful on a LinkedIn tab — everywhere else it's
// just in the way. This makes it per-tab: enabled (and open) only while a
// LinkedIn tab is active, disabled (which auto-closes it) on every other
// tab. Clicking the toolbar icon on a non-LinkedIn tab navigates that tab
// to LinkedIn and opens the panel at the same time, instead of requiring a
// manual "go to LinkedIn first" step.

const LINKEDIN_URL = "https://www.linkedin.com/feed/";

function isLinkedInUrl(url) {
  return !!url && /^https:\/\/(www\.)?linkedin\.com\//.test(url);
}

// Guards against calling setOptions redundantly on every single URL
// change within an already-LinkedIn tab (e.g. clicking between posts or
// notifications navigates via the History API, which still fires
// tabs.onUpdated with a new URL) — unconfirmed whether re-setting to the
// SAME enabled/path values resets the already-open panel's page and
// drops any in-flight state, but there's no reason to risk it when the
// state genuinely isn't changing.
const _lastEnabledForTab = new Map();

function setPanelEnabledForTab(tabId, url) {
  const enabled = isLinkedInUrl(url);
  if (_lastEnabledForTab.get(tabId) === enabled) return;
  _lastEnabledForTab.set(tabId, enabled);
  chrome.sidePanel
    .setOptions({ tabId, path: "popup.html", enabled })
    .catch(() => {}); // tab may have closed mid-update — safe to ignore
}

// Keep every tab's panel state in sync as URLs change or tabs are switched.
// chrome.tabs.onUpdated is the authoritative signal for this — it fires on
// EVERY URL change Chrome recognizes, including in-page History API
// navigation (which is how a LinkedIn notification click moves you to a
// different post without a real page load), regardless of which internal
// method the page's own SPA router used to trigger it. content.js trying
// to self-detect that same navigation (patching history.pushState, a
// MutationObserver, even polling its own location.href) proved
// unreliable in practice — this pushes an explicit "recheck now" signal
// into the content script instead of hoping it notices on its own.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url !== undefined || changeInfo.status === "complete") {
    setPanelEnabledForTab(tabId, tab.url);
  }
  if (changeInfo.url !== undefined && isLinkedInUrl(changeInfo.url)) {
    chrome.tabs.sendMessage(tabId, { type: "SOCIAL_INTENT_RECHECK" }).catch(() => {});
  }
});
chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId, (tab) => {
    if (!chrome.runtime.lastError && tab) setPanelEnabledForTab(tabId, tab.url);
  });
});
chrome.tabs.onRemoved.addListener((tabId) => _lastEnabledForTab.delete(tabId));

// Sweep already-open tabs on install/reload so a stale "enabled by
// default" state (from the manifest's default_path) doesn't linger on
// non-LinkedIn tabs that were already open before this ran.
function sweepAllTabs() {
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach((tab) => setPanelEnabledForTab(tab.id, tab.url));
  });
}
chrome.runtime.onInstalled.addListener(sweepAllTabs);
chrome.runtime.onStartup.addListener(sweepAllTabs);

// Deliberately no setPanelBehavior({openPanelOnActionClick: true}) — that
// mode always just opens the panel for whatever tab is active, with no
// chance to redirect a non-LinkedIn tab first. Handling the click manually
// instead.
//
// sidePanel.open() must be called synchronously within the click's own
// user-gesture — `await`ing ANYTHING before it, even a fast setOptions
// call, was enough to expire the gesture and throw "may only be called in
// response to a user gesture" (confirmed live). Fixed by not awaiting
// either call: both are issued back-to-back in the same synchronous tick,
// so open() still runs inside the gesture, and Chrome processes same-tab
// side panel calls in the order they were issued regardless.
chrome.action.onClicked.addListener((tab) => {
  const onLinkedIn = isLinkedInUrl(tab.url);
  chrome.sidePanel.setOptions({ tabId: tab.id, path: "popup.html", enabled: true }).catch(() => {});
  chrome.sidePanel.open({ tabId: tab.id }).catch((e) => console.error("[social-intent] sidePanel.open failed:", e));
  if (!onLinkedIn) {
    chrome.tabs.update(tab.id, { url: LINKEDIN_URL });
  }
});
