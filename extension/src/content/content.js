// CineSync Content Script (Runs on supported OTT watch pages)

console.log("[CineSync] Content script initialized on supported OTT page.");

let isRemoteCommandLock = false;
let currentVideoElement = null;

// 1. Inject the Netflix bridge only where its private player API is available.
function injectBridge() {
  if (!/(^|\.)netflix\.com$/i.test(location.hostname)) return;
  try {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("src/content/netflix-bridge.js");
    (document.head || document.documentElement).appendChild(script);
    script.onload = () => script.remove();
  } catch (err) {
    console.error("[CineSync] Bridge injection failed:", err);
  }
}
injectBridge();

// 2. Continuous element watcher for dynamically rendered OTT players
function observeVideoElement() {
  const check = setInterval(() => {
    const video = document.querySelector("video");
    if (video && video !== currentVideoElement) {
      currentVideoElement = video;
      attachPlayerListeners(video);
      injectFloatingSyncBadge();
    }
  }, 1000);
}

// 3. Attach event listeners to the active OTT video element
function attachPlayerListeners(video) {
  console.log("[CineSync] Attached event listeners to Netflix video element.");

  video.addEventListener("play", () => {
    if (isRemoteCommandLock) return;
    chrome.runtime.sendMessage({
      type: "FROM_NETFLIX_PLAYER",
      event: "PLAY",
      time: video.currentTime
    }).catch(() => {});
  });

  video.addEventListener("pause", () => {
    if (isRemoteCommandLock) return;
    chrome.runtime.sendMessage({
      type: "FROM_NETFLIX_PLAYER",
      event: "PAUSE",
      time: video.currentTime
    }).catch(() => {});
  });

  video.addEventListener("seeked", () => {
    if (isRemoteCommandLock) return;
    chrome.runtime.sendMessage({
      type: "FROM_NETFLIX_PLAYER",
      event: "SEEK",
      time: video.currentTime
    }).catch(() => {});
  });

  video.addEventListener("waiting", () => {
    chrome.runtime.sendMessage({
      type: "FROM_NETFLIX_PLAYER",
      event: "BUFFERING",
      isBuffering: true
    }).catch(() => {});
  });

  video.addEventListener("playing", () => {
    chrome.runtime.sendMessage({
      type: "FROM_NETFLIX_PLAYER",
      event: "BUFFERING",
      isBuffering: false
    }).catch(() => {});
  });
}

// 4. Handle incoming playback commands from Side Panel
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "CINESYNC_PING") {
    sendResponse({ success: true });
    return true;
  }

  if (msg.type === "EXECUTE_NETFLIX_ACTION") {
    const { action, time } = msg;
    
    // Set lock to prevent echoing this action back as a local user event
    isRemoteCommandLock = true;

    if (/(\.|^)netflix\.com$/i.test(location.hostname)) {
      window.dispatchEvent(new CustomEvent("cinesync_command", {
        detail: { action, time }
      }));
    } else {
      const video = document.querySelector("video");
      if (video) {
        if (Number.isFinite(time)) video.currentTime = time;
        if (action === "PLAY") video.play().catch(() => {});
        if (action === "PAUSE") video.pause();
      }
    }

    updateBadgeStatus(`Syncing: ${action}`);

    // Release lock after a debounce window (800ms)
    setTimeout(() => {
      isRemoteCommandLock = false;
      updateBadgeStatus("Synced");
    }, 800);

    sendResponse({ status: "executed" });
  } else if (msg.type === "GET_CURRENT_VIDEO_TIME") {
    const video = document.querySelector("video");
    sendResponse({
      currentTime: video ? video.currentTime : 0,
      paused: video ? video.paused : true,
      title: document.title.replace("- Netflix", "").trim()
    });
  }
  return true;
});

// 5. In-video unobtrusive Sync Badge
function injectFloatingSyncBadge() {
  if (document.getElementById("cinesync-hud-badge")) return;

  const badge = document.createElement("div");
  badge.id = "cinesync-hud-badge";
  badge.innerHTML = `
    <div style="
      position: fixed;
      top: 18px;
      right: 18px;
      z-index: 999999;
      background: rgba(18, 20, 29, 0.85);
      backdrop-filter: blur(8px);
      border: 1px solid rgba(229, 9, 20, 0.5);
      border-radius: 8px;
      padding: 6px 12px;
      display: flex;
      align-items: center;
      gap: 8px;
      color: #fff;
      font-size: 12px;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      box-shadow: 0 4px 16px rgba(0,0,0,0.5);
      pointer-events: none;
      transition: opacity 0.3s ease;
    ">
      <span style="width: 8px; height: 8px; border-radius: 50%; background: #22c55e; display: inline-block;"></span>
      <span style="font-weight: 700; color: #e50914;">CineSync</span>
      <span id="cinesync-hud-status" style="color: #cbd5e1;">Live</span>
    </div>
  `;
  document.body.appendChild(badge);
}

function updateBadgeStatus(text) {
  const el = document.getElementById("cinesync-hud-status");
  if (el) el.textContent = text;
}

observeVideoElement();
