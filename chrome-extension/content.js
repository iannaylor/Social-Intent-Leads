// Runs on every LinkedIn page. Two jobs:
//  1. Identify which post (by LinkedIn's numeric activity ID) the user is
//     currently looking at, regardless of which of LinkedIn's several URL
//     formats got them there (a direct /posts/ link vs a notification's
//     /feed/update/urn:li:ugcPost:.../ link both point at the same post).
//  2. If our own comment is visible on the page, look for a reply nested
//     under it and scrape the reply author + text.
//
// LinkedIn is a single-page app — most navigation between posts happens via
// history.pushState, not a real page load, so document_idle alone isn't
// enough; a MutationObserver re-checks after DOM changes settle.
//
// A content script only injects into tabs that load/navigate AFTER the
// extension itself (re)loads — an already-open LinkedIn tab needs an
// actual page refresh (Cmd+R), not just "reload extension", before this
// runs on it for the first time.
//
// Detection strategy: rather than guessing LinkedIn's current CSS module
// class names (they change often and can't be verified from outside a
// live browser), this hooks off something structurally guaranteed —
// LinkedIn always links a commenter's visible name to their profile
// (an <a href="...linkedin.com/in/...">). That's a far more stable
// anchor than a class name. Every step logs to the console under the
// "[social-intent]" prefix — if detection isn't firing, open DevTools
// Console on the LinkedIn tab and see exactly which step came up empty.

// Set via the extension's Settings screen ("Your name") — NOT hardcoded,
// since this is what every reply-detection function uses to tell "our
// own comment" apart from everyone else's. Loaded async from
// chrome.storage on script start; detection functions below no-op with a
// log line until it's actually set, rather than silently matching
// nothing (or worse, matching the wrong person) if left unconfigured.
let OWN_NAME = null;
const LOG_PREFIX = "[social-intent]";

function log(...args) {
  console.log(LOG_PREFIX, ...args);
}

chrome.storage.local.get(["ownDisplayName"], (r) => {
  OWN_NAME = r.ownDisplayName || null;
  if (!OWN_NAME) {
    log("no 'Your name' set in Settings yet — reply/notification detection is disabled until it is");
  } else {
    log(`own display name loaded from Settings: "${OWN_NAME}"`);
    _report();
  }
});
// Picks up a name change immediately if Settings is edited while this tab
// is already open, instead of requiring a page refresh.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.ownDisplayName) {
    OWN_NAME = changes.ownDisplayName.newValue || null;
    log(`own display name updated: "${OWN_NAME}"`);
    if (OWN_NAME) _report();
  }
});

function _extractActivityId(url) {
  const patterns = [
    /activity[:-](\d+)/, // /posts/user_slug-activity-1234567890-abcd
    /urn:li:ugcPost:(\d+)/, // /feed/update/urn:li:ugcPost:1234567890/
    /urn%3Ali%3AugcPost%3A(\d+)/, // same, URL-encoded
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) return m[1];
  }
  return null;
}

function _cleanText(el) {
  return (el && el.textContent ? el.textContent : "").replace(/\s+/g, " ").trim();
}

// Walk up from a starting element until the accumulated text looks like
// "one comment's worth" rather than either just the name (too short) or
// the entire comments section (too long). Same heuristic used for both
// our own comment and a reply, just with different anchor elements.
function _boundedContainer(start, minLen, maxLen, maxDepth) {
  let el = start;
  for (let depth = 0; depth < maxDepth && el.parentElement; depth++) {
    el = el.parentElement;
    const len = _cleanText(el).length;
    if (len > minLen && len < maxLen) return el;
  }
  return el;
}

// Live-tested finding (2026-07-17): our own name is NOT hyperlinked in our
// own comment's author heading (LinkedIn doesn't link your own profile),
// but WHEN SOMEONE REPLIES TO US, LinkedIn renders an "@Ian Naylor" mention
// as a hyperlink inline at the start of their reply body. So every
// a[href*="/in/"] whose text is exactly our name is, in practice, a mention
// inside someone else's reply — that IS the signal, not a false positive to
// filter out. Anchor directly on it instead of trying to find our own
// comment first.
// Best-effort scrape of the main post body — several selector fallbacks
// since LinkedIn's feed post markup varies by post type (text, video,
// article share). Not required for a reply draft to work (the backend
// falls back gracefully), just useful extra context when available.
const _POST_DESCRIPTION_SELECTORS = [
  ".feed-shared-update-v2__description .break-words",
  ".feed-shared-text .break-words",
  ".feed-shared-update-v2__description",
  "article .break-words",
];

function _findPostText() {
  for (const sel of _POST_DESCRIPTION_SELECTORS) {
    const el = document.querySelector(sel);
    if (el) {
      const t = _cleanText(el);
      if (t.length > 20) return t;
    }
  }
  return null;
}

function _extractCardText(card) {
  for (const sel of _POST_DESCRIPTION_SELECTORS) {
    const el = card.querySelector(sel);
    if (el) {
      const t = _cleanText(el);
      if (t.length > 20) return t;
    }
  }
  return null;
}

// Voice-brief scraping: reads the CALLER's own recent posts directly off
// their own recent-activity page, in their own already-logged-in browser
// — deliberately NOT via RichAPI. RichAPI exists to find OTHER people's
// posts for prospecting; there's no reason to route a read of your OWN
// posts, while your own browser is already sitting on the page, through a
// third-party API that can rate-limit or time out.
//
// Two detection strategies, tried in order — the recent-activity listing
// page's exact markup wasn't observable before writing this (no way to
// run a live browser), so this tries the same link-based approach
// _scanFeedForIntentMatches uses on the main feed first, then falls back
// to matching post-card CONTAINERS directly (LinkedIn reuses the same
// feed-rendering component, .feed-shared-update-v2, across the main feed,
// profile activity, and search results) in case this page's permalinks
// don't share the main feed's href pattern. Logs enough at every step to
// diagnose from the console without another round-trip if both fail.
function _scrapeOwnRecentPosts(limit) {
  const posts = [];

  const postLinks = Array.from(document.querySelectorAll('a[href*="/feed/update/"], a[href*="/posts/"]'));
  log(`scrape: found ${postLinks.length} post permalink(s) via link selector`);
  const seenActivityIds = new Set();
  for (const link of postLinks) {
    if (posts.length >= limit) break;
    const activityId = _extractActivityId(link.getAttribute("href") || "");
    if (!activityId || seenActivityIds.has(activityId)) continue;
    seenActivityIds.add(activityId);
    let card = link;
    for (let depth = 0; depth < 12 && card.parentElement; depth++) {
      card = card.parentElement;
      if (_cleanText(card).length > 150) break;
    }
    const text = _extractCardText(card);
    if (text) posts.push(text);
  }

  if (posts.length === 0) {
    const cards = Array.from(document.querySelectorAll(".feed-shared-update-v2, article"));
    log(`scrape: link-based approach found 0 posts, falling back to ${cards.length} card container(s)`);
    for (const card of cards) {
      if (posts.length >= limit) break;
      const text = _extractCardText(card);
      if (text) posts.push(text);
    }
  }

  if (posts.length === 0) {
    const sampleHrefs = Array.from(document.querySelectorAll("a[href]")).slice(0, 15).map((a) => a.getAttribute("href"));
    log("scrape: found 0 posts via either strategy. Sample hrefs on page:", sampleHrefs);
  }

  log(`scraped ${posts.length} post(s) for voice brief`);
  return posts;
}

// Our own top-level comment's author name isn't hyperlinked (LinkedIn
// doesn't link your own profile — confirmed via live testing), so this
// looks for a short, unlinked, exact-name heading instead of a profile
// link, then grabs the body text right after it.
function _findOwnCommentText() {
  if (!OWN_NAME) return null;
  const candidates = Array.from(document.querySelectorAll("span, div, a")).filter((el) => {
    if (el.children.length > 0) return false; // want a leaf text node's element, not a wrapper
    const t = _cleanText(el);
    return t === OWN_NAME;
  });
  for (const heading of candidates) {
    let el = heading;
    for (let depth = 0; depth < 6 && el.parentElement; depth++) {
      el = el.parentElement;
      const t = _cleanText(el);
      if (t.length > OWN_NAME.length + 15 && t.length < 2000) {
        const body = t.startsWith(OWN_NAME) ? t.slice(OWN_NAME.length).trim() : t;
        if (body) return body;
      }
    }
  }
  return null;
}

// Climb one ancestor level at a time (rather than jumping straight to a
// text-length target) until an ancestor contains a profile link that
// ISN'T us — that's the reply's real author heading, which live testing
// showed sits as a sibling block ABOVE the reply paragraph, not tightly
// wrapped around it. Capped by both depth AND text length so a thread
// with no nearby distinct author doesn't keep climbing all the way to
// some unrelated post/comment elsewhere on the page.
function _findReplyAuthorNear(mentionLink, maxDepth, maxWrapperTextLen) {
  let el = mentionLink;
  for (let depth = 0; depth < maxDepth && el.parentElement; depth++) {
    el = el.parentElement;
    const wrapperText = _cleanText(el);
    if (wrapperText.length > maxWrapperTextLen) {
      log(`    climbed to depth ${depth}, text length ${wrapperText.length} exceeds cap, stopping`);
      return null;
    }
    const links = Array.from(el.querySelectorAll('a[href*="/in/"]'));
    // LinkedIn also wraps the avatar image in a profile link with no text
    // content — skip those, or an image-only link wins the search before
    // the actual name link even gets checked.
    const other = links.find((a) => {
      const t = _cleanText(a);
      return t && t !== OWN_NAME;
    });
    if (other) {
      log(`    found distinct author link "${_cleanText(other)}" at depth ${depth} (wrapper text length ${wrapperText.length})`);
      return other;
    }
  }
  return null;
}

function _findOwnCommentReplies() {
  if (!OWN_NAME) return [];
  const mentionLinks = Array.from(document.querySelectorAll('a[href*="/in/"]')).filter(
    (a) => _cleanText(a) === OWN_NAME
  );
  log(`found ${mentionLinks.length} link(s) reading exactly "${OWN_NAME}" (mentions inside a reply to us)`);

  const results = [];
  mentionLinks.forEach((mentionLink, i) => {
    // Bounded to roughly "one reply's worth" of text (the mention plus
    // the rest of that reply's body, not the whole thread).
    const bodyContainer = _boundedContainer(mentionLink, OWN_NAME.length + 5, 2000, 5);
    const bodyText = _cleanText(bodyContainer);
    log(`mention #${i}: reply body = "${bodyText.slice(0, 150)}"`);

    const authorLink = _findReplyAuthorNear(mentionLink, 12, 2500);
    if (!authorLink) {
      log(`  no distinct author found within climb/text caps — skipping`);
      return;
    }

    const replyAuthor = _cleanText(authorLink);
    const replyText = bodyText.replace(new RegExp(`^${OWN_NAME}\\s*`), "").trim();
    log(`  => reply from "${replyAuthor}": "${replyText.slice(0, 150)}"`);
    if (replyText) results.push({ replyAuthor, replyText });
  });
  return results;
}

let lastReportedUrl = null;
let lastReportedReplySignature = null;
let lastActivityId = null;
// Push messages (sendMessage) are one-shot and silently lost if the side
// panel isn't actively listening at the exact instant they're sent — no
// retry, no queueing. Caching the latest findings here lets the panel
// PULL current state on demand instead (query-response, via
// SOCIAL_INTENT_QUERY_STATE below), which can't be missed the same way:
// it just asks "what do you see right now" whenever it actually needs to
// know, rather than hoping a push happened to land at the right moment.
let latestState = { activityId: null, replies: [], postText: null, ownComment: null };

// ---------- NOTIFICATIONS PAGE SCANNING ----------
// LinkedIn's notification feed is a heterogeneous, lazy-loaded list — job
// suggestions, connection updates, likes, "suggested for you" content,
// AND comment replies/mentions all mixed together. Deliberately scoped to
// just "X mentioned you in a comment" / "X replied to your comment" —
// the two phrasings LinkedIn uses for someone engaging with a comment
// thread we're in. Passive: doesn't auto-scroll, just captures whatever
// is currently rendered as the user scrolls themselves.
const _reportedNotifications = new Set();

function _scanNotifications() {
  // Live testing showed 0 of the notification cards are <article>/<li>
  // (they're almost certainly plain <div>s), while the phrase IS present
  // in the page's text. Tag-agnostic fix: walk actual TEXT NODES for the
  // phrase directly, then climb from wherever it's found to a
  // card-sized container — same _boundedContainer helper already used
  // for comment threads, works regardless of what tag wraps it.
  const pattern = /mentioned you in a comment|replied to your comment/i;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (pattern.test(node.textContent) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
  });
  const textNodes = [];
  let node;
  while ((node = walker.nextNode())) textNodes.push(node);
  log(`found ${textNodes.length} text node(s) directly containing the phrase`);

  const found = [];
  textNodes.forEach((textNode, idx) => {
    const startEl = textNode.parentElement;
    if (!startEl) return;
    let card = startEl;
    for (let depth = 0; depth < 10 && card.parentElement; depth++) {
      card = card.parentElement;
      if (_cleanText(card).length > 800) break;
    }
    const cardText = _cleanText(card);
    const allLinks = Array.from(card.querySelectorAll("a"));

    // Ground truth from live testing: the /in/... profile link is
    // avatar-only (no text). The actual name lives INSIDE the big
    // feed/update link's own text — LinkedIn renders the whole
    // clickable area as one <a> whose text is literally "PersonName
    // mentioned you in a comment", name and phrase together. Extract the
    // name by stripping the known suffix phrase off that link's text,
    // instead of hunting for a separate name element that doesn't exist.
    const link = allLinks.find((a) => /\/feed\/update\/|\/posts\//.test(a.getAttribute("href") || ""));
    if (!link) { log(`candidate #${idx}: no feed/update or posts link found, skipping`); return; }
    const linkText = _cleanText(link);
    const name = linkText.replace(/\s*(mentioned you in a comment|replied to your comment)\.?.*$/i, "").trim();
    const url = link.href;
    log(`candidate #${idx}: link text "${linkText.slice(0, 60)}" -> extracted name "${name}"`);
    if (!name || !url) return;

    const key = name + "|" + url;
    if (_reportedNotifications.has(key)) return;
    _reportedNotifications.add(key);
    found.push({ name, url, snippet: cardText.slice(0, 300) });
  });
  log(`${found.length} of ${textNodes.length} candidate(s) had both a name and a link`);

  if (found.length) {
    log(`sending ${found.length} new notification(s) to extension`, found);
    chrome.runtime.sendMessage({ type: "SOCIAL_INTENT_NOTIFICATIONS_FOUND", items: found }).catch(() => {});
  }
}

function _report() {
  if (location.pathname.startsWith("/notifications")) {
    _scanNotifications();
    return; // no single "post" on this page to run reply-detection against
  }

  const activityId = _extractActivityId(location.href);
  if (!activityId) {
    log("no activity ID extracted from URL, skipping:", location.href);
    return;
  }

  if (activityId !== lastActivityId) {
    // A genuinely different post — tell the side panel right away so it
    // can drop any banner left over from whatever post was open before,
    // rather than leaving stale content showing until a fresh reply (if
    // any) happens to be found on THIS post. Also reset the reply dedupe
    // key, since it's scoped per-post and a same-looking reply on a new
    // post shouldn't be treated as "already reported."
    lastActivityId = activityId;
    lastReportedReplySignature = null;
    chrome.runtime.sendMessage({ type: "SOCIAL_INTENT_POST_CHANGED", activityId }).catch(() => {});
  }

  if (location.href !== lastReportedUrl) {
    lastReportedUrl = location.href;
    log("post detected, activityId =", activityId);
    chrome.runtime.sendMessage({
      type: "SOCIAL_INTENT_POST_DETECTED",
      activityId,
      url: location.href,
    }).catch(() => {}); // side panel may not be open — fine, just no listener
  }

  const replies = _findOwnCommentReplies();
  if (replies.length) {
    const postText = _findPostText();
    const ownComment = _findOwnCommentText();
    latestState = { activityId, replies, postText, ownComment };

    const signature = activityId + "|" + replies.map((r) => r.replyAuthor + r.replyText).join("|");
    if (signature !== lastReportedReplySignature) {
      lastReportedReplySignature = signature;
      log(`postText scraped: ${postText ? `"${postText.slice(0, 100)}..."` : "(none found)"}`);
      log(`ownComment scraped: ${ownComment ? `"${ownComment.slice(0, 100)}..."` : "(none found)"}`);
      log(`sending ${replies.length} reply(ies) to extension`, replies);
      chrome.runtime.sendMessage({
        type: "SOCIAL_INTENT_REPLY_DETECTED",
        activityId,
        url: location.href,
        replies,
        postText,
        ownComment,
      }).catch(() => {});
    }
  } else {
    log("no replies found on this pass");
    if (latestState.activityId === activityId) {
      // Nothing found on a later pass for the SAME post that had a stale
      // cached reply — not expected in practice (replies don't
      // disappear), but avoid ever serving stale content for a query.
      latestState = { activityId, replies: [], postText: null, ownComment: null };
    }
  }
}

// ---------- LIVE BROWSING OVERLAY (opt-in, off by default) ----------
// Highlights posts anywhere on LinkedIn (feed, search results, a
// profile's activity) that mention one of your products' known intent
// keywords. Deliberately client-side keyword matching only, not an AI
// score — free, instant, no per-post backend call while scrolling a
// feed full of posts. A visual nudge while casually browsing, not a
// replacement for the scored/drafted pipeline.
let overlayEnabled = false;
let cachedProductKeywords = null; // [{name, keywords: [...], highIntentKeywords: [...]}]
const _overlayMarked = new WeakSet();

function _loadOverlaySettings() {
  chrome.storage.local.get(["liveOverlayEnabled", "backendUrl", "backendApiKey"], (r) => {
    overlayEnabled = !!r.liveOverlayEnabled;
    if (overlayEnabled && r.backendUrl && r.backendApiKey && !cachedProductKeywords) {
      _fetchProductKeywords(r.backendUrl.replace(/\/+$/, ""), r.backendApiKey);
    }
  });
}
_loadOverlaySettings();
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && (changes.liveOverlayEnabled || changes.backendUrl || changes.backendApiKey)) {
    if (changes.backendUrl || changes.backendApiKey) cachedProductKeywords = null; // force a re-fetch
    _loadOverlaySettings();
  }
});

function _fetchProductKeywords(backendUrl, apiKey) {
  fetch(`${backendUrl}/products`, { headers: { Authorization: `Bearer ${apiKey}` } })
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then((data) => {
      const split = (s) => (s || "").split(",").map((k) => k.trim()).filter(Boolean);
      cachedProductKeywords = (data.products || []).map((p) => ({
        name: p.name || p.key,
        highIntentKeywords: split(p.highIntentKeywords),
        keywords: [...split(p.broadKeywords), ...split(p.highIntentKeywords)],
      }));
      log(`overlay: cached keywords for ${cachedProductKeywords.length} product(s)`);
    })
    .catch((e) => log("overlay: failed to load product keywords:", e));
}

function _scanFeedForIntentMatches() {
  if (!overlayEnabled || !cachedProductKeywords || !cachedProductKeywords.length) return;

  const postLinks = Array.from(document.querySelectorAll('a[href*="/feed/update/"], a[href*="/posts/"]'));
  const seenActivityIds = new Set();

  postLinks.forEach((link) => {
    const activityId = _extractActivityId(link.getAttribute("href") || "");
    if (!activityId || seenActivityIds.has(activityId)) return;
    seenActivityIds.add(activityId);

    // Climb to a post-card-sized container — same proven technique as
    // notification cards, just with a bigger target size since a full
    // feed post's text is longer than a one-line notification.
    let card = link;
    let cardText = "";
    for (let depth = 0; depth < 12 && card.parentElement; depth++) {
      card = card.parentElement;
      cardText = _cleanText(card);
      if (cardText.length > 150) break;
      if (cardText.length > 4000) return; // climbed too far, bail rather than mismark a huge chunk
    }
    if (cardText.length < 50 || _overlayMarked.has(card)) return;

    const haystack = cardText.toLowerCase();
    let bestMatch = null;
    for (const product of cachedProductKeywords) {
      const strongHit = product.highIntentKeywords.find((kw) => haystack.includes(kw.toLowerCase()));
      const hit = strongHit || product.keywords.find((kw) => haystack.includes(kw.toLowerCase()));
      if (hit) {
        bestMatch = { product: product.name, keyword: hit, strong: !!strongHit };
        if (strongHit) break;
      }
    }

    if (bestMatch) {
      _overlayMarked.add(card);
      _injectOverlayBadge(card, bestMatch);
    }
  });
}

function _injectOverlayBadge(card, match) {
  if (getComputedStyle(card).position === "static") card.style.position = "relative";
  const color = match.strong ? "#d32f2f" : "#0a66c2";
  const badge = document.createElement("div");
  badge.textContent = `🎯 ${match.product} — "${match.keyword}"`;
  badge.title = "Social Intent Comment Queue — client-side keyword match, not a full AI score";
  badge.style.cssText = `
    position: absolute; top: 4px; right: 4px; z-index: 9999;
    background: ${color}; color: white; font-size: 11px; padding: 3px 8px;
    border-radius: 10px; font-family: -apple-system, sans-serif;
    pointer-events: none; box-shadow: 0 1px 3px rgba(0,0,0,0.3);
  `;
  card.appendChild(badge);
  card.style.outline = `2px solid ${color}`;
  card.style.outlineOffset = "2px";
}

// Debounced re-check on DOM mutation, since comments/replies often load in
// asynchronously after the initial page paint. On its own this isn't
// reliable enough for navigation specifically — LinkedIn is a constantly-
// mutating SPA (notification badges, chat widget, ads), so an unrelated
// burst of mutations elsewhere on the page can keep resetting the
// debounce and delay a real navigation's re-check well past when the
// user is already looking at the new post. History patching below
// detects the URL change itself, decoupled from DOM churn timing, and
// fires a few staggered checks to catch content that loads in async.
let debounceTimer = null;
const observer = new MutationObserver(() => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    _report();
    _scanFeedForIntentMatches();
  }, 800);
});
observer.observe(document.body, { childList: true, subtree: true });
_scanFeedForIntentMatches();

function _onNavigation(source) {
  log(`navigation detected via ${source}, scheduling re-checks`);
  // Staggered and fairly generous — comments/replies on a freshly-
  // navigated post (especially a deep link to a specific comment, which
  // can involve an extra scroll-to/highlight step) don't all render at
  // once, and live testing showed content already fully visible on
  // screen still wasn't caught by earlier, tighter timing.
  [300, 1000, 2500, 5000, 8000].forEach((delay) => setTimeout(_report, delay));
}

// Belt and suspenders: patch history.pushState/replaceState in case
// LinkedIn's router uses them directly...
const _origPushState = history.pushState;
history.pushState = function (...args) {
  const result = _origPushState.apply(this, args);
  _onNavigation("pushState");
  return result;
};
const _origReplaceState = history.replaceState;
history.replaceState = function (...args) {
  const result = _origReplaceState.apply(this, args);
  _onNavigation("replaceState");
  return result;
};
window.addEventListener("popstate", () => _onNavigation("popstate"));

// ...but don't rely on that alone — live testing showed navigating via a
// notification click still wasn't detected even with the above in place,
// which most likely means LinkedIn's router doesn't call these directly
// (many SPA frameworks wrap or bypass them). Polling the URL is blunter
// but can't miss anything regardless of what internal mechanism changed
// it — this is the primary, reliable detector; history patching above is
// just a faster-reacting bonus on top when it happens to fire.
let lastPolledUrl = location.href;
setInterval(() => {
  if (location.href !== lastPolledUrl) {
    lastPolledUrl = location.href;
    _onNavigation("URL poll");
  }
}, 1000);

// Most authoritative navigation signal: background.js watches
// chrome.tabs.onUpdated, which Chrome fires reliably on every URL change
// it recognizes for this tab, independent of anything happening inside
// the page's own JS. The three detectors above are extra redundancy in
// case this message ever fails to arrive.
//
// SOCIAL_INTENT_QUERY_STATE is the pull half of the fix: the panel can
// ask at any time "what do you currently see", getting latestState back
// synchronously, rather than depending on a one-shot push having landed
// while it happened to be listening.
if (chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === "SOCIAL_INTENT_RECHECK") {
      _onNavigation("background.js tabs.onUpdated");
    } else if (msg && msg.type === "SOCIAL_INTENT_QUERY_STATE") {
      sendResponse(latestState);
    } else if (msg && msg.type === "SOCIAL_INTENT_SCRAPE_POSTS") {
      sendResponse({ posts: _scrapeOwnRecentPosts(msg.limit || 5) });
    }
  });
}

log("content script loaded on", location.href);
_report();
