const progressEl = document.getElementById("progress");
const contentEl = document.getElementById("content");
const navQueueBtn = document.getElementById("navQueue");
const navFollowupsBtn = document.getElementById("navFollowups");
const navProfilesBtn = document.getElementById("navProfiles");
const navProductsBtn = document.getElementById("navProducts");
const settingsGearBtn = document.getElementById("settingsGearBtn");

// Plain-stroke line icons (Feather-style geometry) instead of emoji — emoji
// render as inconsistent, colorful platform glyphs that clash with an
// otherwise flat monochrome UI. currentColor lets each button's existing
// text color (including .primary/.danger states) drive the icon color.
const ICONS = {
  play: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20"/></svg>',
  clipboard: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>',
  download: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  edit: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>',
  copy: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  search: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
  trash: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>',
  settings: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  zap: '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
};

const SCORE_LABELS = {
  0: "Skip",
  1: "Low signal",
  2: "Educational / wrong persona",
  3: "Practitioner, no pain point",
  4: "Active pain point",
  5: "Direct ask",
};

const PROFILES_EXPORT_DIR = "social-intent-leads-profiles";

let QUEUE = [];
let currentView = "queue";
// Optimistic, in-memory status overrides applied immediately on click, so
// auto-advance never waits on a network round trip (cloud mode) or even a
// chrome.storage round trip (local mode) before showing the next item.
const sessionStatusOverrides = {};
// Tracks the postUrl already auto-opened/auto-copied so arriving at the
// SAME current item on a re-render (e.g. after "Generate Comment Anyway"
// mutates a skip in place) doesn't re-trigger and reload the tab. Not
// reset on view switches — returning to Queue with the same item on top
// shouldn't re-fire either.
let lastAutoLoadedPostUrl = null;
// Gates the auto-open-tab behavior below it behind an explicit click.
// Live feedback (2026-07-21): the panel's script re-runs fresh every time
// it's opened, so the auto-open used to fire on EVERY open — including
// just glancing at the panel while working on something else entirely,
// yanking the browser over to LinkedIn and stealing focus from whatever
// tab was active. Persisted (see switchView's comment on currentView, same
// underlying per-tab-panel reset risk) so a mid-session reset doesn't
// force clicking Start again on top of losing the current view.
let queueSessionStarted = false;

navQueueBtn.onclick = () => { setQueueFilter(null, () => switchView("queue")); }; // global Queue tab always shows everything
navFollowupsBtn.onclick = () => switchView("followups");
navProfilesBtn.onclick = () => switchView("profiles");
navProductsBtn.onclick = () => switchView("products");
settingsGearBtn.onclick = () => switchView("settings");

function getQueueFilter(cb) {
  chrome.storage.local.get(["queueFilter"], (r) => cb(r.queueFilter || null));
}
function setQueueFilter(filter, cb) {
  chrome.storage.local.set({ queueFilter: filter }, cb);
}
function viewQueueForProfile(p) {
  setQueueFilter({ slug: p.slug, name: p.name }, () => switchView("queue"));
}

function switchView(view) {
  currentView = view;
  // Chrome's side panel is opened per-tab (background.js's
  // setPanelEnabledForTab), which means switching the ACTIVE tab can swap
  // to a genuinely different panel document instance — a fresh popup.html
  // load with none of this session's in-memory state. Live feedback
  // (2026-07-21): opening a reply from Follow-ups calls openInWorkingTab,
  // which activates the working LinkedIn tab — if the panel had been
  // showing for a different tab up to that point, that tab-focus change
  // was enough to reset the panel back to its default Queue view mid-flow.
  // Persisting the view and restoring it on load (below) survives that
  // reset regardless of which tab the fresh instance loads for.
  chrome.storage.local.set({ currentView: view });
  navQueueBtn.classList.toggle("active", view === "queue");
  navFollowupsBtn.classList.toggle("active", view === "followups");
  navProfilesBtn.classList.toggle("active", view === "profiles");
  navProductsBtn.classList.toggle("active", view === "products");
  if (view === "queue") renderQueueView();
  else if (view === "followups") renderFollowupsView();
  else if (view === "profiles") renderProfilesView();
  else if (view === "products") renderProductsView();
  else renderSettingsView();
}

function relativeTime(ts) {
  if (!ts) return "Never run";
  const diffMs = Date.now() - ts;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ---------- SETTINGS / BACKEND CONFIG ----------

function getBackendConfig(cb) {
  chrome.storage.local.get(["backendUrl", "backendApiKey"], (r) => {
    cb({
      url: (r.backendUrl || "").replace(/\/+$/, ""),
      apiKey: r.backendApiKey || "",
      configured: !!(r.backendUrl && r.backendApiKey),
    });
  });
}

function getAutoSkipSetting(cb) {
  chrome.storage.local.get(["autoSkipSkips"], (r) => cb(!!r.autoSkipSkips));
}

function getOwnDisplayName(cb) {
  chrome.storage.local.get(["ownDisplayName"], (r) => cb(r.ownDisplayName || ""));
}

function getLiveOverlaySetting(cb) {
  chrome.storage.local.get(["liveOverlayEnabled"], (r) => cb(!!r.liveOverlayEnabled));
}

function renderSettingsView() {
  progressEl.textContent = "";
  getBackendConfig((cfg) => {
    getAutoSkipSetting((autoSkip) => {
      getOwnDisplayName((ownName) => {
        getLiveOverlaySetting((liveOverlay) => {
          const finishRender = (voice) => renderSettingsBody(cfg, autoSkip, voice || {}, ownName, liveOverlay);
          if (cfg.configured) {
            fetch(`${cfg.url}/voice`, { headers: { Authorization: `Bearer ${cfg.apiKey}` } })
              .then((r) => (r.ok ? r.json() : {}))
              .catch(() => ({}))
              .then(finishRender);
          } else {
            finishRender({});
          }
        });
      });
    });
  });
}

function renderSettingsBody(cfg, autoSkip, voice, ownName, liveOverlay) {
  contentEl.innerHTML = `
    <div class="label">Your name</div>
    <input type="text" id="fOwnName" placeholder="Exactly as it appears on LinkedIn, e.g. Ian Naylor" value="${ownName || ""}" />
    <div class="helpText">Used to tell your own comments apart from everyone else's when detecting replies and scanning notifications — set this before those features will do anything.</div>
    <div class="row"><button id="saveOwnNameBtn" class="primary">Save name</button></div>
    <div id="ownNameMsg" style="font-size:12px;margin:6px 0 16px;min-height:16px;"></div>

    <div class="modeNote ${cfg.configured ? "cloud" : "local"}">
      ${cfg.configured ? "Cloud mode — Queue and Search use the hosted backend." : "Local mode — Queue reads data.json from this folder, no backend configured."}
    </div>
    <div class="label">Backend URL</div>
    <input type="text" id="fBackendUrl" placeholder="https://your-service.onrender.com" value="${cfg.url}" />
    <div class="label">API key</div>
    <input type="text" id="fBackendKey" placeholder="paste your key" value="${cfg.apiKey}" />
    <div id="testMsg" style="font-size:12px;margin:6px 0;height:16px;"></div>
    <div class="row">
      <button id="testBtn">Test Connection</button>
      <button id="saveSettingsBtn" class="primary">Save</button>
    </div>
    <div class="row"><button id="clearSettingsBtn" class="danger">Clear (back to local mode)</button></div>

    ${cfg.configured ? `
      <div class="label" style="margin-top:16px;">Live browsing overlay</div>
      <label style="font-size:12px;display:block;margin-bottom:6px;">
        <input type="checkbox" id="fLiveOverlay" ${liveOverlay ? "checked" : ""} />
        Highlight posts on LinkedIn (feed, search results, anywhere) that match your products' intent keywords, while you're browsing.
      </label>
      <div class="helpText">Off by default — this is a lightweight, free client-side keyword check against posts already on the page, not a full AI score. Turn it on when you're casually browsing and want a quick visual nudge on what might be worth a look; leave it off otherwise so it's not always running in the background.</div>
    ` : ""}

    <div class="label" style="margin-top:16px;">Skip handling</div>
    <label style="font-size:12px;display:block;margin-bottom:6px;">
      <input type="checkbox" id="fAutoSkip" ${autoSkip ? "checked" : ""} />
      Auto-skip skips — don't show the review screen for skipped posts, just mark them done silently.
    </label>
    <div class="helpText">Off (default): each skip shows its reason and the post, so you can review and override before moving on.</div>

    ${cfg.configured ? `
      <div class="label" style="margin-top:16px;">Your voice</div>
      <div class="helpText">Applies to every comment you draft, across every product — this is about how YOU sound, not any one product. Point it at your own LinkedIn profile to infer a starting brief from your real posts, then edit it into something you're happy with.</div>

      <div class="label">Your LinkedIn profile URL</div>
      <input type="text" id="fVoiceLinkedinUrl" placeholder="https://www.linkedin.com/in/yourname" value="${voice.linkedinUrl || ""}" />
      <div class="row"><button id="generateVoiceBtn">${ICONS.zap} Scan my profile &amp; posts, draft a brief</button></div>
      <div id="voiceGenMsg" style="font-size:12px;margin:6px 0;min-height:16px;"></div>

      <div class="label">Voice brief</div>
      <textarea id="fVoiceBrief" placeholder="Generate one above, or write your own — short, direct sentences describing how you write." style="min-height:90px;">${voice.voiceBrief || ""}</textarea>

      <div class="label">Reply length</div>
      <select id="fVoiceLength">
        <option value="" ${!voice.replyLength ? "selected" : ""}>No preference</option>
        <option value="short" ${voice.replyLength === "short" ? "selected" : ""}>Short — a sentence or two</option>
        <option value="long" ${voice.replyLength === "long" ? "selected" : ""}>Longer — two to four sentences</option>
      </select>

      <div class="label">Reply style</div>
      <select id="fVoiceStyle">
        <option value="" ${!voice.replyStyle ? "selected" : ""}>No preference</option>
        <option value="casual" ${voice.replyStyle === "casual" ? "selected" : ""}>Casual</option>
        <option value="professional" ${voice.replyStyle === "professional" ? "selected" : ""}>Professional</option>
      </select>

      <div class="row"><button id="saveVoiceBtn" class="primary">Save voice</button></div>
      <div id="voiceSaveMsg" style="font-size:12px;margin:6px 0;min-height:16px;"></div>
    ` : ""}
  `;

  document.getElementById("saveOwnNameBtn").onclick = () => {
    const name = document.getElementById("fOwnName").value.trim();
    const msg = document.getElementById("ownNameMsg");
    chrome.storage.local.set({ ownDisplayName: name }, () => {
      msg.textContent = name ? "Saved." : "Cleared — reply/notification detection is now disabled.";
      msg.style.color = name ? "#0a7d2c" : "#a15c00";
      setTimeout(() => { msg.textContent = ""; }, 2500);
    });
  };

  document.getElementById("testBtn").onclick = () => {
    const url = document.getElementById("fBackendUrl").value.trim().replace(/\/+$/, "");
    const testMsg = document.getElementById("testMsg");
    testMsg.textContent = "Testing…";
    fetch(`${url}/health`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then(() => { testMsg.textContent = "Reachable ✓"; testMsg.style.color = "#0a7d2c"; })
      .catch((e) => { testMsg.textContent = `Unreachable (${e})`; testMsg.style.color = "#b8003c"; });
  };

  document.getElementById("saveSettingsBtn").onclick = () => {
    const url = document.getElementById("fBackendUrl").value.trim().replace(/\/+$/, "");
    const apiKey = document.getElementById("fBackendKey").value.trim();
    chrome.storage.local.set({ backendUrl: url, backendApiKey: apiKey }, renderSettingsView);
  };

  document.getElementById("clearSettingsBtn").onclick = () => {
    chrome.storage.local.set({ backendUrl: "", backendApiKey: "" }, renderSettingsView);
  };

  document.getElementById("fAutoSkip").onchange = (e) => {
    chrome.storage.local.set({ autoSkipSkips: e.target.checked });
  };

  if (!cfg.configured) return;

  document.getElementById("fLiveOverlay").onchange = (e) => {
    chrome.storage.local.set({ liveOverlayEnabled: e.target.checked });
  };

  document.getElementById("generateVoiceBtn").onclick = () => {
    const linkedinUrl = document.getElementById("fVoiceLinkedinUrl").value.trim();
    const genMsg = document.getElementById("voiceGenMsg");
    if (!linkedinUrl) { genMsg.textContent = "Paste your LinkedIn profile URL first."; genMsg.style.color = "#b8003c"; return; }
    const genBtn = document.getElementById("generateVoiceBtn");
    genBtn.disabled = true;
    genMsg.textContent = "Opening your posts in a background tab…";
    genMsg.style.color = "#555";
    // Posts are scraped client-side (background.js opens a background tab
    // on your own recent-activity page, content.js reads what's there,
    // the tab closes itself) — not fetched via RichAPI. See background.js
    // for why: no reason to route a read of your OWN posts, from your own
    // already-logged-in browser, through a third-party API.
    chrome.runtime.sendMessage({ type: "SOCIAL_INTENT_SCRAPE_OWN_POSTS", profileUrl: linkedinUrl, limit: 5 })
      .then((resp) => {
        if (!resp || !resp.ok) throw new Error((resp && resp.error) || "Could not read your posts");
        if (!resp.posts || !resp.posts.length) {
          throw new Error("No posts found — a tab was left open on your activity page so this can be debugged; check its console.");
        }
        genMsg.textContent = `Drafting from ${resp.posts.length} post(s)…`;
        return fetch(`${cfg.url}/voice/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
          body: JSON.stringify({ linkedinUrl, posts: resp.posts }),
        });
      })
      .then((r) => (r.ok ? r.json() : r.json().then((e) => Promise.reject(e.detail || r.status))))
      .then((res) => {
        document.getElementById("fVoiceBrief").value = res.voiceBrief || "";
        genMsg.textContent = `Drafted from ${res.postsAnalyzed || 0} recent posts — edit below, then Save.`;
        genMsg.style.color = "#0a7d2c";
        genBtn.disabled = false;
      })
      .catch((e) => {
        genMsg.textContent = `Failed: ${e.message || e}`;
        genMsg.style.color = "#b8003c";
        genBtn.disabled = false;
      });
  };

  document.getElementById("saveVoiceBtn").onclick = () => {
    const saveMsg = document.getElementById("voiceSaveMsg");
    const body = {
      linkedinUrl: document.getElementById("fVoiceLinkedinUrl").value.trim(),
      voiceBrief: document.getElementById("fVoiceBrief").value.trim(),
      replyLength: document.getElementById("fVoiceLength").value || null,
      replyStyle: document.getElementById("fVoiceStyle").value || null,
    };
    saveMsg.textContent = "Saving…";
    saveMsg.style.color = "#555";
    fetch(`${cfg.url}/voice`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then(() => { saveMsg.textContent = "Saved — applies to every comment you draft from now on."; saveMsg.style.color = "#0a7d2c"; })
      .catch((e) => { saveMsg.textContent = `Failed to save (${e})`; saveMsg.style.color = "#b8003c"; });
  };
}

// ---------- SHARED: item lifecycle status ----------
// Cloud-sourced items always carry their own itemStatus field ("pending" /
// "queued_followup" / "done") directly from Airtable. Local-sourced items
// (from data.json) never have that field — status lives in chrome.storage
// instead. statusOf() reads whichever applies; sessionStatusOverrides always
// wins so a click feels instant regardless of which mode is active.

function statusOf(item, localMap) {
  if (sessionStatusOverrides[item.postUrl]) return sessionStatusOverrides[item.postUrl];
  if (item.itemStatus !== undefined) return item.itemStatus === "pending" ? undefined : item.itemStatus;
  return localMap[item.postUrl];
}

function migrateIfNeeded(cb) {
  // Only relevant in local mode — cloud items carry their own status already.
  chrome.storage.local.get(["itemStatus", "doneUrls"], (r) => {
    if (r.itemStatus) { cb(r.itemStatus); return; }
    const doneUrls = r.doneUrls || [];
    const status = {};
    doneUrls.forEach((url) => {
      const item = QUEUE.find((q) => q.postUrl === url);
      status[url] = item && item.action === "comment+connect" ? "queued_followup" : "done";
    });
    chrome.storage.local.set({ itemStatus: status }, () => cb(status));
  });
}

function updateItemStatus(item, status, cb) {
  sessionStatusOverrides[item.postUrl] = status; // instant, regardless of mode
  getBackendConfig((cfg) => {
    if (cfg.configured) {
      fetch(`${cfg.url}/queue/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({ postUrl: item.postUrl, status }),
      }).catch(() => {}).finally(() => cb && cb());
    } else {
      chrome.storage.local.get(["itemStatus"], (r) => {
        const map = r.itemStatus || {};
        map[item.postUrl] = status;
        chrome.storage.local.set({ itemStatus: map }, () => cb && cb());
      });
    }
  });
}

// ---------- QUEUE VIEW ----------

function loadQueue() {
  return new Promise((resolve, reject) => {
    getBackendConfig((cfg) => {
      if (cfg.configured) {
        getQueueFilter((filter) => {
          const qs = filter ? `?profileSlug=${encodeURIComponent(filter.slug)}` : "";
          fetch(`${cfg.url}/queue${qs}`, { headers: { Authorization: `Bearer ${cfg.apiKey}` } })
            .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
            .then((data) => resolve(data.items || []))
            .catch(reject);
        });
        return;
      }
      // cache: "no-store" + a cache-busting query param so an edited data.json
      // on disk is always picked up, no "reload extension" step required.
      const url = chrome.runtime.getURL("data.json") + "?_=" + Date.now();
      fetch(url, { cache: "no-store" }).then((r) => r.json()).then(resolve).catch(reject);
    });
  });
}

// Reuses one "working tab" across the whole session instead of opening a new
// tab on every click. Falls back to creating a fresh tab if the working tab
// was closed (or none exists yet).
function openInWorkingTab(url) {
  chrome.storage.local.get(["workingTabId"], (r) => {
    const tabId = r.workingTabId;
    if (!tabId) {
      createWorkingTab(url);
      return;
    }
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        createWorkingTab(url);
        return;
      }
      chrome.tabs.update(tabId, { url, active: true }, () => {
        if (chrome.runtime.lastError) {
          createWorkingTab(url);
          return;
        }
        if (tab.windowId != null) chrome.windows.update(tab.windowId, { focused: true });
      });
    });
  });
}
function createWorkingTab(url) {
  // Created inactive on purpose: an immediately-active new tab steals focus
  // and closes this popup before the storage.set below can run, so the
  // working tab id never gets saved and every click looked like it "always
  // opens a new tab." Save the id first, then activate.
  chrome.tabs.create({ url, active: false }, (tab) => {
    chrome.storage.local.set({ workingTabId: tab.id }, () => {
      chrome.tabs.update(tab.id, { active: true });
      if (tab.windowId != null) chrome.windows.update(tab.windowId, { focused: true });
    });
  });
}

function renderQueueView() {
  contentEl.innerHTML = "";
  progressEl.textContent = "Loading…";
  renderQueueFilterBanner();
  loadQueue().then((queue) => {
    QUEUE = queue;
    renderFromQueue();
    // A reply-detected message can arrive before QUEUE has ever loaded
    // (panel just opened) — retry the match now that it has.
    if (pendingReplyMessage) {
      const msg = pendingReplyMessage;
      pendingReplyMessage = null;
      processReplyMessage(msg);
    }
  }).catch(() => {
    progressEl.textContent = "";
    contentEl.innerHTML = `<div id="doneScreen">Couldn't load the queue. In local mode, run the social-intent-leads skill to populate data.json. In cloud mode, check Settings — the backend may be unreachable.</div>`;
  });
}

function renderQueueFilterBanner() {
  let banner = document.getElementById("queueFilterBanner");
  getQueueFilter((filter) => {
    if (!filter) {
      if (banner) banner.remove();
      return;
    }
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "queueFilterBanner";
      progressEl.parentNode.insertBefore(banner, progressEl);
    }
    banner.innerHTML = `<span>Showing only: ${filter.name}</span><button id="clearQueueFilterBtn">Show All</button>`;
    document.getElementById("clearQueueFilterBtn").onclick = () => setQueueFilter(null, renderQueueView);
  });
}

// Queue exhausted doesn't necessarily mean there's nothing left to do —
// other searches (or this one, after a re-scan) can still have a
// pending_batch backlog sitting unprocessed. Surface it here instead of a
// dead-end "nothing left" screen, so processing the next batch and
// getting back to reviewing is one click, not a trip to the Search tab.
// Shown once the queue's actually empty — a natural break point, not
// interrupting active work. Brand's own colors (dark navy + cyan), not the
// extension's LinkedIn-blue theme, so it reads clearly as "this is from
// Social Intent" rather than blending in as another app control.
// Fixed to the bottom of the PANEL viewport (not the end of the content
// flow) — position:fixed takes it out of normal flow regardless of where
// it sits in the DOM, so it stays anchored as a footer bar rather than
// floating wherever the content above it happens to end.
function _promoBannerHtml() {
  return `
    <a href="https://socialintent.app/" target="_blank" rel="noopener" style="
      position:fixed; bottom:0; left:0; right:0; z-index:100;
      display:block; padding:12px 16px; box-sizing:border-box;
      background: linear-gradient(135deg, #0a1929 0%, #123049 100%);
      border-top: 2px solid #22d3ee; box-shadow: 0 -2px 10px rgba(0,0,0,0.25);
      text-decoration:none; color:#ffffff;
    ">
      <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
        <img src="icons/icon32.png" width="20" height="20" style="border-radius:5px; display:block;" />
        <span style="font-weight:600; font-size:13px;">Social Intent</span>
      </div>
      <div style="font-size:12px; color:#a9d6e5; line-height:1.4; margin-bottom:10px;">
        Get tips, best practices, and the full guide to getting the most out of this tool.
      </div>
      <span style="display:inline-block; background:#22d3ee; color:#0a1929; font-size:12px; font-weight:600; padding:5px 12px; border-radius:6px;">
        Visit socialintent.app →
      </span>
    </a>
  `;
}

function renderQueueDoneScreen() {
  const wireReset = () => {
    document.getElementById("resetBtn").onclick = () => {
      chrome.storage.local.set({ itemStatus: {}, doneUrls: {} }, () => {
        Object.keys(sessionStatusOverrides).forEach((k) => delete sessionStatusOverrides[k]);
        renderQueueView();
      });
    };
  };

  getBackendConfig((cfg) => {
    if (!cfg.configured) {
      contentEl.innerHTML = `<div id="doneScreen" style="padding-bottom:120px;">That's the whole queue.<br><button id="resetBtn">Reset progress</button></div>${_promoBannerHtml()}`;
      wireReset();
      return;
    }
    getProfiles((profiles) => {
      const allProfiles = Object.values(profiles);
      // The old version filtered on the locally-cached pendingCount field,
      // which came from a scan's OWN pre-dedup report count (or a stale
      // leftover if the scan that set "Last run" never actually
      // completed) — not the true Airtable backlog. That's exactly what
      // let a product with real new leads (25 new, confirmed via a fresh
      // scan) show nothing here, because the cached number said 0. Query
      // the live count for every profile instead — same /pending-preview
      // endpoint the Search tab now uses, so both places always agree.
      Promise.all(
        allProfiles.map((prof) =>
          fetch(`${cfg.url}/pending-preview?product=${encodeURIComponent(prof.product)}&limit=1`, {
            headers: { Authorization: `Bearer ${cfg.apiKey}` },
          })
            .then((r) => (r.ok ? r.json() : { totalPending: 0 }))
            .then((preview) => ({ prof, total: preview.totalPending || 0 }))
            .catch(() => ({ prof, total: 0 }))
        )
      ).then((results) => {
      const withPending = results.filter((r) => r.total > 0);
      // A batch can already be running for one of these (started from the
      // Search tab, or from this same screen a moment ago) — check before
      // rendering, so this doesn't present "start processing" as a fresh
      // opportunity when it's already in flight. That mismatch is exactly
      // what made this screen look disconnected from Search.
      getActiveRuns((runs) => {
        const pendingHtml = withPending.length
          ? `
            <div class="pendingCallout">
              <div class="pendingCalloutHeader">Nothing left to review, but there's more backlog waiting:</div>
              ${withPending.map(({ prof, total }) => {
                const active = runs[`${prof.slug}-batch`];
                const isActive = active && active.status !== "completed" && active.status !== "failed";
                return `
                  <div class="pendingCalloutRow">
                    <span>${prof.name} — ${total} pending</span>
                    ${isActive ? "" : `<button class="processFromQueueBtn primary" data-slug="${prof.slug}">Process next ${prof.count || 10} →</button>`}
                  </div>
                  <div id="queueBatchStatus-${prof.slug}" class="miniStatus">${isActive ? "Already processing…" : ""}</div>
                `;
              }).join("")}
            </div>
          `
          : "";
        // "Reset progress" only clears local chrome.storage — meaningless
        // in cloud mode, where every item's status lives on the backend
        // (Airtable) and is never derived from local storage. Showing it
        // here made it look like it should un-mark completed items; it
        // silently did nothing. Local mode (above) is the one place it's
        // real, since that's the only mode where status IS local storage.
        contentEl.innerHTML = `<div id="doneScreen" style="padding-bottom:120px;">That's the whole queue.${pendingHtml}<br><div class="helpText">Item status here is shared on the backend, not stored locally — nothing to reset.</div></div>${_promoBannerHtml()}`;
        contentEl.querySelectorAll(".processFromQueueBtn").forEach((btn) => {
          const slug = btn.dataset.slug;
          const prof = profiles[slug];
          const statusEl = document.getElementById(`queueBatchStatus-${slug}`);
          btn.onclick = () => processBatch(prof, statusEl, btn);
        });
        // Already-running rows (no button, since isActive suppressed it
        // above) still need their status polled so "Already processing…"
        // updates live and the row flips to normal once it completes.
        withPending.forEach(({ prof }) => {
          const active = runs[`${prof.slug}-batch`];
          const isActive = active && active.status !== "completed" && active.status !== "failed";
          if (isActive) {
            getBackendConfig((cfg2) => {
              const statusEl = document.getElementById(`queueBatchStatus-${prof.slug}`);
              pollJob(active.runId, cfg2, statusEl, null, `${prof.slug}-batch`, "batch", prof.slug);
            });
          }
        });
      });
      });
    });
  });
}

function copyBtnHandler(getText, msgEl) {
  return () => {
    navigator.clipboard.writeText(getText()).then(() => {
      msgEl.textContent = "Copied to clipboard";
      setTimeout(() => { if (msgEl.textContent === "Copied to clipboard") msgEl.textContent = ""; }, 2000);
    });
  };
}

function renderFromQueue() {
  if (currentView !== "queue") return;
  getAutoSkipSetting((autoSkip) => {
    migrateIfNeeded((localMap) => {
      let remaining = QUEUE.filter((item) => !statusOf(item, localMap));
      const actionable = QUEUE.filter((item) => item.action !== "skip");

      // Auto-skip mode: silently resolve skip items (mark done, no review
      // screen) instead of stopping the queue on each one.
      if (autoSkip) {
        while (remaining.length && remaining[0].action === "skip") {
          const skipItem = remaining[0];
          sessionStatusOverrides[skipItem.postUrl] = "done";
          updateItemStatus(skipItem, "done");
          remaining = remaining.slice(1);
        }
      }

      const doneActionable = actionable.filter((item) => statusOf(item, localMap)).length;

      if (remaining.length === 0) {
        progressEl.textContent = `${doneActionable} / ${actionable.length} — all done`;
        renderQueueDoneScreen();
        return;
      }

      const item = remaining[0];
      const isSkip = item.action === "skip";

      // Nothing that touches the browser (tab switching, clipboard) fires
      // until this is explicitly started — see queueSessionStarted above.
      if (!queueSessionStarted) {
        progressEl.textContent = `${doneActionable} / ${actionable.length} done — ${remaining.length} left in queue`;
        contentEl.innerHTML = `
          <div id="doneScreen">
            <div style="margin-bottom:12px;">${remaining.length} item${remaining.length === 1 ? "" : "s"} ready to review, starting with <strong>${item.name}</strong>.</div>
            <button id="startQueueBtn" class="primary">Start reviewing →</button>
            <div class="helpText" style="margin-top:8px;">Opens LinkedIn to the first post and copies its comment — nothing happens until you click this.</div>
          </div>
        `;
        document.getElementById("startQueueBtn").onclick = () => {
          queueSessionStarted = true;
          chrome.storage.local.set({ queueSessionStarted: true });
          renderFromQueue();
        };
        return;
      }

      const isConnect = item.action === "comment+connect";
      progressEl.textContent = `${doneActionable} / ${actionable.length} done — ${remaining.length} left in queue`;

      // Arriving at a new current item — advancing after Mark Done, once a
      // session has been explicitly started — should be signal enough to
      // load the post and have its comment ready to paste. No separate
      // manual "Open Post" / "Copy Comment" click needed after that.
      if (!isSkip && item.postUrl !== lastAutoLoadedPostUrl) {
        lastAutoLoadedPostUrl = item.postUrl;
        if (item.comment) {
          navigator.clipboard.writeText(item.comment).catch(() => {
            // Clipboard writes outside a direct click can be blocked by the
            // browser depending on activation timing — Copy Comment below
            // still works as a manual fallback if this silently no-ops.
          });
        }
        openInWorkingTab(item.postUrl);
      }

      const scoreClass = `score-${item.score}`;
      let html = `
        <div>
          <span id="name">${item.name}</span>
          <span id="scoreBadge" class="${scoreClass}">${item.score}/5 — ${SCORE_LABELS[item.score] || ""}</span>
          ${item.isInfluencer ? '<span id="influencerBadge">Influencer</span>' : ""}
        </div>
        ${item.sourceLabel ? `<div class="sourceLabel">${item.sourceLabel}</div>` : ""}
      `;

      if (item.email) {
        const statusClass = `status-${(item.emailStatus || "unknown").toLowerCase()}`;
        html += `<div class="emailLine">${item.email} — <span class="${statusClass}">${item.emailStatus || "unverified"}</span></div>`;
      }

      if (isSkip) {
        // "Could not verify profile" means the enrich_profile API call
        // itself failed (a transient RichAPI error) — distinct from a
        // genuine "Outside ICP" skip, which is a stable fact about the
        // person that re-checking won't change. Only offer Retry for the
        // former; Generate Comment Anyway (a bypass, not a retry) stays
        // available either way. Live feedback (2026-07-21): a RichAPI
        // account with plenty of credits still hit this, with no way to
        // just try the same call again short of a full batch re-run.
        const isVerificationFailure = (item.skipReason || "").startsWith("Could not verify profile");
        html += `<div id="skipNote">Skip. ${item.skipReason || "No reason given."}</div>`;
        html += `
          <div id="generateMsg" style="font-size:11px;min-height:14px;"></div>
          <div class="row">
            ${isVerificationFailure ? `<button id="retryEnrichmentBtn">${ICONS.zap} Retry Verification</button>` : ""}
            <button id="generateCommentBtn">${ICONS.zap} Generate Comment Anyway</button>
          </div>
        `;
      } else {
        html += `
          <div class="label">Comment</div>
          <textarea id="commentBox">${item.comment || ""}</textarea>
          <div id="regenerateMsg" style="font-size:11px;min-height:14px;"></div>
          <div class="row">
            <button id="copyCommentBtn">Copy Comment</button>
            <button id="regenerateCommentBtn">${ICONS.zap} Regenerate</button>
          </div>
        `;
        if (isConnect) {
          const reasonLabel = item.connectReason === "influencer"
            ? "Influencer — peer connect, not a personal buyer"
            : "Direct buyer — they asked for this";
          html += `
            <div class="label">${reasonLabel}</div>
            <div class="label">Connection request note (200 char max)</div>
            <textarea id="connectBox" class="small">${item.connectionNote || ""}</textarea>
            <div class="row"><button id="copyConnectBtn">Copy Connection Note</button></div>
            <div class="label">Follow-up DM (send after they accept — find it later in the Follow-ups tab)</div>
            <textarea id="dmBox" class="small">${item.dmMessage || ""}</textarea>
            <div class="row"><button id="copyDmBtn">Copy DM</button></div>
          `;
        }
        if (item.email) {
          html += `<div class="row"><button id="copyEmailBtn">Copy Email</button></div>`;
        }
      }

      html += `
        <div id="copiedMsg"></div>
        <div class="row">
          <button id="openProfileBtn">Open Profile</button>
          <button id="openPostBtn" class="primary">Open Post</button>
        </div>
        <div class="row">
          ${isSkip
            ? '<button id="nextBtn">Confirm Skip →</button>'
            : isConnect
              ? '<button id="nextBtnNoFollowup">Mark Done → skip follow-up</button><button id="nextBtnFollowup" class="primary">Mark Done → add follow-up</button>'
              : '<button id="nextBtn">Mark Done →</button>'}
        </div>
        ${isConnect ? '<div class="helpText">Only "add follow-up" if you actually sent the connection request — otherwise this won\'t show up in the Follow-ups tab.</div>' : ""}
      `;

      contentEl.innerHTML = html;
      const copiedMsg = document.getElementById("copiedMsg");

      document.getElementById("openProfileBtn").onclick = () => openInWorkingTab(item.profileUrl);
      document.getElementById("openPostBtn").onclick = () => openInWorkingTab(item.postUrl);

      if (isSkip) {
        const generateBtn = document.getElementById("generateCommentBtn");
        const generateMsg = document.getElementById("generateMsg");
        getBackendConfig((cfg) => {
          if (!cfg.configured) {
            generateBtn.disabled = true;
            generateMsg.textContent = "Cloud mode only — configure a backend in Settings.";
            generateMsg.style.color = "#a15c00";
            return;
          }
          generateBtn.onclick = () => {
            generateBtn.disabled = true;
            generateMsg.textContent = "Generating…";
            generateMsg.style.color = "#555";
            fetch(`${cfg.url}/queue/generate-comment`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
              body: JSON.stringify({ postUrl: item.postUrl }),
            })
              .then((r) => (r.ok ? r.json() : r.json().then((e) => Promise.reject(e.detail || r.status))))
              .then((res) => {
                // Mutate the item in place and re-render — this turns the
                // skip card into a normal comment card immediately, no
                // separate reload needed.
                item.action = "comment";
                item.comment = res.comment;
                item.skipReason = null;
                renderFromQueue();
              })
              .catch((e) => {
                generateMsg.textContent = `Failed: ${e}`;
                generateMsg.style.color = "#b8003c";
                generateBtn.disabled = false;
              });
          };

          const retryBtn = document.getElementById("retryEnrichmentBtn");
          if (retryBtn) {
            retryBtn.onclick = () => {
              retryBtn.disabled = true;
              generateMsg.textContent = "Retrying verification…";
              generateMsg.style.color = "#555";
              fetch(`${cfg.url}/queue/retry-enrichment`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
                body: JSON.stringify({ postUrl: item.postUrl }),
              })
                .then((r) => (r.ok ? r.json() : r.json().then((e) => Promise.reject(e.detail || r.status))))
                .then((res) => {
                  item.action = res.action;
                  item.skipReason = res.skipReason || null;
                  if (res.action !== "skip") {
                    item.comment = res.comment;
                    item.connectionNote = res.connectionNote;
                    item.dmMessage = res.dmMessage;
                  }
                  renderFromQueue();
                })
                .catch((e) => {
                  generateMsg.textContent = `Retry failed: ${e}`;
                  generateMsg.style.color = "#b8003c";
                  retryBtn.disabled = false;
                });
            };
          }
        });
      }

      if (!isSkip) {
        document.getElementById("copyCommentBtn").onclick = copyBtnHandler(
          () => document.getElementById("commentBox").value,
          copiedMsg
        );
        // Live feedback (2026-07-21): a handful of pre-fix records have a
        // permanently blank Comment (the empty-draft bug fixed in pipeline
        // v1.6.0), and there was no way to recover one short of manually
        // editing Airtable. Reuses the same /queue/generate-comment
        // endpoint the skip-item "Generate Comment Anyway" flow already
        // uses — it isn't actually gated on the item being a skip, it just
        // needs postUrl + stored commentary, so it works here unchanged.
        const regenerateBtn = document.getElementById("regenerateCommentBtn");
        const regenerateMsg = document.getElementById("regenerateMsg");
        getBackendConfig((cfg) => {
          if (!cfg.configured) {
            regenerateBtn.disabled = true;
            return;
          }
          regenerateBtn.onclick = () => {
            regenerateBtn.disabled = true;
            regenerateMsg.textContent = "Generating…";
            regenerateMsg.style.color = "#555";
            fetch(`${cfg.url}/queue/generate-comment`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
              body: JSON.stringify({ postUrl: item.postUrl }),
            })
              .then((r) => (r.ok ? r.json() : r.json().then((e) => Promise.reject(e.detail || r.status))))
              .then((res) => {
                item.comment = res.comment;
                document.getElementById("commentBox").value = res.comment || "";
                regenerateMsg.textContent = "Regenerated.";
                regenerateMsg.style.color = "#0a7d2c";
                regenerateBtn.disabled = false;
              })
              .catch((e) => {
                regenerateMsg.textContent = `Failed: ${e}`;
                regenerateMsg.style.color = "#b8003c";
                regenerateBtn.disabled = false;
              });
          };
        });
      }
      if (isConnect) {
        document.getElementById("copyConnectBtn").onclick = copyBtnHandler(
          () => document.getElementById("connectBox").value,
          copiedMsg
        );
        document.getElementById("copyDmBtn").onclick = copyBtnHandler(
          () => document.getElementById("dmBox").value,
          copiedMsg
        );
      }
      if (item.email && !isSkip) {
        document.getElementById("copyEmailBtn").onclick = copyBtnHandler(() => item.email, copiedMsg);
      }

      const advance = (newStatus) => {
        updateItemStatus(item, newStatus);
        // The auto-open/auto-copy for whichever item lands on top happens
        // centrally at the start of renderFromQueue() (keyed off
        // lastAutoLoadedPostUrl), so advancing here is just a re-render.
        renderFromQueue();
      };

      if (isConnect) {
        // Two explicit choices — a comment+connect item doesn't automatically
        // mean the connection request actually got sent. Only "add follow-up"
        // queues it into the Follow-ups tab; the extension has no way to
        // verify a connection was actually sent, so this has to be a choice,
        // not an assumption.
        document.getElementById("nextBtnNoFollowup").onclick = () => advance("done");
        document.getElementById("nextBtnFollowup").onclick = () => advance("queued_followup");
      } else {
        document.getElementById("nextBtn").onclick = () => advance("done");
      }
    });
  });
}

// ---------- FOLLOW-UPS VIEW ----------

function renderFollowupsView() {
  progressEl.textContent = "";
  if (QUEUE.length === 0) {
    loadQueue().then((queue) => { QUEUE = queue; renderFollowupsView(); });
    return;
  }
  migrateIfNeeded((localMap) => {
    const pending = QUEUE.filter((item) => statusOf(item, localMap) === "queued_followup");

    contentEl.innerHTML = `
      <div id="notifLeadsSection"></div>
      <input type="text" id="followupSearch" placeholder="Search by name…" />
      <div id="followupCount" style="font-size:12px;color:#555;margin:6px 0;"></div>
      <div id="followupList"></div>
    `;
    const searchInput = document.getElementById("followupSearch");
    const countEl = document.getElementById("followupCount");
    const listEl = document.getElementById("followupList");
    renderNotifLeadsSection();

    function renderList() {
      const filterText = searchInput.value.trim().toLowerCase();
      const filtered = filterText
        ? pending.filter((i) => i.name.toLowerCase().includes(filterText))
        : pending;
      countEl.textContent = `${pending.length} awaiting follow-up${filterText ? `, ${filtered.length} matching "${filterText}"` : ""}`;

      if (filtered.length === 0) {
        listEl.innerHTML = `<div style="font-size:12px;color:#777;">${
          pending.length === 0
            ? "No pending follow-ups yet. They show up here once a connect+comment item is marked done in the Queue."
            : "No names match."
        }</div>`;
        return;
      }

      listEl.innerHTML = "";
      filtered.forEach((item) => {
        const card = document.createElement("div");
        card.className = "profileCard";
        card.innerHTML = `
          <div class="pname">${item.name} ${item.isInfluencer ? '<span id="influencerBadge">Influencer</span>' : ""}</div>
          <div class="psummary">${item.sourceLabel || "Source unrecorded"} — <a href="#" class="postLink">view original post</a></div>
          <div class="label">Connection note sent</div>
          <textarea class="small connNoteRef" readonly>${item.connectionNote || ""}</textarea>
          <div class="label">Follow-up DM</div>
          <textarea class="small dmBox">${item.dmMessage || ""}</textarea>
          <div class="copiedMsgSmall" style="font-size:11px;color:#0a7d2c;height:14px;"></div>
          <div class="row">
            <button class="copyDmSmallBtn">Copy DM</button>
            <button class="openPostSmallBtn">Open Post</button>
          </div>
          <div class="row"><button class="markFollowedBtn primary">Mark Followed Up →</button></div>
        `;
        listEl.appendChild(card);

        const msgEl = card.querySelector(".copiedMsgSmall");
        card.querySelector(".postLink").onclick = (e) => { e.preventDefault(); openInWorkingTab(item.postUrl); };
        card.querySelector(".openPostSmallBtn").onclick = () => openInWorkingTab(item.postUrl);
        card.querySelector(".copyDmSmallBtn").onclick = () => {
          const text = card.querySelector(".dmBox").value;
          navigator.clipboard.writeText(text).then(() => {
            msgEl.textContent = "Copied";
            setTimeout(() => { msgEl.textContent = ""; }, 2000);
          });
        };
        card.querySelector(".markFollowedBtn").onclick = () => {
          updateItemStatus(item, "done", () => renderFollowupsView());
        };
      });
    }

    searchInput.oninput = renderList;
    renderList();
  });
}

function renderNotifLeadsSection() {
  const sectionEl = document.getElementById("notifLeadsSection");
  if (!sectionEl) return;
  getNotificationLeads((leads) => {
    if (!leads.length) { sectionEl.innerHTML = ""; return; }
    sectionEl.innerHTML = `
      <div class="pendingCallout">
        <div class="pendingCalloutHeader">${leads.length} repl${leads.length === 1 ? "y" : "ies"} to check (found while browsing LinkedIn notifications):</div>
        ${leads.map((lead, i) => `
          <div class="pendingCalloutRow">
            <span>${lead.name} — "${lead.snippet.slice(0, 60)}${lead.snippet.length > 60 ? "…" : ""}"</span>
          </div>
          <div class="row">
            <button class="openNotifLeadBtn" data-i="${i}">Open</button>
            <button class="dismissNotifLeadBtn" data-i="${i}">Dismiss</button>
          </div>
        `).join("")}
      </div>
    `;
    sectionEl.querySelectorAll(".openNotifLeadBtn").forEach((btn) => {
      btn.onclick = () => openInWorkingTab(leads[parseInt(btn.dataset.i, 10)].url);
    });
    sectionEl.querySelectorAll(".dismissNotifLeadBtn").forEach((btn) => {
      btn.onclick = () => {
        const lead = leads[parseInt(btn.dataset.i, 10)];
        removeNotificationLead(lead.name, lead.url, () => renderNotifLeadsSection());
      };
    });
  });
}

// ---------- SEARCH PROFILES VIEW ----------

// Search profiles now live in Airtable via the backend (matching how
// Products already do) instead of chrome.storage.local only — live
// feedback (2026-07-21): having Products server-side/shared but Search
// Profiles local-only-per-browser was an inconsistent split for the same
// class of data, and meant a fresh browser/profile had zero search setup
// with no way to recover it short of re-entering everything by hand.
// Every existing call site in this file already goes through ONLY these
// two functions with this exact callback shape, so changing what's
// underneath them doesn't require touching those call sites. Local mode
// (no backend configured) is completely unchanged — this only applies
// once a backend is configured, same gating Products already uses.
// chrome.storage.local is kept as a fast local cache and an offline
// fallback, but Airtable is the source of truth once cloud mode is on.
let _profilesMigrated = false;

function getProfiles(cb) {
  getBackendConfig((cfg) => {
    if (!cfg.configured) {
      chrome.storage.local.get(["searchProfiles"], (r) => cb(r.searchProfiles || {}));
      return;
    }
    fetch(`${cfg.url}/profiles`, { headers: { Authorization: `Bearer ${cfg.apiKey}` } })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((data) => {
        const remote = {};
        (data.profiles || []).forEach((p) => {
          remote[p.slug] = p;
        });
        if (Object.keys(remote).length === 0 && !_profilesMigrated) {
          _profilesMigrated = true;
          chrome.storage.local.get(["searchProfiles"], (r) => {
            const local = r.searchProfiles || {};
            const slugs = Object.keys(local);
            if (!slugs.length) {
              cb(remote);
              return;
            }
            // One-time migration: this browser has profiles from before
            // Airtable-backed storage existed, and the backend has none
            // yet — push them up once instead of silently losing them.
            console.log(`[social-intent] migrating ${slugs.length} local search profile(s) to Airtable`);
            Promise.all(
              slugs.map((slug) =>
                fetch(`${cfg.url}/profiles`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
                  body: JSON.stringify(local[slug]),
                }).catch(() => null)
              )
            ).then(() => getProfiles(cb));
          });
          return;
        }
        cb(remote);
        chrome.storage.local.set({ searchProfiles: remote }); // keep local cache warm
      })
      .catch(() => {
        // Backend unreachable — fall back to the local cache rather than
        // the whole Search tab going blank.
        chrome.storage.local.get(["searchProfiles"], (r) => cb(r.searchProfiles || {}));
      });
  });
}

function saveProfiles(profiles, cb) {
  chrome.storage.local.set({ searchProfiles: profiles }, cb); // local cache, always kept in sync
  getBackendConfig((cfg) => {
    if (!cfg.configured) return; // local mode: local storage IS the store, nothing further to do
    fetch(`${cfg.url}/profiles`, { headers: { Authorization: `Bearer ${cfg.apiKey}` } })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((data) => {
        const remoteSlugs = (data.profiles || []).map((p) => p.slug);
        const keepSlugs = new Set(Object.keys(profiles));
        // Deletes: a slug present on the backend but no longer in the
        // dict being saved (the delete-profile flow removes it from the
        // dict first, then calls saveProfiles with what's left).
        remoteSlugs
          .filter((slug) => !keepSlugs.has(slug))
          .forEach((slug) => {
            fetch(`${cfg.url}/profiles/${encodeURIComponent(slug)}`, {
              method: "DELETE",
              headers: { Authorization: `Bearer ${cfg.apiKey}` },
            }).catch((e) => console.error("[social-intent] failed to delete profile from backend:", slug, e));
          });
      })
      .catch(() => {}); // best-effort — an upsert-only push below still keeps most state in sync
    // Upserts: push every profile currently in the dict. Simplest correct
    // approach for a handful of profiles at a time — some of these are
    // no-op re-writes of unchanged profiles, a small inefficiency traded
    // for not having to diff what specifically changed.
    Object.values(profiles).forEach((p) => {
      fetch(`${cfg.url}/profiles`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify(p),
      }).catch((e) => console.error("[social-intent] failed to sync profile to backend:", p.slug, e));
    });
  });
}
function slugify(name) {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function profileSummary(p) {
  const emails = p.fetchEmails ? "verified emails" : "no emails";
  const loc = p.location ? `, in ${p.location}` : "";
  return `${p.count} × ${p.titles} at ${p.companySizeMin}-${p.companySizeMax} person ${p.companyType} companies${loc}, posted about "${p.intentKeywords}" (${p.recency}), ${emails}`;
}

function runCommandText(p) {
  return `Run the saved social-intent-leads search profile "${p.name}" (~/Downloads/${PROFILES_EXPORT_DIR}/${p.slug}.json).`;
}

function exportProfileFile(p) {
  const json = JSON.stringify(p, null, 2);
  const url = "data:application/json;charset=utf-8," + encodeURIComponent(json);
  chrome.downloads.download({
    url,
    filename: `${PROFILES_EXPORT_DIR}/${p.slug}.json`,
    conflictAction: "overwrite",
    saveAs: false,
  });
}

// Active runs/batches are persisted in chrome.storage (not just an in-memory
// var), keyed by profile slug, so navigating away and back — or closing and
// reopening the panel — doesn't lose track of an in-progress job and let a
// button be clicked again, silently starting a duplicate.

function getActiveRuns(cb) {
  chrome.storage.local.get(["activeRuns"], (r) => cb(r.activeRuns || {}));
}
function setActiveRun(slug, data, cb) {
  getActiveRuns((runs) => {
    if (data === null) delete runs[slug];
    else runs[slug] = data;
    chrome.storage.local.set({ activeRuns: runs }, () => cb && cb());
  });
}

function touchLastRun(slug, extra, opts) {
  // bumpTimestamp defaults true — but a run just STARTING must not bump it,
  // or a run that later fails/gets orphaned (e.g. a backend redeploy
  // killing it mid-flight) leaves "Last run: just now" showing next to
  // whatever stats happen to already be cached from the PREVIOUS genuine
  // success, making a silent failure look identical to a fresh one. Only
  // a real completion (which always passes fresh matching stats in extra)
  // should move the needle on "when did this last actually run."
  const bumpTimestamp = !opts || opts.bumpTimestamp !== false;
  getProfiles((current) => {
    if (!current[slug]) return;
    current[slug] = { ...current[slug], ...(bumpTimestamp ? { lastRunAt: Date.now() } : {}), ...extra };
    saveProfiles(current);
  });
}

function scanInCloud(p, statusEl, btnEl) {
  getActiveRuns((runs) => {
    const existing = runs[p.slug];
    if (existing && existing.kind === "scan" && existing.status !== "completed" && existing.status !== "failed") {
      getBackendConfig((cfg) => pollJob(existing.runId, cfg, statusEl, btnEl, p.slug, "scan"));
      return;
    }
    getBackendConfig((cfg) => {
      if (!cfg.configured) {
        statusEl.textContent = "No backend configured — set one up in Settings first.";
        statusEl.style.color = "#b8003c";
        return;
      }
      if (btnEl) btnEl.disabled = true;
      statusEl.textContent = "Starting scan…";
      statusEl.style.color = "#555";
      fetch(`${cfg.url}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify(p),
      })
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
        .then((run) => {
          setActiveRun(p.slug, { runId: run.runId, kind: "scan", status: "running" }, () => {
            touchLastRun(p.slug, { lastRunId: run.runId }, { bumpTimestamp: false });
            pollJob(run.runId, cfg, statusEl, btnEl, p.slug, "scan");
          });
        })
        .catch((e) => {
          statusEl.textContent = `Failed to start scan (${e})`;
          statusEl.style.color = "#b8003c";
          if (btnEl) btnEl.disabled = false;
        });
    });
  });
}

// Free preview of what "Process next N" is actually about to spend money
// on — pure Airtable read (scores were already set for free in phase 1),
// so it can be shown proactively instead of the batch button being a
// black box. Lets you judge "is this next batch still good matches, or
// scraping the bottom of the pool" before deciding to run it.
function loadPendingPreview(p, cfg, targetEl, extras) {
  const { lastRunLineEl, batchBtnRowEl, batchMsgEl } = extras || {};
  const limit = p.count || 10;
  fetch(`${cfg.url}/pending-preview?product=${encodeURIComponent(p.product)}&limit=${limit}`, {
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
  })
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then((preview) => {
      const total = preview.totalPending || 0;

      // Live count replaces the "(checking…)" placeholder and any stale
      // cached number that was there before — this is the actual current
      // Airtable backlog, not a locally-derived guess.
      if (lastRunLineEl) {
        // This is the whole product's backlog (every search profile
        // targeting it), not just what THIS profile's last scan found —
        // get_pending_batch filters by product only. Labeled explicitly
        // after live confusion (2026-07-21): a scan reporting "80 new"
        // next to a "56 pending" on the same card read as leads going
        // missing, when the two numbers are simply scoped differently.
        lastRunLineEl.textContent = `Last run: ${relativeTime(p.lastRunAt)}${total ? ` — ${total} pending processing (product-wide backlog)` : ""}`;
      }
      // Keep the cached value roughly in sync so a fresh render before
      // the next live check still shows something reasonable.
      getProfiles((current) => {
        if (current[p.slug]) {
          current[p.slug] = { ...current[p.slug], pendingCount: total };
          saveProfiles(current);
        }
      });

      if (batchBtnRowEl) {
        if (total > 0) {
          batchBtnRowEl.innerHTML = `<div class="row"><button class="processBatchBtn primary">Process next ${p.count || 10} →</button></div>`;
          const batchBtn = batchBtnRowEl.querySelector(".processBatchBtn");
          batchBtn.onclick = () => processBatch(p, batchMsgEl, batchBtn);
          // A batch could already be running (started before this card
          // re-rendered) — resume tracking against the fresh button
          // instead of leaving it clickable while one's in flight.
          getActiveRuns((runs) => {
            const active = runs[`${p.slug}-batch`];
            if (active && active.status !== "completed" && active.status !== "failed") {
              pollJob(active.runId, cfg, batchMsgEl, batchBtn, `${p.slug}-batch`, "batch", p.slug);
            }
          });
        } else {
          batchBtnRowEl.innerHTML = "";
        }
      }

      if (!targetEl) return;
      if (!total) {
        targetEl.innerHTML = "";
        return;
      }
      const dist = preview.scoreDistribution || {};
      const mix = ["5", "4", "3", "2", "1"]
        .filter((s) => dist[s])
        .map((s) => `${s}×${dist[s]}`)
        .join(", ");
      const next = preview.nextBatch || [];
      const nextAvg = next.length
        ? (next.reduce((sum, i) => sum + (i.score || 0), 0) / next.length).toFixed(1)
        : "—";
      const flags = [];
      if (preview.directBuyerCount) flags.push(`${preview.directBuyerCount} direct-buyer`);
      if (preview.influencerCount) flags.push(`${preview.influencerCount} influencer`);
      targetEl.innerHTML = `
        <div class="previewLine">Pool score mix: ${mix || "—"}${flags.length ? ` · ${flags.join(", ")}` : ""}</div>
        <div class="previewLine">Next ${next.length} would average ${nextAvg}/5 — ${next.length && nextAvg < 3 ? "mostly weaker matches, might not be worth it yet" : next.length ? "solid matches" : ""}</div>
      `;
    })
    .catch(() => {
      if (targetEl) targetEl.textContent = "";
      if (lastRunLineEl) lastRunLineEl.textContent = `Last run: ${relativeTime(p.lastRunAt)}`;
    });
}

function processBatch(p, statusEl, btnEl) {
  if (!p.lastRunId) return;
  getActiveRuns((runs) => {
    const existing = runs[`${p.slug}-batch`];
    if (existing && existing.status !== "completed" && existing.status !== "failed") {
      getBackendConfig((cfg) => pollJob(existing.runId, cfg, statusEl, btnEl, `${p.slug}-batch`, "batch", p.slug));
      return;
    }
    getBackendConfig((cfg) => {
      if (!cfg.configured) return;
      if (btnEl) btnEl.disabled = true;
      statusEl.textContent = "Starting batch…";
      statusEl.style.color = "#555";
      fetch(`${cfg.url}/runs/${p.lastRunId}/process-batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({ profile: p, batchSize: p.count || 10 }),
      })
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
        .then((run) => {
          setActiveRun(`${p.slug}-batch`, { runId: run.runId, kind: "batch", status: "running" }, () => {
            pollJob(run.runId, cfg, statusEl, btnEl, `${p.slug}-batch`, "batch", p.slug);
          });
        })
        .catch((e) => {
          statusEl.textContent = `Failed to start batch (${e})`;
          statusEl.style.color = "#b8003c";
          if (btnEl) btnEl.disabled = false;
        });
    });
  });
}

function pollJob(jobId, cfg, statusEl, btnEl, activeRunKey, kind, profileSlugForBatch) {
  if (btnEl) btnEl.disabled = true;
  fetch(`${cfg.url}/runs/${jobId}`, { headers: { Authorization: `Bearer ${cfg.apiKey}` } })
    .then((r) => {
      if (!r.ok) {
        // The backend's run-status dict is in-memory only and resets on
        // every redeploy (documented in app.py) — a runId from before a
        // redeploy 404s forever after. r.json() on that error body (e.g.
        // {"detail": "Unknown run_id"}) has no .status field, so run.status
        // was undefined and silently fell into the "still running" branch
        // below — showing "undefined… (locked until this finishes)" and
        // retrying every 4s forever with the button stuck disabled, since
        // only the completed/failed branches ever re-enable it. A 404/401/
        // 5xx here is terminal, not transient — surface it and unlock
        // immediately instead of polling something that will never resolve.
        const err = new Error(`run ${jobId} returned HTTP ${r.status} — likely stale from a backend redeploy`);
        err.terminal = true;
        return Promise.reject(err);
      }
      return r.json();
    })
    .then((run) => {
      if (run.status === "completed") {
        const r = run.report || {};
        if (kind === "scan") {
          // newCount + duplicateCount is the FULL, correct partition of
          // candidatesFound (new-vs-already-in-Airtable). skippedCount is a
          // SEPARATE axis (topic relevance) computed independently over
          // that same set — some off-topic posts are new, some are
          // duplicates, so it isn't a third slice to add on top. Printing
          // all four as if they summed to candidatesFound was genuinely
          // false arithmetic (live-caught 2026-07-21: 80 new + 129 already
          // seen + 41 off-topic = 250, not the 209 actually found) and
          // read as leads silently going missing when none were.
          statusEl.textContent = `Scan done — ${r.candidatesFound || 0} found: ${r.newCount ?? 0} new, ${r.duplicateCount ?? 0} already seen (${r.skippedCount || 0} of those off-topic).`;
          // Persisted onto the profile (not just this transient status
          // line) so "did this scan actually find anything" is still
          // answerable later, without needing to have had the panel open
          // when it finished — the card alone used to only ever show
          // "Last run: Xh ago" with no way to tell a healthy scan that
          // found nothing new (fully deduped) from one that's silently
          // broken and finding nothing at all.
          touchLastRun(profileSlugForBatch || activeRunKey, {
            pendingCount: r.pendingBatchCount || 0,
            lastScanFound: r.candidatesFound || 0,
            lastScanNew: r.newCount ?? 0,
            lastScanDuplicate: r.duplicateCount ?? 0,
            lastScanSkipped: r.skippedCount || 0,
          });
        } else {
          statusEl.textContent = `Processed ${r.processed || 0} — ${r.qualified || 0} qualified, ${r.droppedAtIcp || 0} outside ICP. ${r.remainingInPool || 0} left in pool. Check the Queue tab.`;
          touchLastRun(profileSlugForBatch, { pendingCount: r.remainingInPool || 0 });
        }
        statusEl.style.color = "#0a7d2c";
        setActiveRun(activeRunKey, { runId: jobId, kind, status: "completed" }, () => {
          if (btnEl) btnEl.disabled = false;
          if (currentView === "profiles") renderProfilesView();
          // A batch started from the Queue's "nothing left, but more is
          // waiting" screen finishes while the user is still on Queue —
          // reload it so the freshly-processed items show up immediately
          // instead of requiring a tab switch to notice they're ready.
          else if (currentView === "queue" && kind === "batch") renderQueueView();
        });
      } else if (run.status === "failed") {
        statusEl.textContent = `Failed: ${(run.error || "").slice(0, 200)}`;
        statusEl.style.color = "#b8003c";
        setActiveRun(activeRunKey, { runId: jobId, kind, status: "failed" }, () => { if (btnEl) btnEl.disabled = false; });
      } else {
        statusEl.textContent = `${run.status}… (locked until this finishes)`;
        setActiveRun(activeRunKey, { runId: jobId, kind, status: run.status });
        setTimeout(() => pollJob(jobId, cfg, statusEl, btnEl, activeRunKey, kind, profileSlugForBatch), 4000);
      }
    })
    .catch((e) => {
      if (e && e.terminal) {
        // Not transient — retrying would just 404 forever. Clear the stuck
        // run entirely (not just mark it "failed") so the button is usable
        // again immediately; nothing was actually lost since the pending
        // pool this would have processed is untouched in Airtable.
        statusEl.textContent = `Lost track of this run (${e.message}). Nothing was lost, click to retry.`;
        statusEl.style.color = "#a15c00";
        setActiveRun(activeRunKey, null, () => { if (btnEl) btnEl.disabled = false; });
        return;
      }
      statusEl.textContent = "Lost connection while polling — will keep retrying.";
      statusEl.style.color = "#a15c00";
      setTimeout(() => pollJob(jobId, cfg, statusEl, btnEl, activeRunKey, kind, profileSlugForBatch), 8000);
    });
}

function cloneProfile(p) {
  getProfiles((current) => {
    const newSlug = `${p.slug}-copy-${Date.now()}`;
    const clone = {
      ...p,
      name: `${p.name} (copy)`,
      slug: newSlug,
      lastRunAt: null,
      lastRunId: null,
      pendingCount: null,
    };
    current[newSlug] = clone;
    saveProfiles(current, () => renderNewProfileForm(clone));
  });
}

function renderProfilesView() {
  progressEl.textContent = "";
  getBackendConfig((cfg) => {
  getProfiles((profiles) => {
    const names = Object.keys(profiles);
    let html = `
      <div class="modeNote ${cfg.configured ? "cloud" : "local"}">
        ${cfg.configured ? "Cloud mode — scans/batches run on the hosted backend." : "Local mode — runs go through Claude Code instead."}
      </div>
      <div id="profileList"></div><div class="row"><button id="newProfileBtn" class="primary">+ New Search Profile</button></div>`;
    contentEl.innerHTML = html;
    const listEl = document.getElementById("profileList");

    if (names.length === 0) {
      listEl.innerHTML = `<div style="font-size:12px;color:#777;margin-bottom:8px;">No saved searches yet.</div>`;
    } else {
      names.forEach((slug) => {
        const p = profiles[slug];
        const card = document.createElement("div");
        card.className = "profileCard";
        card.innerHTML = `
          <div class="pname">${p.name}</div>
          <div class="psummary">${profileSummary(p)}</div>
          <div class="lastRun" id="lastRunLine-${slug}">Last run: ${relativeTime(p.lastRunAt)}${p.pendingCount ? ` — ${p.pendingCount} pending processing (checking…)` : ""}</div>
          ${p.lastScanFound != null ? `<div class="lastScanStats">Last scan found ${p.lastScanFound}${p.lastScanNew != null ? `: ${p.lastScanNew} new, ${p.lastScanDuplicate ?? 0} already seen (${p.lastScanSkipped ?? 0} of those off-topic)` : ""}</div>` : ""}
          <div id="pendingPreview-${slug}" class="pendingPreview"></div>
          <div class="iconRow">
            ${cfg.configured
              ? `<button class="iconBtn primary scanBtn" title="Scan (search + score)">${ICONS.play}</button>
                 <button class="iconBtn viewQueueBtn" title="View queue for this search only">${ICONS.search}</button>`
              : `<button class="iconBtn primary copyCmdBtn" title="Copy Run Command">${ICONS.clipboard}</button>
                 <button class="iconBtn exportBtn" title="Re-export JSON">${ICONS.download}</button>`}
            <button class="iconBtn editProfileBtn" title="Edit">${ICONS.edit}</button>
            <button class="iconBtn cloneProfileBtn" title="Clone">${ICONS.copy}</button>
            <button class="iconBtn danger deleteBtn" title="Delete">${ICONS.trash}</button>
          </div>
          <div id="scanStatusMsg-${slug}" style="font-size:11px;min-height:14px;margin-top:6px;"></div>
          <div id="batchBtnRow-${slug}"></div>
          <div id="batchStatusMsg-${slug}" style="font-size:11px;min-height:14px;margin-top:6px;"></div>
        `;
        listEl.appendChild(card);

        // Scan and batch are independent, sometimes-concurrent jobs for the
        // same profile (as happened here — a scan and "Process next 50"
        // both running at once) — each needs its own status element, or
        // one's status text silently clobbers the other's mid-poll.
        const scanMsgEl = card.querySelector(`#scanStatusMsg-${slug}`);
        const batchMsgEl = card.querySelector(`#batchStatusMsg-${slug}`);
        card.querySelector(".editProfileBtn").onclick = () => renderNewProfileForm(p);
        card.querySelector(".cloneProfileBtn").onclick = () => cloneProfile(p);
        if (cfg.configured) card.querySelector(".viewQueueBtn").onclick = () => viewQueueForProfile(p);
        card.querySelector(".deleteBtn").onclick = () => {
          getProfiles((current) => {
            delete current[slug];
            saveProfiles(current, renderProfilesView);
          });
        };

        if (cfg.configured) {
          const scanBtn = card.querySelector(".scanBtn");
          scanBtn.onclick = () => scanInCloud(p, scanMsgEl, scanBtn);
          // The "X pending processing" text and Process-next-N button used
          // to be driven by a locally-cached number from the last scan's
          // OWN report (pendingBatchCount) — that counts everything it
          // scored above 0 BEFORE checking Airtable for duplicates, so it
          // doesn't reflect the true accumulated backlog and can drift
          // arbitrarily far from reality (a batch elsewhere draining the
          // real pool wouldn't touch this cached number, an old profile
          // could sit showing a stale count forever). Always fetch the
          // live count instead — the same /pending-preview call already
          // used for the score-mix breakdown, extended to also decide
          // whether to show the button at all and what "X pending" says.
          loadPendingPreview(p, cfg, document.getElementById(`pendingPreview-${slug}`), {
            lastRunLineEl: document.getElementById(`lastRunLine-${slug}`),
            batchBtnRowEl: document.getElementById(`batchBtnRow-${slug}`),
            batchMsgEl,
          });

          // Resume tracking automatically if this profile already has a
          // scan or batch job in flight from before a view switch. Batch
          // resume doesn't require batchBtn to exist (pendingCount can be
          // stale at render time even while a real batch is running) — it
          // just has nowhere to show a "Process next N" button meanwhile.
          getActiveRuns((runs) => {
            const activeScan = runs[slug];
            if (activeScan && activeScan.status !== "completed" && activeScan.status !== "failed") {
              pollJob(activeScan.runId, cfg, scanMsgEl, scanBtn, slug, "scan");
            }
            const activeBatch = runs[`${slug}-batch`];
            if (activeBatch && activeBatch.status !== "completed" && activeBatch.status !== "failed") {
              // No batchBtn to disable here — it's created dynamically by
              // loadPendingPreview() once the live pending count resolves,
              // not synchronously at card-build time anymore. pollJob
              // already guards every btnEl access with `if (btnEl)`.
              pollJob(activeBatch.runId, cfg, batchMsgEl, null, `${slug}-batch`, "batch", slug);
            }
          });
        } else {
          card.querySelector(".copyCmdBtn").onclick = () => {
            navigator.clipboard.writeText(runCommandText(p)).then(() => {
              touchLastRun(slug);
              msgEl.style.color = "#0a7d2c";
              msgEl.textContent = "Copied — paste into Claude Code";
              setTimeout(() => { msgEl.textContent = ""; }, 2500);
            });
          };
          card.querySelector(".exportBtn").onclick = () => {
            exportProfileFile(p);
            msgEl.style.color = "#0a7d2c";
            msgEl.textContent = "Exported to Downloads";
            setTimeout(() => { msgEl.textContent = ""; }, 2500);
          };
        }
      });
    }

    document.getElementById("newProfileBtn").onclick = () => renderNewProfileForm(undefined);
  });
  });
}

function renderNewProfileForm(existing) {
  getBackendConfig((cfg) => {
    if (cfg.configured) {
      fetchProducts(cfg)
        .then((products) => renderNewProfileFormBody(productFieldHtml(products, existing && existing.product), existing, cfg.configured, products))
        .catch(() => renderNewProfileFormBody(productFieldHtml([], existing && existing.product), existing, cfg.configured, []));
    } else {
      renderNewProfileFormBody(productFieldHtml(null, existing && existing.product), existing, cfg.configured, []); // null = local mode, plain text input
    }
  });
}

// A product's ICP (titles, company size, industry, high-intent keywords)
// is the natural starting point for a search targeting it — most searches
// against a product will match its ICP almost exactly. Prefilling saves
// re-typing the same values every time; the fields stay fully editable
// afterward for the cases that need to diverge from the product default.
function applyProductDefaults(product) {
  if (!product) return;
  const titlesEl = document.getElementById("fTitles");
  const sizeMinEl = document.getElementById("fSizeMin");
  const sizeMaxEl = document.getElementById("fSizeMax");
  const companyTypeEl = document.getElementById("fCompanyType");
  const keywordsEl = document.getElementById("fKeywords");
  if (titlesEl && product.icpTitles) titlesEl.value = product.icpTitles;
  if (sizeMinEl && product.icpCompanySizeMin != null) sizeMinEl.value = product.icpCompanySizeMin;
  if (sizeMaxEl && product.icpCompanySizeMax != null) sizeMaxEl.value = product.icpCompanySizeMax;
  if (companyTypeEl && product.icpIndustries) companyTypeEl.value = product.icpIndustries;
  if (keywordsEl && product.highIntentKeywords) keywordsEl.value = product.highIntentKeywords;
}

function productFieldHtml(products, selectedKey) {
  if (products === null) {
    return `<div class="label">Product</div><input type="text" id="fProduct" value="${selectedKey || "pagetest"}" />`;
  }
  if (products.length === 0) {
    return `<div class="label">Product</div><div class="helpText">No products configured yet — add one in the Products tab first.</div><input type="text" id="fProduct" value="${selectedKey || ""}" placeholder="product key" />`;
  }
  const options = products
    .map((p) => `<option value="${p.key}" ${p.key === selectedKey ? "selected" : ""}>${p.name} (${p.key})</option>`)
    .join("");
  return `<div class="label">Product</div><select id="fProduct">${options}</select>`;
}

function renderNewProfileFormBody(productFieldHtmlStr, existing, isCloudMode, products) {
  const p = existing || {
    name: "", count: 10, titles: "", companySizeMin: 50, companySizeMax: 200,
    companyType: "", location: "", intentKeywords: "", recency: "PAST_WEEK", fetchEmails: true,
  };
  contentEl.innerHTML = `
    <div class="label">Profile name</div>
    <input type="text" id="fName" placeholder="e.g. PageTest VPs" value="${p.name}" />

    ${productFieldHtmlStr}

    <div class="label"># of qualified leads wanted</div>
    <input type="number" id="fCount" value="${p.count}" min="1" max="100" />

    <div class="label">Job title(s) — comma separated</div>
    <input type="text" id="fTitles" placeholder="VP Marketing, Head of Marketing" value="${p.titles}" />

    <div class="label">Company size range</div>
    <div class="row2">
      <input type="number" id="fSizeMin" placeholder="Min" value="${p.companySizeMin}" />
      <input type="number" id="fSizeMax" placeholder="Max" value="${p.companySizeMax}" />
    </div>

    <div class="label">Company type / industry</div>
    <input type="text" id="fCompanyType" placeholder="SaaS" value="${p.companyType}" />

    <div class="label">Location — optional, blank means anywhere</div>
    <input type="text" id="fLocation" placeholder="e.g. United Kingdom, or leave blank" value="${p.location || ""}" />

    <div class="label">Intent keyword(s) — comma separated</div>
    <input type="text" id="fKeywords" placeholder="A/B testing" value="${p.intentKeywords}" />

    <div class="label">Recency</div>
    <select id="fRecency">
      <option value="PAST_24H" ${p.recency === "PAST_24H" ? "selected" : ""}>Past 24 hours</option>
      <option value="PAST_WEEK" ${p.recency === "PAST_WEEK" ? "selected" : ""}>Past week</option>
      <option value="PAST_MONTH" ${p.recency === "PAST_MONTH" ? "selected" : ""}>Past month</option>
    </select>

    <div class="row2" style="align-items:center;margin-top:6px;">
      <label style="font-size:12px;"><input type="checkbox" id="fEmails" ${p.fetchEmails ? "checked" : ""} /> Fetch verified emails</label>
    </div>

    <div class="row">
      <button id="cancelBtn">Cancel</button>
      <button id="saveBtn" class="primary">${existing ? "Save Changes" : "Save"}</button>
    </div>
  `;

  const productSelectEl = document.getElementById("fProduct");
  if (productSelectEl && productSelectEl.tagName === "SELECT" && products && products.length) {
    const productByKey = Object.fromEntries(products.map((prod) => [prod.key, prod]));
    // New profile: prefill from whichever product is selected by default
    // (the first in the list) as soon as the form opens. Editing an
    // existing profile leaves its saved values alone on open — only a
    // deliberate product change below reloads defaults, so opening an old
    // search for a tweak doesn't clobber values it already has.
    if (!existing) applyProductDefaults(productByKey[productSelectEl.value]);
    productSelectEl.onchange = () => applyProductDefaults(productByKey[productSelectEl.value]);
  }

  document.getElementById("cancelBtn").onclick = renderProfilesView;
  document.getElementById("saveBtn").onclick = () => {
    const name = document.getElementById("fName").value.trim();
    if (!name) { alert("Give this search a name."); return; }
    // Editing keeps the original slug (its identity) even if the display
    // name changes — creating fresh always derives a new one.
    const slug = existing ? existing.slug : slugify(name);
    const profile = {
      ...(existing || {}),
      name,
      slug,
      product: document.getElementById("fProduct").value.trim() || "pagetest",
      count: parseInt(document.getElementById("fCount").value, 10) || 10,
      titles: document.getElementById("fTitles").value.trim() || "VP Marketing",
      companySizeMin: parseInt(document.getElementById("fSizeMin").value, 10) || 50,
      companySizeMax: parseInt(document.getElementById("fSizeMax").value, 10) || 200,
      companyType: document.getElementById("fCompanyType").value.trim() || "SaaS",
      location: document.getElementById("fLocation").value.trim(),
      intentKeywords: document.getElementById("fKeywords").value.trim(),
      recency: document.getElementById("fRecency").value,
      fetchEmails: document.getElementById("fEmails").checked,
      savedAt: Date.now(),
    };
    getProfiles((current) => {
      current[slug] = profile;
      saveProfiles(current, () => {
        // Local mode only — cloud mode has nothing to download, the profile
        // just lives in the backend/extension, no file needed.
        if (!isCloudMode) exportProfileFile(profile);
        renderProfilesView();
      });
    });
  };
}

// ---------- PRODUCTS VIEW ----------
// Product context (positioning, keywords, ICP) lives in the backend's
// Airtable table, not hardcoded anywhere — this is how a new product gets
// added without touching any code. Cloud mode only; local mode still uses
// SKILL.md's PRODUCT CONFIG table, edited directly since that path already
// requires editing files in the workspace anyway.

function fetchProducts(cfg) {
  return fetch(`${cfg.url}/products`, { headers: { Authorization: `Bearer ${cfg.apiKey}` } })
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then((data) => data.products || []);
}

function renderProductsView() {
  progressEl.textContent = "";
  getBackendConfig((cfg) => {
    if (!cfg.configured) {
      contentEl.innerHTML = `<div style="font-size:12px;color:#777;">Products are managed here in cloud mode only. Configure a backend in Settings first — in local mode, edit the PRODUCT CONFIG table in SKILL.md directly.</div>`;
      return;
    }
    contentEl.innerHTML = `<div id="productList">Loading…</div><div class="row"><button id="newProductBtn" class="primary">+ New Product</button></div>`;
    const listEl = document.getElementById("productList");

    fetchProducts(cfg)
      .then((products) => {
        if (products.length === 0) {
          listEl.innerHTML = `<div style="font-size:12px;color:#777;">No products configured yet.</div>`;
          return;
        }
        listEl.innerHTML = "";
        products.forEach((p) => {
          const card = document.createElement("div");
          card.className = "profileCard";
          const preview = (p.context || "").slice(0, 140);
          card.innerHTML = `
            <div class="pname">${p.name} <span style="font-weight:400;color:#888;">(${p.key})</span></div>
            <div class="psummary">${preview}${(p.context || "").length > 140 ? "…" : ""}</div>
            <div class="row"><button class="editProductBtn">Edit</button></div>
          `;
          listEl.appendChild(card);
          card.querySelector(".editProductBtn").onclick = () => renderProductForm(cfg, p);
        });
      })
      .catch(() => { listEl.innerHTML = `<div style="font-size:12px;color:#b8003c;">Couldn't load products — check Settings.</div>`; });

    document.getElementById("newProductBtn").onclick = () => renderProductForm(cfg, null);
  });
}

function renderProductForm(cfg, existing) {
  const p = existing || {
    key: "", name: "", context: "", landingPageUrl: "", broadKeywords: "", highIntentKeywords: "",
    icpTitles: "", icpCompanySizeMin: 50, icpCompanySizeMax: 200, icpIndustries: "",
  };
  contentEl.innerHTML = `
    <div class="label">Key (short slug, e.g. "pagetest") ${existing ? "— locked, this identifies the product" : ""}</div>
    <input type="text" id="fKey" value="${p.key}" ${existing ? "disabled" : ""} />

    <div class="label">Product name</div>
    <input type="text" id="fName" value="${p.name}" placeholder="e.g. PageTest.AI" />

    <div class="label">Context — what it is, positioning, differentiators, proof points, messaging rules</div>
    <div class="helpText">This is what the AI reads to score posts and draft comments/DMs. The richer and more specific this is, the better the output — paste in your full product doc, not just a one-liner.</div>
    <textarea id="fContext" class="contextArea">${p.context || ""}</textarea>

    <div class="label">Landing page URL — the specific page for this audience</div>
    <div class="helpText">If the AI names this product in a comment and points somewhere, it uses exactly this URL — not a guess pulled from the Context text above, and never the bare root domain.</div>
    <input type="text" id="fLandingUrl" value="${p.landingPageUrl || ""}" placeholder="e.g. https://appbuild.diy/vibes" />

    <div class="label">Broad keywords — comma separated (topic awareness search)</div>
    <input type="text" id="fBroadKw" value="${p.broadKeywords || ""}" placeholder="A/B testing, A/B test" />

    <div class="label">High-intent keywords — comma separated (tool-shopping search)</div>
    <input type="text" id="fHighKw" value="${p.highIntentKeywords || ""}" placeholder="best A/B testing tool, switching from Optimizely" />

    <div class="label">ICP job title(s) — comma separated</div>
    <input type="text" id="fIcpTitles" value="${p.icpTitles || ""}" placeholder="VP Marketing, Head of Marketing" />

    <div class="label">ICP company size range</div>
    <div class="row2">
      <input type="number" id="fIcpSizeMin" value="${p.icpCompanySizeMin ?? 50}" />
      <input type="number" id="fIcpSizeMax" value="${p.icpCompanySizeMax ?? 200}" />
    </div>

    <div class="label">ICP industries — comma separated</div>
    <input type="text" id="fIcpIndustries" value="${p.icpIndustries || ""}" placeholder="SaaS, Software, Internet" />

    <div id="saveMsg" style="font-size:12px;height:16px;margin:6px 0;"></div>
    <div class="row">
      <button id="cancelProductBtn">Cancel</button>
      <button id="saveProductBtn" class="primary">Save</button>
    </div>
  `;

  document.getElementById("cancelProductBtn").onclick = renderProductsView;
  document.getElementById("saveProductBtn").onclick = () => {
    const key = document.getElementById("fKey").value.trim();
    const name = document.getElementById("fName").value.trim();
    const saveMsg = document.getElementById("saveMsg");
    if (!key || !name) {
      saveMsg.textContent = "Key and name are required.";
      saveMsg.style.color = "#b8003c";
      return;
    }
    const payload = {
      key,
      name,
      context: document.getElementById("fContext").value.trim(),
      landingPageUrl: document.getElementById("fLandingUrl").value.trim(),
      broadKeywords: document.getElementById("fBroadKw").value.trim(),
      highIntentKeywords: document.getElementById("fHighKw").value.trim(),
      icpTitles: document.getElementById("fIcpTitles").value.trim(),
      icpCompanySizeMin: parseInt(document.getElementById("fIcpSizeMin").value, 10) || 1,
      icpCompanySizeMax: parseInt(document.getElementById("fIcpSizeMax").value, 10) || 100000,
      icpIndustries: document.getElementById("fIcpIndustries").value.trim(),
    };
    saveMsg.textContent = "Saving…";
    saveMsg.style.color = "#555";
    fetch(`${cfg.url}/products`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(payload),
    })
      // Previously rejected with the bare numeric status only — live bug
      // (2026-07-21): a genuine failure (Airtable rejecting an unrecognized
      // column) showed as an unhelpful "Save failed (500)" with the actual
      // reason nowhere to be seen. Try to read the body's detail either way
      // — a 500 from an unhandled backend exception won't always have a
      // clean JSON error body, so this still falls back to the status code
      // rather than breaking entirely if parsing fails.
      .then((r) =>
        r.ok
          ? r.json()
          : r
              .json()
              .then((body) => Promise.reject(body.detail || r.status))
              .catch(() => Promise.reject(r.status))
      )
      .then(() => renderProductsView())
      .catch((e) => {
        saveMsg.textContent = `Save failed (${e})`;
        saveMsg.style.color = "#b8003c";
      });
  };
}

// ---------- REPLY DETECTION ----------
// content.js watches LinkedIn pages for a reply landing on a comment we
// already left, scrapes it, and messages it here. This surfaces it as a
// banner with a "Draft Response" button — never auto-posts anything, same
// human-in-the-loop boundary as every other draft in this pipeline. The
// person still reads the AI's suggestion, edits it if needed, and pastes
// it in themselves.

function _extractActivityId(url) {
  if (!url) return null;
  const patterns = [/activity[:-](\d+)/, /urn:li:ugcPost:(\d+)/, /urn%3Ali%3AugcPost%3A(\d+)/];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) return m[1];
  }
  return null;
}

function getHandledReplies(cb) {
  chrome.storage.local.get(["handledReplies"], (r) => cb(new Set(r.handledReplies || [])));
}
function markReplyHandled(signature) {
  getHandledReplies((handled) => {
    handled.add(signature);
    chrome.storage.local.set({ handledReplies: [...handled] });
  });
}

let pendingReplyMessage = null; // retried once QUEUE loads, if it arrived before QUEUE was ready
let currentBannerActivityId = null; // which post the visible banner (if any) belongs to
// Tracks the exact reply currently rendered, so the 3s safety-net poll
// (queryContentScriptState) and repeated pushes don't keep re-rendering
// the SAME reply on top of itself — that was wiping out an in-progress
// "Drafting…" request (or a completed draft the user hadn't copied yet)
// every few seconds, resetting the banner back to its starting state
// before the fetch could ever finish or be acted on.
let currentBannerSignature = null;

function processReplyMessage(msg) {
  console.log("[social-intent] popup received reply message:", msg);
  console.log(`[social-intent] QUEUE has ${QUEUE.length} item(s), searching for activityId ${msg.activityId}`);
  // A Queue match is optional enrichment (accurate product/score context,
  // a nicer display name), not a requirement — the reply and whatever the
  // content script scraped off the page (postText/ownComment) are already
  // enough on their own to draft from, same reasoning as the backend
  // endpoint. Not finding a match no longer blocks the banner.
  const match = QUEUE.find((item) => _extractActivityId(item.postUrl) === msg.activityId) || null;
  console.log(match ? `[social-intent] matched Queue item: "${match.name}"` : "[social-intent] no Queue match — drafting from scraped page content instead");

  getHandledReplies((handled) => {
    // content.js can send more than one "reply" per scan (e.g. a false
    // match from something else on the page that happens to mention us),
    // and re-scans can reorder which one comes first in the array. Live
    // bug (2026-07-20): a correct reply was showing, a later scan put a
    // bogus match first instead, and picking msg.replies[0] blindly
    // overwrote the correct banner with the bogus one. If the reply
    // currently on screen is still present anywhere in this update, keep
    // it — don't let array order alone decide.
    if (
      currentBannerActivityId === msg.activityId &&
      msg.replies.some((r) => `${msg.activityId}|${r.replyAuthor}|${r.replyText}` === currentBannerSignature)
    ) {
      console.log("[social-intent] currently-shown reply is still present in this update — keeping it as-is");
      return;
    }
    const fresh = msg.replies.find(
      (r) => !handled.has(`${msg.activityId}|${r.replyAuthor}|${r.replyText}`)
    );
    if (fresh) {
      const signature = `${msg.activityId}|${fresh.replyAuthor}|${fresh.replyText}`;
      if (signature === currentBannerSignature) {
        console.log("[social-intent] this reply is already showing — not re-rendering (would wipe an in-progress draft)");
        return;
      }
      console.log("[social-intent] rendering reply banner for:", fresh);
      renderReplyBanner(match, fresh, msg.activityId, msg.postText, msg.ownComment);
    } else {
      console.log("[social-intent] all replies for this post already marked handled, not re-showing");
    }
  });
}

// ---------- NOTIFICATION LEADS (Follow-ups tab, "to check" list) ----------
// A lightweight to-do list built from scanning the notifications page —
// distinct from the queued_followup items already in this tab (people
// already connected with, waiting on a DM follow-up). These are just
// "someone engaged with a comment thread, go open it and see" — the
// actual reply-detection + draft flow only kicks in once the post is
// actually opened, same as navigating there any other way.
function getNotificationLeads(cb) {
  chrome.storage.local.get(["notificationLeads"], (r) => cb(r.notificationLeads || []));
}
function addNotificationLeads(newItems, cb) {
  getNotificationLeads((existing) => {
    const existingKeys = new Set(existing.map((i) => i.name + "|" + i.url));
    const merged = existing.concat(newItems.filter((i) => !existingKeys.has(i.name + "|" + i.url)));
    chrome.storage.local.set({ notificationLeads: merged }, () => cb && cb(merged));
  });
}
function removeNotificationLead(name, url, cb) {
  getNotificationLeads((existing) => {
    const filtered = existing.filter((i) => !(i.name === name && i.url === url));
    chrome.storage.local.set({ notificationLeads: filtered }, () => cb && cb(filtered));
  });
}

// Once a reply from the Follow-ups "to check" list has actually been
// looked at (dismissed, or drafted-and-marked-Done), the underlying
// notification-lead entry has served its purpose and should disappear too
// — live feedback (2026-07-21): finishing a reply left the source entry
// sitting in the list looking like it still needed checking. Matched by
// activityId rather than name/url text, since reply.replyAuthor here can
// be messy (headline text glommed on, see _isOwnName's slack in
// content.js) while a lead's stored url and this activityId both resolve
// to the same underlying LinkedIn post either way.
//
// Also auto-advances to whatever's now first in the list — live feedback
// (2026-07-21): working through Follow-ups meant an extra manual "Open"
// click on the next entry after every single Done/Dismiss. This only
// fires when `match` was found above (i.e. this reply genuinely came from
// the Follow-ups list), so it never fires for a reply handled from the
// plain Queue flow. Not committing to anything by loading the page —
// Draft Response still has to be clicked same as before — just saves the
// click of navigating there.
function _removeMatchingNotificationLead(activityId) {
  if (!activityId) return;
  getNotificationLeads((leads) => {
    const match = leads.find((l) => _extractActivityId(l.url) === activityId);
    if (!match) return;
    removeNotificationLead(match.name, match.url, (remaining) => {
      if (currentView === "followups") renderFollowupsView();
      if (remaining.length > 0) openInWorkingTab(remaining[0].url);
    });
  });
}

if (chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === "SOCIAL_INTENT_REPLY_DETECTED") {
      processReplyMessage(msg);
    } else if (msg.type === "SOCIAL_INTENT_NOTIFICATIONS_FOUND") {
      addNotificationLeads(msg.items, () => {
        if (currentView === "followups") renderFollowupsView();
      });
    } else if (msg.type === "SOCIAL_INTENT_DM_DETECTED") {
      processDmMessage(msg);
    } else if (msg.type === "SOCIAL_INTENT_POST_CHANGED") {
      // Navigated to a different post — a banner left over from whatever
      // was open before is now stale and, worse, misleading (it can read
      // as if it's about the post currently on screen). Drop it
      // immediately; a fresh SOCIAL_INTENT_REPLY_DETECTED for the new
      // post (if any) will re-populate it moments later.
      if (currentBannerActivityId && currentBannerActivityId !== msg.activityId) {
        console.log("[social-intent] post changed, clearing stale reply banner");
        const banner = document.getElementById("replyBanner");
        banner.style.display = "none";
        banner.innerHTML = "";
        currentBannerActivityId = null;
        currentBannerSignature = null;
      }
    }
  });
}

// ---------- DM DETECTION ----------
// content.js watches LinkedIn messaging threads for one referencing "your
// comment on my post" — with no post link in the message itself, the only
// way to recover context is a name lookup against our own stored records
// (GET /queue/lookup-by-name), then the exact same /queue/draft-reply flow
// already used for comment-thread replies. Kept in its own banner/state,
// separate from the post-reply banner above, since the two can't overlap
// (a messaging thread and a post page are never the same tab) but sharing
// one banner's state machine would still risk one clearing the other's
// content on an unrelated event.
let currentDmSignature = null;

function processDmMessage(msg) {
  const signature = `${msg.otherName}|${msg.messageText}`;
  if (signature === currentDmSignature) return; // already showing this one
  console.log("[social-intent] popup received DM message:", msg);
  currentDmSignature = signature;
  getBackendConfig((cfg) => {
    if (!cfg.configured) {
      renderDmBanner(msg.otherName, msg.messageText, null, "Cloud mode only — configure a backend in Settings.");
      return;
    }
    fetch(`${cfg.url}/queue/lookup-by-name?name=${encodeURIComponent(msg.otherName)}`, {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
    })
      .then((r) => {
        if (r.status === 404) return null;
        return r.ok ? r.json() : Promise.reject(r.status);
      })
      .then((found) => renderDmBanner(msg.otherName, msg.messageText, found, null))
      .catch((e) => renderDmBanner(msg.otherName, msg.messageText, null, `Lookup failed: ${e}`));
  });
}

function renderDmBanner(otherName, messageText, found, errorMsg) {
  const banner = document.getElementById("dmBanner");
  banner.style.display = "block";
  const closeBanner = () => {
    banner.style.display = "none";
    banner.innerHTML = "";
    currentDmSignature = null;
  };

  if (errorMsg || !found) {
    banner.innerHTML = `
      <div class="replyBannerHeader">Message from ${otherName}</div>
      <div class="replyBannerText">"${messageText}"</div>
      <div class="helpText">${
        errorMsg || `No matching record found for "${otherName}" — can't tell which post/comment this refers to, or draft a response without that context.`
      }</div>
      <div class="row"><button id="dismissDmBtn">Dismiss</button></div>
    `;
    document.getElementById("dismissDmBtn").onclick = closeBanner;
    return;
  }

  banner.innerHTML = `
    <div class="replyBannerHeader">${otherName} messaged you</div>
    <div class="replyBannerText">"${messageText}"</div>
    <div id="dmDraftArea"></div>
    <div class="row">
      <button id="dmOpenPostBtn">View Original Post</button>
      <button id="draftDmBtn" class="primary">${ICONS.zap} Draft Response</button>
      <button id="dismissDmBtn">Dismiss</button>
    </div>
  `;
  document.getElementById("dismissDmBtn").onclick = closeBanner;
  document.getElementById("dmOpenPostBtn").onclick = () => openInWorkingTab(found.postUrl);
  document.getElementById("draftDmBtn").onclick = () => {
    const btn = document.getElementById("draftDmBtn");
    const draftArea = document.getElementById("dmDraftArea");
    btn.disabled = true;
    draftArea.innerHTML = `<div class="helpText">Drafting…</div>`;
    getBackendConfig((cfg) => {
      fetch(`${cfg.url}/queue/draft-reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({
          postUrl: found.postUrl,
          replyText: messageText,
          postText: found.postText,
          ownComment: found.ownComment,
        }),
      })
        .then((r) => (r.ok ? r.json() : r.json().then((e) => Promise.reject(e.detail || r.status))))
        .then((res) => {
          const draft = res.replyText || "";
          draftArea.innerHTML = `
            <textarea id="dmDraftBox">${draft}</textarea>
            <div class="row"><button id="copyDmDraftBtn" class="primary">Copy Reply</button></div>
            <div id="dmCopiedMsg" style="font-size:11px;color:#0a7d2c;min-height:14px;margin-top:4px;"></div>
          `;
          navigator.clipboard.writeText(draft).then(() => {
            document.getElementById("dmCopiedMsg").textContent = "Copied — paste it into the message box.";
          }).catch(() => {});
          document.getElementById("copyDmDraftBtn").onclick = () => {
            navigator.clipboard.writeText(document.getElementById("dmDraftBox").value);
            document.getElementById("dmCopiedMsg").textContent = "Copied — paste it into the message box.";
          };
          btn.disabled = false;
        })
        .catch((e) => {
          draftArea.innerHTML = `<div class="helpText" style="color:#b8003c;">Failed: ${e}</div>`;
          btn.disabled = false;
        });
    });
  };
}

function renderReplyBanner(item, reply, activityId, postText, ownComment) {
  const signature = `${activityId}|${reply.replyAuthor}|${reply.replyText}`;
  currentBannerActivityId = activityId;
  currentBannerSignature = signature;
  const banner = document.getElementById("replyBanner");
  banner.style.display = "block";
  banner.innerHTML = `
    <div class="replyBannerHeader">${reply.replyAuthor} replied${item ? ` on ${item.name}'s post` : " to your comment"}</div>
    <div class="replyBannerText">"${reply.replyText}"</div>
    <div id="replyDraftArea"></div>
    <div class="row">
      <button id="draftReplyBtn" class="primary">${ICONS.zap} Draft Response</button>
      <button id="dismissReplyBtn">Dismiss</button>
    </div>
  `;
  const closeBanner = () => {
    banner.style.display = "none";
    banner.innerHTML = "";
    currentBannerActivityId = null;
    currentBannerSignature = null;
  };
  document.getElementById("dismissReplyBtn").onclick = () => {
    markReplyHandled(signature);
    _removeMatchingNotificationLead(activityId);
    closeBanner();
  };
  document.getElementById("draftReplyBtn").onclick = () => {
    const btn = document.getElementById("draftReplyBtn");
    const draftArea = document.getElementById("replyDraftArea");
    btn.disabled = true;
    draftArea.innerHTML = `<div class="helpText">Drafting…</div>`;
    getBackendConfig((cfg) => {
      if (!cfg.configured) {
        draftArea.innerHTML = `<div class="helpText">Cloud mode only — configure a backend in Settings.</div>`;
        btn.disabled = false;
        return;
      }
      fetch(`${cfg.url}/queue/draft-reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({
          postUrl: item ? item.postUrl : null,
          replyText: reply.replyText,
          postText,
          ownComment,
        }),
      })
        .then((r) => (r.ok ? r.json() : r.json().then((e) => Promise.reject(e.detail || r.status))))
        .then((res) => {
          draftArea.innerHTML = `
            <textarea id="replyDraftBox">${res.replyText || ""}</textarea>
            <div class="row">
              <button id="copyReplyBtn" class="primary">Copy Reply</button>
              <button id="doneReplyBtn">Done</button>
            </div>
            <div id="replyCopiedMsg" style="font-size:11px;color:#0a7d2c;min-height:14px;margin-top:4px;"></div>
          `;
          const replyCopiedMsg = document.getElementById("replyCopiedMsg");
          // Auto-copy on generation — saves a click for the common case
          // (paste as-is). Copy Reply stays as the explicit re-copy once
          // the draft's been edited in the textarea, since this initial
          // write won't reflect any changes made after this point.
          navigator.clipboard.writeText(res.replyText || "").then(() => {
            replyCopiedMsg.textContent = "Copied — paste it in, then hit Done.";
          }).catch(() => {
            // Clipboard writes outside a direct click can be blocked by the
            // browser depending on activation timing — Copy Reply below
            // still works as a manual fallback if this silently no-ops.
          });
          document.getElementById("copyReplyBtn").onclick = () => {
            navigator.clipboard.writeText(document.getElementById("replyDraftBox").value);
            replyCopiedMsg.textContent = "Copied — paste it in, then hit Done.";
          };
          // Separate from Copy on purpose — copying is easy to do more than
          // once while tweaking the text in the box first; Done is the
          // explicit "I've sent it" signal that actually closes this out
          // and stops it being shown again.
          document.getElementById("doneReplyBtn").onclick = () => {
            markReplyHandled(signature);
            _removeMatchingNotificationLead(activityId);
            closeBanner();
          };
          btn.disabled = false;
        })
        .catch((e) => {
          draftArea.innerHTML = `<div class="helpText" style="color:#b8003c;">Failed: ${e}</div>`;
          btn.disabled = false;
        });
    });
  };
}

// Pull half of the reply-detection fix: content.js's push (sendMessage)
// is one-shot and silently lost if this panel isn't actively listening
// at the exact instant it fires — no retry. This actively asks the
// active tab's content script "what do you currently see" instead, which
// can't be missed the same way. Run once on load/tab-switch and then on
// a short interval as a safety net while the panel is open.
function queryContentScriptState() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab || !tab.id) return;
    chrome.tabs.sendMessage(tab.id, { type: "SOCIAL_INTENT_QUERY_STATE" }, (response) => {
      if (chrome.runtime.lastError || !response || !response.activityId) return;
      if (response.replies && response.replies.length) {
        processReplyMessage({
          type: "SOCIAL_INTENT_REPLY_DETECTED",
          activityId: response.activityId,
          replies: response.replies,
          postText: response.postText,
          ownComment: response.ownComment,
        });
      } else if (currentBannerActivityId && currentBannerActivityId !== response.activityId) {
        // Content script has since moved to a different post with no
        // reply of its own — drop a stale banner left over from before.
        const banner = document.getElementById("replyBanner");
        banner.style.display = "none";
        banner.innerHTML = "";
        currentBannerActivityId = null;
        currentBannerSignature = null;
      }
    });
  });
}
queryContentScriptState();
chrome.tabs.onActivated.addListener(queryContentScriptState);
setInterval(queryContentScriptState, 3000);

// ---------- INIT ----------
// Restore whatever view/state was last active before rendering anything —
// see switchView's comment above on why a fresh document load doesn't
// necessarily mean the user actually wants to be back on the Queue tab.
chrome.storage.local.get(["currentView", "queueSessionStarted"], (r) => {
  queueSessionStarted = !!r.queueSessionStarted;
  const view = r.currentView || "queue";
  navQueueBtn.classList.toggle("active", view === "queue");
  navFollowupsBtn.classList.toggle("active", view === "followups");
  navProfilesBtn.classList.toggle("active", view === "profiles");
  navProductsBtn.classList.toggle("active", view === "products");
  currentView = view;
  if (view === "queue") renderQueueView();
  else if (view === "followups") renderFollowupsView();
  else if (view === "profiles") renderProfilesView();
  else if (view === "products") renderProductsView();
  else renderSettingsView();
});
