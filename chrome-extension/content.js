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

// Every reload of the extension orphans any content script instance
// already injected into an already-open tab — its chrome.runtime binding
// is dead, but the script itself keeps running until that tab gets a real
// page refresh (documented at the top of this file). If an orphaned
// instance then tries to send a message, chrome.runtime.sendMessage can
// throw "Extension context invalidated" SYNCHRONOUSLY, before even
// returning a promise — a plain .catch() on the call doesn't catch that,
// only wrapping the call itself does. Harmless and expected (confirmed
// live 2026-07-20, showed up in chrome://extensions's error log during
// normal reload-then-test iteration), but worth failing silently instead
// of surfacing as a scary uncaught error.
function _safeSendMessage(msg) {
  try {
    chrome.runtime.sendMessage(msg).catch(() => {});
  } catch (e) {
    log("sendMessage failed (extension context invalidated — reload this tab):", e.message);
  }
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
    // Live bug (2026-07-21): a different /posts/ permalink shape LinkedIn
    // also generates — /posts/{author-slug}_{title-slug}-share-{id}-{suffix}/
    // — matched none of the above, so content.js silently gave up on the
    // whole page (no reply-detection at all) for this URL shape.
    /-share-(\d+)-/, // /posts/user_slug_title-share-1234567890-abcd
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

// A mention chip's text is our name plus, at most, a short trailing badge
// (a connection-degree label, "(She/Her)", " • You") — never a whole
// headline. Bug found live 2026-07-20: an earlier version of this allowed
// ANY trailing text after our name, which let our own comment's combined
// name+badge+HEADLINE link ("Ian Naylor • You Serial Entrepreneur; founder
// of multiple SaaS businesses...") get matched as if it were a mention
// inside someone else's reply, corrupting the whole detection (wrong
// author, wrong quoted text, and consequently a nonsensical AI draft built
// from our own bio instead of their actual reply). Capping the allowed
// slack at 20 chars keeps genuine short badges matching while rejecting a
// full headline.
function _isOwnName(t) {
  if (!OWN_NAME || !t) return false;
  if (t === OWN_NAME) return true;
  return t.startsWith(OWN_NAME) && t.length - OWN_NAME.length <= 20;
}

// Every genuine LinkedIn comment/reply has "Like" and "Reply" action text
// directly beneath it. Live-confirmed bug (2026-07-20): the mention scan
// below searches the WHOLE document for a link reading our name, which
// also catches unrelated UI elsewhere on the page that happens to mention
// us — e.g. a messaging-widget chat bubble showing "Ian Naylor 8:12 AM"
// got picked up as a second "reply" with body "8:12 AM", and on a later
// re-scan it happened to sort ahead of the real reply and overwrote it.
// Requiring a nearby "Reply" action rejects that kind of noise, since
// nothing outside the comments section has one.
function _looksLikeCommentReply(containerText) {
  return /\bReply\b/.test(containerText);
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
      return t && !_isOwnName(t);
    });
    if (other) {
      log(`    found distinct author link "${_cleanText(other)}" at depth ${depth} (wrapper text length ${wrapperText.length})`);
      return { authorLink: other, wrapperText };
    }
  }
  return null;
}

function _findOwnCommentReplies() {
  if (!OWN_NAME) return [];
  const mentionLinks = Array.from(document.querySelectorAll('a[href*="/in/"]')).filter((a) => _isOwnName(_cleanText(a)));
  log(`found ${mentionLinks.length} link(s) reading "${OWN_NAME}" (mentions inside a reply to us)`);

  const results = [];
  mentionLinks.forEach((mentionLink, i) => {
    // Bounded to roughly "one reply's worth" of text (the mention plus
    // the rest of that reply's body, not the whole thread).
    const bodyContainer = _boundedContainer(mentionLink, OWN_NAME.length + 5, 2000, 5);
    const bodyText = _cleanText(bodyContainer);
    log(`mention #${i}: reply body = "${bodyText.slice(0, 150)}"`);

    const found = _findReplyAuthorNear(mentionLink, 12, 2500);
    if (!found) {
      log(`  no distinct author found within climb/text caps — skipping`);
      return;
    }
    if (!_looksLikeCommentReply(found.wrapperText)) {
      log(`  no "Reply" action found nearby — this isn't a real comment (likely unrelated page noise), skipping`);
      return;
    }

    const replyAuthor = _cleanText(found.authorLink);
    const replyText = bodyText.replace(new RegExp(`^${OWN_NAME}\\s*`), "").trim();
    log(`  => reply from "${replyAuthor}": "${replyText.slice(0, 150)}"`);
    if (replyText) results.push({ replyAuthor, replyText });
  });

  if (results.length > 0) return results;

  // Fallback (added 2026-07-20): the @mention strategy above only catches
  // replies where LinkedIn actually inserted an "@Ian Naylor" chip into the
  // reply body. That's real behavior for the reply flow tested on
  // 2026-07-17, but it isn't guaranteed for every reply path (e.g. a
  // reply typed without using the mention chip) — a reply can be visibly
  // nested directly under our own comment with no @mention at all, and the
  // mention-based scan above finds nothing for it. This walks from our own
  // comment's heading instead of from a mention, and grabs the nearest
  // OTHER profile link that appears after it in document order — same
  // "structurally guaranteed profile link" anchor, just anchored from the
  // other end.
  log("no @mention-based replies found — trying structural fallback (reply without an explicit mention)");
  return _findRepliesUnderOwnComment();
}

function _findRepliesUnderOwnComment() {
  if (!OWN_NAME) return [];
  // Same technique _findOwnCommentText uses: our own name isn't hyperlinked
  // in our own comment's author heading, so look for a short unlinked leaf
  // node whose text is exactly our name.
  const headings = Array.from(document.querySelectorAll("span, div, a")).filter((el) => {
    if (el.children.length > 0) return false;
    return _cleanText(el) === OWN_NAME;
  });
  log(`structural fallback: found ${headings.length} own-comment heading(s)`);

  const results = [];
  headings.forEach((heading, i) => {
    const ownContainer = _boundedContainer(heading, OWN_NAME.length + 15, 2000, 6);

    // Climb progressively from ownContainer, same technique
    // _findReplyAuthorNear uses for the mention-based path, instead of
    // checking only a single fixed parent level. Live bug (2026-07-21): a
    // single parent hop wasn't always wide enough to reach the reply —
    // LinkedIn's comment nesting depth varies from thread to thread, and
    // this one needed climbing further than one level to find it.
    let el = ownContainer;
    let found = null;
    for (let depth = 0; depth < 10 && el.parentElement; depth++) {
      el = el.parentElement;
      const wrapperText = _cleanText(el);
      if (wrapperText.length > 4000) {
        log(`  own-comment #${i}: climbed to depth ${depth}, text length ${wrapperText.length} exceeds cap, stopping`);
        break;
      }
      // "Comes after our comment in document order" stops meaning "is a
      // reply to us" once the wrapper has climbed past our own comment's
      // own reply thread into the shared list holding every top-level
      // comment on the post — at that point ANYONE who commented later
      // satisfies the document-order check, not just replies to us. Live
      // bug (2026-07-21): with no real reply to us on this post, the climb
      // kept going until it reached that shared container and matched two
      // other people's entirely unrelated exchange as if it were a reply.
      // More than one other comment's own "Reply" action button appearing
      // in the wrapper is the signal that's happened — our own comment
      // contributes one, a genuine single reply to us contributes another,
      // anything past that means multiple unrelated comments got swept in.
      const replyCount = (wrapperText.match(/\bReply\b/g) || []).length;
      if (replyCount > 2) {
        log(`  own-comment #${i}: wrapper at depth ${depth} contains ${replyCount} "Reply" actions — spans other people's comments too, stopping`);
        break;
      }
      const candidateLinks = Array.from(el.querySelectorAll('a[href*="/in/"]')).filter((a) => {
        const t = _cleanText(a);
        if (!t || _isOwnName(t)) return false;
        // Must come AFTER our own comment in document order — otherwise
        // this picks up an earlier, unrelated commenter instead of a reply.
        return !!(ownContainer.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING);
      });
      if (candidateLinks.length) {
        found = { authorLink: candidateLinks[0], wrapperText };
        log(`  own-comment #${i}: found distinct profile link "${_cleanText(candidateLinks[0])}" at depth ${depth} (wrapper text length ${wrapperText.length})`);
        break;
      }
    }
    if (!found) {
      log(`  own-comment #${i}: no distinct profile link found within climb — no reply (yet)`);
      return;
    }
    if (!_looksLikeCommentReply(found.wrapperText)) {
      log(`  own-comment #${i}: nearest profile link has no "Reply" action nearby — not a real comment, skipping`);
      return;
    }
    const replyAuthor = _cleanText(found.authorLink);
    const bodyContainer = _boundedContainer(found.authorLink, replyAuthor.length + 5, 2000, 5);
    const replyText = _cleanText(bodyContainer).replace(new RegExp(`^${replyAuthor}\\s*`), "").trim();
    log(`  own-comment #${i}: structural match — reply from "${replyAuthor}": "${replyText.slice(0, 150)}"`);
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
    //
    // A richer notification (a reply that also embeds a preview of the
    // ORIGINAL post being discussed, not just a plain "X liked your
    // post") can contain a SECOND link matching the same href pattern —
    // the embedded post preview itself. Matching on href alone picked up
    // whichever came first in DOM order, which silently grabbed the
    // wrong one and produced a garbled name instead of the real one
    // (live-confirmed 2026-07-20: "Marinell Falcón" never showed up,
    // presumably because the post-preview link won the href match
    // first). Requiring the candidate link's OWN TEXT to also contain
    // the matched phrase ties extraction directly to the element that
    // actually said "mentioned you in a comment" — a post-preview link
    // never contains that phrase, so it can't win by accident anymore.
    let link = allLinks.find((a) => {
      const href = a.getAttribute("href") || "";
      return /\/feed\/update\/|\/posts\//.test(href) && pattern.test(_cleanText(a));
    });
    if (!link) {
      // Fallback to the old, looser match in case this specific
      // notification type doesn't actually have the phrase text inside
      // the link itself — better to try the previous best guess than
      // drop the candidate entirely.
      link = allLinks.find((a) => /\/feed\/update\/|\/posts\//.test(a.getAttribute("href") || ""));
    }
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
    _safeSendMessage({ type: "SOCIAL_INTENT_NOTIFICATIONS_FOUND", items: found });
  }
}

// ---------- MESSAGING THREAD SCANNING ----------
// A LinkedIn DIRECT MESSAGE referencing "your comment on my post" has no
// post link embedded in it at all — the only way to recover what it's
// about is to resolve the sender's name against our own stored records
// (backend GET /queue/lookup-by-name), then reuse the exact same
// /queue/draft-reply flow already used for comment-thread replies, once
// that lookup hands back a postUrl.
//
// NEEDS LIVE VERIFICATION — LinkedIn's messaging UI has not been
// exercised anywhere else in this file (unlike the feed/notifications
// selectors, which were iterated on live repeatedly).
let _lastReportedDmSignature = null;

function _scanMessagingThread() {
  if (!OWN_NAME) {
    log("messaging: OWN_NAME not set, skipping");
    return;
  }

  // Live bug (2026-07-21), two rounds: taking whichever /in/ link came
  // FIRST in DOM order was never reliable — round 1 grabbed a link whose
  // text was name+headline concatenated together, round 2 (after capping
  // length) grabbed a hidden presence-status label ("Status is offline",
  // near the avatar) that happened to also sit in a short /in/ link ahead
  // of the real name. Live feedback: the other party's actual name is the
  // one thing repeated multiple times on this page (thread list preview,
  // conversation header, each message's own sender line) — frequency is a
  // far more reliable signal than "whichever link comes first". Count
  // every short /in/-linked text's occurrences and take the most frequent
  // one that isn't us, rather than trusting position at all.
  const nameCounts = new Map();
  Array.from(document.querySelectorAll('a[href*="/in/"]')).forEach((a) => {
    const t = _cleanText(a);
    if (!t || t.length > 50 || _isOwnName(t)) return;
    nameCounts.set(t, (nameCounts.get(t) || 0) + 1);
  });
  if (!nameCounts.size) {
    log("messaging: no distinct /in/ profile link found on this thread — can't identify the other party");
    return;
  }
  const ranked = [...nameCounts.entries()].sort((a, b) => b[1] - a[1]);
  const otherName = ranked[0][0];
  log(`messaging: name candidates — ${ranked.map(([n, c]) => `"${n}"×${c}`).join(", ")} — picked "${otherName}"`);

  // Live bug (2026-07-21): "grab the last substantial text block on the
  // page" caught UI chrome ("Clicking Send will send message", an
  // accessibility/tooltip string near the Send button), not an actual
  // message. LinkedIn repeats the sender's name as a small heading
  // directly above each of their messages (visible live: "Victoria
  // Olamide · 4:13 PM" sitting right above her message text) — the same
  // "name repeated as a heading before the content" structure already
  // proven for comment threads elsewhere in this file
  // (_findRepliesUnderOwnComment). Find every such header for the OTHER
  // party specifically, take the LAST one (most recent message), and
  // read the text that follows it via the same _boundedContainer climb
  // _findOwnCommentText already uses for an analogous "name heading,
  // then body text" shape.
  const headers = Array.from(document.querySelectorAll("span, div, a")).filter((el) => {
    if (el.children.length > 0) return false;
    const t = _cleanText(el);
    return t === otherName || t.startsWith(otherName + " ");
  });
  if (!headers.length) {
    log(`messaging: found other party "${otherName}" but no repeated name-header found to anchor their latest message`);
    return;
  }
  const lastHeader = headers[headers.length - 1];
  const bodyContainer = _boundedContainer(lastHeader, otherName.length + 10, 2000, 6);
  const messageText = _cleanText(bodyContainer).replace(new RegExp(`^${otherName}\\s*`), "").trim();
  if (!messageText) {
    log(`messaging: found a name-header for "${otherName}" but no message text after it`);
    return;
  }

  const signature = `${otherName}|${messageText}`;
  if (signature === _lastReportedDmSignature) return;
  _lastReportedDmSignature = signature;

  log(`messaging: detected thread with "${otherName}" (${headers.length} name-header(s) found), latest: "${messageText.slice(0, 150)}"`);
  _safeSendMessage({ type: "SOCIAL_INTENT_DM_DETECTED", otherName, messageText });
}

function _report() {
  if (location.pathname.startsWith("/notifications")) {
    _scanNotifications();
    return; // no single "post" on this page to run reply-detection against
  }

  if (location.pathname.startsWith("/messaging/")) {
    _scanMessagingThread();
    return; // no post/comment on this page type either
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
    _safeSendMessage({ type: "SOCIAL_INTENT_POST_CHANGED", activityId });
  }

  if (location.href !== lastReportedUrl) {
    lastReportedUrl = location.href;
    log("post detected, activityId =", activityId);
    // side panel may not be open — fine, just no listener
    _safeSendMessage({
      type: "SOCIAL_INTENT_POST_DETECTED",
      activityId,
      url: location.href,
    });
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
      _safeSendMessage({
        type: "SOCIAL_INTENT_REPLY_DETECTED",
        activityId,
        url: location.href,
        replies,
        postText,
        ownComment,
      });
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
let cachedProductKeywords = null; // [{name, key, keywords: [...], highIntentKeywords: [...]}]
let _overlayBackendUrl = null;
let _overlayApiKey = null;
const _overlayMarked = new WeakSet();

function _loadOverlaySettings() {
  chrome.storage.local.get(["liveOverlayEnabled", "backendUrl", "backendApiKey"], (r) => {
    overlayEnabled = !!r.liveOverlayEnabled;
    _overlayBackendUrl = r.backendUrl ? r.backendUrl.replace(/\/+$/, "") : null;
    _overlayApiKey = r.backendApiKey || null;
    if (overlayEnabled && _overlayBackendUrl && _overlayApiKey && !cachedProductKeywords) {
      _fetchProductKeywords(_overlayBackendUrl, _overlayApiKey);
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
// Live bug (2026-07-21): cachedProductKeywords was fetched once per page
// load and never refreshed after that — a product added or edited on the
// backend (e.g. a new product created mid-session) was invisible to any
// LinkedIn tab that had already been open since before that change, with
// no way to notice short of manually refreshing the tab. Re-fetching
// periodically instead of only once means a product change shows up on
// its own within a few minutes, not only after remembering to reload.
setInterval(() => {
  if (overlayEnabled && _overlayBackendUrl && _overlayApiKey) {
    _fetchProductKeywords(_overlayBackendUrl, _overlayApiKey);
  }
}, 5 * 60 * 1000);

function _fetchProductKeywords(backendUrl, apiKey) {
  fetch(`${backendUrl}/products`, { headers: { Authorization: `Bearer ${apiKey}` } })
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then((data) => {
      const split = (s) => (s || "").split(",").map((k) => k.trim()).filter(Boolean);
      cachedProductKeywords = (data.products || []).map((p) => ({
        name: p.name || p.key,
        key: p.key,
        highIntentKeywords: split(p.highIntentKeywords),
        keywords: [...split(p.broadKeywords), ...split(p.highIntentKeywords)],
      }));
      log(`overlay: cached keywords for ${cachedProductKeywords.length} product(s)`);
    })
    .catch((e) => log("overlay: failed to load product keywords:", e));
}

// Best-effort — the post author's name/profile link isn't scraped
// anywhere else in this file (every existing technique targets a
// COMMENT's author, not the enclosing POST's), so this is new. Same
// structural anchor as everywhere else (LinkedIn always links a visible
// name to /in/...), scoped to the post card and taking the first
// non-empty-text match, since the author block always renders before any
// inline comments the card might also contain.
//
// Live bug (2026-07-21): a post authored by a Company Page (e.g. "Keystone
// Product") has no /in/ link at all for its author — only a /company/
// link — so this returned {name: null}, which Airtable then stored as a
// genuinely empty field, which the Queue UI rendered as the literal text
// "undefined" (a bare ${item.name} template interpolation of JS
// undefined). Falling back to the post's /company/ link picks up the
// organization's name as the "author" for company-page posts instead of
// silently returning nothing.
function _findPostAuthor(card) {
  const personLink = Array.from(card.querySelectorAll('a[href*="/in/"]')).find((a) => _cleanText(a).length > 0);
  if (personLink) return { name: _cleanText(personLink), profileUrl: personLink.href };
  const companyLink = Array.from(card.querySelectorAll('a[href*="/company/"]')).find((a) => _cleanText(a).length > 0);
  if (companyLink) return { name: _cleanText(companyLink), profileUrl: companyLink.href };
  return { name: null, profileUrl: null };
}

function _scanFeedForIntentMatches() {
  if (!overlayEnabled || !cachedProductKeywords || !cachedProductKeywords.length) return;

  const seenActivityIds = new Set();
  const candidates = [];

  // Strategy 1: real permalink links — proven on the main feed.
  Array.from(document.querySelectorAll('a[href*="/feed/update/"], a[href*="/posts/"]')).forEach((link) => {
    const href = link.getAttribute("href") || "";
    const activityId = _extractActivityId(href);
    // activityId here is only ever used as a dedup key (postUrl sent
    // downstream already uses href directly, not this), so falling back
    // to the raw href when no numeric ID can be parsed out of it keeps
    // dedup working without requiring a URL shape match.
    const dedupKey = activityId || href;
    if (!dedupKey || seenActivityIds.has(dedupKey)) return;
    seenActivityIds.add(dedupKey);
    candidates.push({ startEl: link, activityId, postUrl: link.href });
  });

  // Strategy 2: data-urn attributes. Live bug (2026-07-21): on LinkedIn's
  // dedicated /search/results/content/ page, the ONLY links matching
  // strategy 1's selector across the whole page were unrelated
  // company-page attribution links embedded inside shared articles
  // elsewhere on the page — the actual visible posts exposed no matching
  // link at all, so the scan never even considered them, regardless of
  // keywords. data-urn is set directly on a post's own container by
  // LinkedIn itself, independent of whether a permalink <a> happens to be
  // present, and is a long-standing convention across feed/search/profile
  // page types — a more reliable anchor than a specific href shape.
  Array.from(document.querySelectorAll('[data-urn*="activity:"]')).forEach((el) => {
    const m = (el.getAttribute("data-urn") || "").match(/activity:(\d+)/);
    if (!m) return;
    const activityId = m[1];
    if (seenActivityIds.has(activityId)) return;
    seenActivityIds.add(activityId);
    candidates.push({
      startEl: el,
      activityId,
      postUrl: `https://www.linkedin.com/feed/update/urn:li:activity:${activityId}/`,
    });
  });

  let checked = 0;
  let skippedShort = 0;
  let skippedLong = 0;
  let skippedNoId = 0;

  candidates.forEach(({ startEl, activityId, postUrl }) => {
    if (!activityId) {
      skippedNoId++;
      log(`overlay: no activity ID pattern matched, using raw href as dedup key: ${postUrl}`);
    }

    // Climb to a post-card-sized container. Checks the starting element's
    // OWN text first (a data-urn container is often already the right
    // size) before climbing, instead of always climbing at least once —
    // that would overshoot for strategy 2's candidates, which — unlike a
    // deeply-nested permalink link — frequently already ARE an
    // appropriately-sized container. Live bug (2026-07-21): stopping at
    // the FIRST moment text crossed 150 chars meant the exact climb depth
    // (and therefore whether the post's own body text was actually
    // included yet) depended on incidental DOM shape. Climbing further
    // (300/4000-char thresholds) and preferring the same proven
    // _extractCardText selectors used elsewhere in this file for the
    // actual keyword check — falling back to the full climbed blob only
    // if those selectors find nothing — ties matching to the post's real
    // body text instead of wherever the climb happened to stop.
    let card = startEl;
    let cardText = _cleanText(card);
    for (let depth = 0; depth < 12 && cardText.length <= 300 && card.parentElement; depth++) {
      card = card.parentElement;
      cardText = _cleanText(card);
      if (cardText.length > 4000) {
        skippedLong++;
        return; // climbed too far, bail rather than mismark a huge chunk
      }
    }
    if (cardText.length < 50 || _overlayMarked.has(card)) {
      if (cardText.length < 50) skippedShort++;
      return;
    }
    checked++;

    const matchText = _extractCardText(card) || cardText;
    const haystack = matchText.toLowerCase();
    let bestMatch = null;
    for (const product of cachedProductKeywords) {
      const strongHit = product.highIntentKeywords.find((kw) => haystack.includes(kw.toLowerCase()));
      const hit = strongHit || product.keywords.find((kw) => haystack.includes(kw.toLowerCase()));
      if (hit) {
        bestMatch = { product: product.name, productKey: product.key, keyword: hit, strong: !!strongHit };
        if (strongHit) break;
      }
    }
    log(
      `overlay: post ${activityId || "(no id)"} — matchText ${matchText.length} chars — ${
        bestMatch ? `MATCHED "${bestMatch.keyword}" (${bestMatch.product})` : "no keyword hit"
      }`
    );

    if (bestMatch) {
      _overlayMarked.add(card);
      const author = _findPostAuthor(card);
      _injectOverlayBadge(card, bestMatch, { postUrl, postText: matchText, ...author });
    }
  });
  log(
    `overlay: scan pass — ${candidates.length} candidate(s) seen, ${checked} card(s) checked, ${skippedShort} too short, ${skippedLong} too long, ${skippedNoId} had no parseable activity ID`
  );
}

// Live feedback (2026-07-21): the badge used to be a pure visual flag
// (pointer-events: none) with no follow-on action — a match with nowhere
// to go. Now clickable: drafts a comment via the same backend logic the
// scored pipeline uses, copies it to the clipboard so it can be pasted
// straight into LinkedIn's own comment box, and creates a real Airtable
// record so the post shows up in the Queue and gets picked up by the
// existing reply-detection machinery once the comment is actually posted.
function _injectOverlayBadge(card, match, post) {
  if (getComputedStyle(card).position === "static") card.style.position = "relative";
  const color = match.strong ? "#d32f2f" : "#0a66c2";
  const wrap = document.createElement("div");
  wrap.style.cssText = `position: absolute; top: 4px; right: 4px; z-index: 9999; display: flex; flex-direction: column; align-items: flex-end; gap: 4px;`;
  const badge = document.createElement("div");
  badge.textContent = `🎯 ${match.product} — "${match.keyword}"`;
  badge.title = "Social Intent Comment Queue — client-side keyword match, not a full AI score";
  badge.style.cssText = `
    background: ${color}; color: white; font-size: 11px; padding: 3px 8px;
    border-radius: 10px; font-family: -apple-system, sans-serif;
    box-shadow: 0 1px 3px rgba(0,0,0,0.3);
  `;
  const btn = document.createElement("button");
  btn.textContent = "✍️ Generate Comment";
  btn.style.cssText = `
    background: white; color: ${color}; border: 1px solid ${color}; font-size: 11px;
    font-weight: 600; padding: 3px 8px; border-radius: 10px; cursor: pointer;
    font-family: -apple-system, sans-serif; box-shadow: 0 1px 3px rgba(0,0,0,0.3);
  `;
  btn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!_overlayBackendUrl || !_overlayApiKey) {
      btn.textContent = "Configure backend in Settings first";
      return;
    }
    btn.disabled = true;
    btn.textContent = "Drafting…";
    fetch(`${_overlayBackendUrl}/overlay/quick-add`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${_overlayApiKey}` },
      body: JSON.stringify({
        postUrl: post.postUrl,
        postText: post.postText,
        productKey: match.productKey,
        authorName: post.name,
        authorProfileUrl: post.profileUrl,
      }),
    })
      .then((r) => (r.ok ? r.json() : r.json().then((e2) => Promise.reject(e2.detail || r.status))))
      .then((res) => {
        const comment = res.comment || "";
        navigator.clipboard.writeText(comment).catch(() => {});
        btn.textContent = "✓ Copied — paste below";
        btn.style.cursor = "default";
        log("overlay: comment drafted and copied", comment);
      })
      .catch((e) => {
        log("overlay: quick-add failed", e);
        btn.disabled = false;
        btn.textContent = "Failed — tap to retry";
      });
  };
  wrap.appendChild(badge);
  wrap.appendChild(btn);
  card.appendChild(wrap);
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
