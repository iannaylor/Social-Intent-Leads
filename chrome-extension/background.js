// The side panel is only useful on a LinkedIn tab — everywhere else it's
// just in the way. This makes it per-tab: enabled (and open) only while a
// LinkedIn tab is active, disabled (which auto-closes it) on every other
// tab. Clicking the toolbar icon on a non-LinkedIn tab opens LinkedIn in a
// NEW tab instead of requiring a manual "go to LinkedIn first" step —
// deliberately tabs.create(), not tabs.update(): the user's existing tab
// and whatever they're looking at there must never be hijacked out from
// under them just because they clicked the extension icon.

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
  if (onLinkedIn) {
    chrome.sidePanel.setOptions({ tabId: tab.id, path: "popup.html", enabled: true }).catch(() => {});
    chrome.sidePanel.open({ tabId: tab.id }).catch((e) => console.error("[social-intent] sidePanel.open failed:", e));
    return;
  }
  // Not on LinkedIn: open it in a new tab, never touch the current one.
  // The new tab's real tab id isn't known synchronously (tabs.create() is
  // async), and awaiting it before calling sidePanel.open() would expire
  // this click's user-gesture window — same constraint documented above
  // for the same-tab case. Opening by windowId instead of tabId sidesteps
  // that: it doesn't need the new tab's id up front, and
  // setPanelEnabledForTab (wired to onActivated/onUpdated below) enables
  // the panel correctly once Chrome reports the new tab's real state.
  // NEEDS LIVE VERIFICATION — untested against Chrome's actual behavior
  // when the window's currently-active tab has the panel disabled at the
  // moment open() fires; report back what actually happens.
  chrome.sidePanel.open({ windowId: tab.windowId }).catch((e) => console.error("[social-intent] sidePanel.open failed:", e));
  chrome.tabs.create({ url: LINKEDIN_URL });
});

// Voice-brief post scraping: popup.js can't scrape posts itself (no DOM
// access, and the posts live on a page that may not even be open yet) —
// this opens the user's own recent-activity page in a background tab,
// asks content.js there to scrape it, and closes the tab when done. Never
// steals focus (active: false) and never touches whatever tab/panel the
// user actually has open.
function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function _waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Timed out waiting for the page to load"));
    }, timeoutMs);
    function listener(id, changeInfo) {
      if (id === tabId && changeInfo.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// NEEDS LIVE VERIFICATION — both the recent-activity URL shape (LinkedIn
// has changed this path before) and the post-load timing below are
// untested against a real browser.
function _recentActivityUrl(profileUrl) {
  return `${profileUrl.replace(/\/+$/, "")}/recent-activity/all/`;
}

async function _scrapeOwnPostsInBackgroundTab(profileUrl, limit) {
  const tab = await chrome.tabs.create({ url: _recentActivityUrl(profileUrl), active: false });
  await _waitForTabComplete(tab.id, 15000);
  // "complete" only means the initial page load finished — LinkedIn's SPA
  // content (the actual posts) renders in asynchronously after that, same
  // reasoning as content.js's own staggered _onNavigation re-checks
  // elsewhere in this codebase. Retry with growing delays rather than a
  // single fixed wait.
  for (const delay of [1500, 3000, 5000]) {
    await _sleep(delay);
    const resp = await chrome.tabs.sendMessage(tab.id, { type: "SOCIAL_INTENT_SCRAPE_POSTS", limit }).catch(() => null);
    if (resp && resp.posts && resp.posts.length > 0) {
      chrome.tabs.remove(tab.id).catch(() => {});
      return resp.posts;
    }
  }
  // Deliberately NOT removing the tab here, unlike the success path above
  // — if scraping found nothing, closing it immediately makes this
  // undiagnosable. Left open so DevTools can be opened on it directly;
  // its console has "[social-intent] scrape:" lines saying exactly what
  // was and wasn't found.
  console.warn(`[social-intent] post scraping found nothing on tab ${tab.id} — left open for inspection`);
  return [];
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "SOCIAL_INTENT_SCRAPE_OWN_POSTS") {
    _scrapeOwnPostsInBackgroundTab(msg.profileUrl, msg.limit || 5)
      .then((posts) => sendResponse({ ok: true, posts }))
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
    return true; // keep the message channel open for the async response
  }
});
