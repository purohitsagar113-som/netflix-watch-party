// CineSync Background Service Worker (Manifest V3)

// Configure side panel behavior to open when user clicks extension action icon
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error("Error setting side panel behavior:", error));

// Listen for runtime messages from content script or side panel
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      if (message.type === "SAVE_ROOM_DATA") {
        await chrome.storage.local.set({
          activeRoomId: message.roomId,
          username: message.username,
          serverUrl: message.serverUrl || "http://localhost:4000"
        });
        sendResponse({ success: true });
      } else if (message.type === "GET_ROOM_DATA") {
        const data = await chrome.storage.local.get(["activeRoomId", "username", "serverUrl"]);
        sendResponse({ data });
      } else if (message.type === "FROM_NETFLIX_PLAYER") {
        // Content scripts send player events to the service worker. Relay them
        // to the side panel, which owns the room socket connection.
        chrome.runtime.sendMessage({
          ...message,
          type: "NETFLIX_PLAYER_EVENT"
        }).catch(() => {});
        sendResponse({ success: true });
      } else if (message.type === "FORWARD_TO_ACTIVE_NETFLIX_TAB") {
        // Prefer the tab tracked by the side panel; active-tab lookup is unreliable
        // when the side panel and Netflix are in different windows.
        let tab = null;
        if (Number.isInteger(message.tabId)) {
          try {
            tab = await chrome.tabs.get(message.tabId);
          } catch (error) {
            console.warn("[CineSync SW] Tracked OTT tab unavailable:", error.message);
          }
        }
        if (!tab) {
          const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
          tab = activeTab;
        }

        if (tab && tab.id && isSupportedOttTab(tab.url)) {
          try {
            await sendToContentScript(tab.id, message.payload);
          } catch (error) {
            // Extensions reloaded while a Netflix tab is open do not receive
            // content scripts until they are injected or the tab is reopened.
            try {
              await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ["src/content/content.js"]
              });
              await sendToContentScript(tab.id, message.payload);
            } catch (retryError) {
              console.error("[CineSync SW] Content script injection failed:", retryError);
              sendResponse({
                success: false,
                reason: `Content script injection failed: ${retryError.message}`
              });
              return;
            }
          }
          sendResponse({ success: true, tabId: tab.id });
        } else {
          sendResponse({
            success: false,
            reason: tab
              ? `Selected tab is not a supported OTT page: ${tab.url || "URL unavailable"}`
              : "No supported OTT watch tab found"
          });
        }
      }
    } catch (err) {
      console.error("[CineSync SW] Error handling message:", err);
      sendResponse({ success: false, error: err.message });
    }
  })();

  return true; // Keep message channel open for async response
});

function isSupportedOttTab(url) {
  try {
    const parsed = new URL(url || "");
    if (parsed.protocol !== "https:") return false;
    const hostname = parsed.hostname.toLowerCase();
    return hostname === "netflix.com" ||
      hostname.endsWith(".netflix.com") ||
      hostname.endsWith(".primevideo.com") ||
      hostname.endsWith(".amazon.com") ||
      hostname.endsWith(".jiohotstar.com") ||
      hostname.endsWith(".hotstar.com");
  } catch (error) {
    return false;
  }
}

async function sendToContentScript(tabId, payload) {
  const response = await chrome.tabs.sendMessage(tabId, {
    type: "CINESYNC_PING"
  });
  if (!response || response.success !== true) {
    throw new Error("CineSync content script did not respond");
  }
  await chrome.tabs.sendMessage(tabId, payload);
}
