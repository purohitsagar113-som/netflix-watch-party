// CineSync Side Panel Controller

let socket = null;
let currentRoomId = null;
let currentUsername = "MovieFan";
let isHost = false;
let activeOttTabId = null;

// DOM Elements
const viewSetup = document.getElementById("view-setup");
const viewParty = document.getElementById("view-party");
const inputUsername = document.getElementById("input-username");
const inputServer = document.getElementById("input-server");
const inputRoom = document.getElementById("input-room");
const inputProvider = document.getElementById("input-provider");
const btnGenRoom = document.getElementById("btn-gen-room");
const btnJoin = document.getElementById("btn-join");
const connectionPill = document.getElementById("connection-pill");
const connectionText = document.getElementById("connection-text");
const partyRoomId = document.getElementById("party-room-id");
const btnCopyLink = document.getElementById("btn-copy-link");
const shareLink = document.getElementById("share-link");
const btnSelectLink = document.getElementById("btn-select-link");
const btnLeave = document.getElementById("btn-leave");
const btnForceSync = document.getElementById("btn-force-sync");
const membersList = document.getElementById("members-list");
const memberCount = document.getElementById("member-count");
const chatMessages = document.getElementById("chat-messages");
const chatInput = document.getElementById("chat-input");
const btnSendChat = document.getElementById("btn-send-chat");
const playerTime = document.getElementById("player-time");
const providerCards = document.querySelectorAll("[data-provider-card]");

function updateProviderCard(provider) {
  providerCards.forEach((card) => {
    card.classList.toggle("active", card.dataset.providerCard === provider);
  });
}

providerCards.forEach((card) => {
  card.addEventListener("click", () => {
    inputProvider.value = card.dataset.providerCard;
    updateProviderCard(inputProvider.value);
  });
});

inputProvider.addEventListener("change", () => updateProviderCard(inputProvider.value));
updateProviderCard(inputProvider.value);

// 1. Initialize State from chrome.storage.local
document.addEventListener("DOMContentLoaded", async () => {
  const data = await chrome.storage.local.get(["activeRoomId", "username", "serverUrl"]);
  if (data.username) inputUsername.value = data.username;
  if (data.serverUrl) inputServer.value = data.serverUrl;

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab && getProviderFromUrl(activeTab.url)) {
    activeOttTabId = activeTab.id;
  }
  const invitedRoom = getRoomFromOttUrl(activeTab && activeTab.url);
  if (invitedRoom) {
    const invitedServer = getServerFromOttUrl(activeTab && activeTab.url);
    const invitedProvider = getProviderFromUrl(activeTab && activeTab.url);
    if (invitedProvider) inputProvider.value = invitedProvider;
    if (invitedServer) {
      inputServer.value = invitedServer;
    }
    inputRoom.value = invitedRoom;
    joinRoom(invitedRoom, data.username || "MovieFan", invitedServer || data.serverUrl || "http://localhost:4000");
  } else {
    // Pre-generate random room code if empty
    if (!inputRoom.value) generateRoomCode();

    if (data.activeRoomId) {
      joinRoom(data.activeRoomId, data.username || "MovieFan", data.serverUrl || "http://localhost:4000");
    }
  }
});

async function getActiveOttTab() {
  if (activeOttTabId) {
    try {
      const tab = await chrome.tabs.get(activeOttTabId);
      if (tab && getProviderFromUrl(tab.url)) return tab;
    } catch (error) {
      console.warn("[CineSync] Tracked OTT tab is unavailable:", error.message);
    }
    activeOttTabId = null;
  }

  const tabs = await chrome.tabs.query({ lastFocusedWindow: true });
  const tab = tabs.find((candidate) => getProviderFromUrl(candidate.url));
  if (tab && tab.id) activeOttTabId = tab.id;
  return tab || null;
}

async function sendActionToOttTab(payload) {
  const tab = await getActiveOttTab();
  if (!tab || !tab.id) {
    appendSystemMessage("No active OTT tab found. Keep Netflix open and reload the extension.");
    return;
  }

  try {
    const response = await chrome.runtime.sendMessage({
      type: "FORWARD_TO_ACTIVE_NETFLIX_TAB",
      tabId: tab.id,
      payload: {
        type: "EXECUTE_NETFLIX_ACTION",
        ...payload
      }
    });
    if (!response || response.success !== true) {
      appendSystemMessage(`Playback command was not delivered: ${response?.reason || "content script unavailable"}`);
    }
  } catch (error) {
    console.error("[CineSync] Playback command delivery failed:", error);
    appendSystemMessage("Playback command failed. Reload the Netflix tab and extension.");
  }
}

btnGenRoom.addEventListener("click", generateRoomCode);

function generateRoomCode() {
  const code = "CINE-" + Math.floor(1000 + Math.random() * 9000);
  inputRoom.value = code;
}

// 2. Join / Create Room Handler
btnJoin.addEventListener("click", () => {
  const room = inputRoom.value.trim().toUpperCase();
  const user = inputUsername.value.trim() || "MovieFan";
  const server = normalizeServerUrl(inputServer.value);

  if (!room) return alert("Please enter a room code!");
  if (!server) return alert("Enter a valid Sync Server URL, such as https://your-ngrok-domain.ngrok-free.dev");
  joinRoom(room, user, server);
});

function joinRoom(roomId, username, serverUrl) {
  currentRoomId = roomId;
  currentUsername = username;

  setConnectionStatus("connecting", "Connecting...");

  if (socket) socket.disconnect();

  try {
    socket = io(serverUrl, {
      transports: ["websocket", "polling"],
      query: { "ngrok-skip-browser-warning": "true" },
      reconnectionAttempts: 5,
      timeout: 5000
    });
  } catch (err) {
    console.error("Socket creation failed:", err);
    setConnectionStatus("disconnected", "Server Offline");
    return;
  }

  socket.on("connect", () => {
    setConnectionStatus("connected", "Online");
    socket.emit("JOIN_ROOM", { roomId, username, mode: "ott", provider: inputProvider.value });

    // Persist to storage
    chrome.storage.local.set({ activeRoomId: roomId, username, serverUrl });

    // Switch view
    viewSetup.style.display = "none";
    viewParty.style.display = "flex";
    partyRoomId.textContent = roomId;
    buildShareLink()
      .then((link) => { shareLink.value = link; })
      .catch((error) => console.warn("[CineSync] Share link preview unavailable:", error));
  });

  socket.on("connect_error", (error) => {
    console.error("[CineSync] Server connection failed:", error.message);
    setConnectionStatus("disconnected", "Server Offline");
  });

  socket.on("disconnect", () => {
    setConnectionStatus("disconnected", "Disconnected");
  });

  // Room State updates
  socket.on("ROOM_STATE", (room) => {
    isHost = room.hostId === socket.id;
    updateMembers(room.members);
  });

  socket.on("MEMBERS_UPDATED", (members) => {
    updateMembers(members);
  });

  socket.on("SYSTEM_NOTIFICATION", (msg) => {
    appendSystemMessage(msg.text);
  });

  // Incoming playback synchronization command from another peer
  socket.on("REMOTE_ACTION", async ({ action, time, senderName }) => {
    appendSystemMessage(`${senderName} triggered ${action} at ${formatTime(time)}`);

    // Send instruction to the active OTT content script
    await sendActionToOttTab({ action, time });

  });

  // Heartbeat sync
  socket.on("HEARTBEAT_SYNC", async ({ currentTime, isPlaying }) => {
    if (isHost) return; // Hosts broadcast heartbeats, don't consume them

    const tab = await getActiveOttTab();
    if (tab && tab.id) {
      activeOttTabId = tab.id;
      chrome.tabs.sendMessage(tab.id, { type: "GET_CURRENT_VIDEO_TIME" }, (res) => {
        if (chrome.runtime.lastError || !res) return;
        const localTime = res.currentTime || 0;
        const drift = Math.abs(localTime - currentTime);

        playerTime.textContent = formatTime(localTime);

        // If drift exceeds 2 seconds, trigger resync
        if (drift > 2.0) {
          sendActionToOttTab({
            action: isPlaying ? "PLAY" : "PAUSE",
            time: currentTime
          });
        }
      });
    }
  });

  // Chat message receive
  socket.on("CHAT_MESSAGE", (msg) => {
    appendChatMessage(msg.senderName, msg.text, msg.senderId === socket.id);
  });
}

function normalizeServerUrl(value) {
  const raw = value.trim();
  if (!raw) return "http://localhost:4000";

  try {
    const parsed = new URL(raw);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch (error) {
    return null;
  }
}

function getRoomFromOttUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!getProviderFromUrl(value)) {
      return null;
    }
    const room = url.searchParams.get("cinesyncRoom");
    return room ? room.trim().toUpperCase() : null;
  } catch (error) {
    return null;
  }
}

function getServerFromOttUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!getProviderFromUrl(value)) return null;
    return normalizeServerUrl(url.searchParams.get("cinesyncServer") || "");
  } catch (error) {
    return null;
  }
}

function getProviderFromUrl(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    if (hostname.endsWith("netflix.com")) return "netflix";
    if (hostname.endsWith("primevideo.com") || hostname.endsWith("amazon.com")) return "primevideo";
    if (hostname.endsWith("jiohotstar.com") || hostname.endsWith("hotstar.com")) return "jiohotstar";
  } catch (error) {
    return null;
  }
  return null;
}

// 3. Listen for events emitted by OTT Content Script
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "NETFLIX_PLAYER_EVENT" && socket && socket.connected) {
    const { event, time, isBuffering } = message;

    if (event === "BUFFERING") {
      socket.emit("BUFFER_STATE", { isBuffering });
    } else {
      socket.emit("SYNC_ACTION", {
        action: event,
        time
      });
      playerTime.textContent = formatTime(time);
    }
  }
});

// 4. Chat & Reactions
btnSendChat.addEventListener("click", sendChat);
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendChat();
});

function sendChat() {
  const text = chatInput.value.trim();
  if (!text || !socket || !socket.connected) return;

  socket.emit("SEND_CHAT", { text });
  chatInput.value = "";
}

document.querySelectorAll(".rx-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const emoji = btn.getAttribute("data-emoji");
    if (socket && socket.connected) {
      socket.emit("SEND_CHAT", { text: emoji });
    }
  });
});

// 5. Controls & Actions
async function buildShareLink() {
  if (!currentRoomId) throw new Error("Join a room before copying its link");

  const server = normalizeServerUrl(inputServer.value);
  if (!server) throw new Error("Enter a valid Sync Server URL before copying the link");

  const tab = await getActiveOttTab();
  let link = `${server}/extension-guide.html?room=${encodeURIComponent(currentRoomId)}&cinesyncServer=${encodeURIComponent(server)}`;

  if (tab && tab.url) {
    const ottUrl = new URL(tab.url);
    const provider = getProviderFromUrl(tab.url);
    ottUrl.searchParams.set("cinesyncRoom", currentRoomId);
    ottUrl.searchParams.set("cinesyncProvider", provider);
    ottUrl.searchParams.set("cinesyncServer", server);
    link = ottUrl.toString();
  }
  return link;
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (error) {
      console.warn("[CineSync] Clipboard API unavailable, using fallback:", error);
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) {
    const manualCopy = window.prompt("Automatic copy was blocked. Press Ctrl+C, then press Enter:", text);
    if (manualCopy === null) {
      throw new Error("Clipboard access was denied");
    }
  }
}

btnCopyLink.addEventListener("click", async () => {
  try {
    const link = await buildShareLink();
    shareLink.value = link;
    shareLink.select();
    await copyTextToClipboard(link);
    btnCopyLink.textContent = "✓ Copied!";
    setTimeout(() => { btnCopyLink.textContent = "🔗 Copy Link"; }, 2000);
  } catch (error) {
    console.error("[CineSync] Could not copy room link:", error);
    btnCopyLink.textContent = "Copy blocked";
    setTimeout(() => { btnCopyLink.textContent = "🔗 Copy Link"; }, 2500);
  }
});

btnSelectLink.addEventListener("click", async () => {
  try {
    shareLink.value = await buildShareLink();
    shareLink.focus();
    shareLink.select();
    btnSelectLink.textContent = "Selected";
    setTimeout(() => { btnSelectLink.textContent = "Select link"; }, 1500);
  } catch (error) {
    console.error("[CineSync] Could not prepare room link:", error);
    btnSelectLink.textContent = "Join room first";
    setTimeout(() => { btnSelectLink.textContent = "Select link"; }, 2000);
  }
});

btnLeave.addEventListener("click", async () => {
  if (socket) socket.disconnect();
  await chrome.storage.local.remove("activeRoomId");
  viewParty.style.display = "none";
  viewSetup.style.display = "flex";
  setConnectionStatus("disconnected", "Offline");
});

btnForceSync.addEventListener("click", async () => {
  const tab = await getActiveOttTab();
  if (tab && tab.id) {
    activeOttTabId = tab.id;
    chrome.tabs.sendMessage(tab.id, { type: "GET_CURRENT_VIDEO_TIME" }, (res) => {
      if (res && typeof res.currentTime === "number" && socket) {
        socket.emit("SYNC_ACTION", {
          action: res.paused ? "PAUSE" : "PLAY",
          time: res.currentTime
        });
        appendSystemMessage("Force sync broadcast sent to all members.");
      }
    });
  }
});

// Helpers
function setConnectionStatus(status, label) {
  connectionPill.className = `status-pill ${status}`;
  connectionText.textContent = label;
}

function updateMembers(members) {
  membersList.innerHTML = "";
  memberCount.textContent = members.length;

  members.forEach((m) => {
    const chip = document.createElement("div");
    chip.className = `member-chip ${m.isHost ? "host" : ""}`;
    chip.innerHTML = `
      <span>${m.isHost ? "👑" : "👤"}</span>
      <span>${escapeHtml(m.username)}</span>
      ${m.isBuffering ? '<span style="color:#f59e0b">⏳</span>' : ""}
    `;
    membersList.appendChild(chip);
  });
}

function appendChatMessage(author, text, isSelf) {
  const bubble = document.createElement("div");
  bubble.className = "chat-bubble";
  bubble.innerHTML = `
    <div class="sender" style="${isSelf ? 'color: #38bdf8;' : ''}">${escapeHtml(author)}</div>
    <div class="msg-text">${escapeHtml(text)}</div>
  `;
  chatMessages.appendChild(bubble);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function appendSystemMessage(text) {
  const sys = document.createElement("div");
  sys.className = "system-msg";
  sys.textContent = text;
  chatMessages.appendChild(sys);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function formatTime(sec) {
  if (!sec || isNaN(sec)) return "00:00:00";
  const s = Math.floor(sec);
  const hrs = Math.floor(s / 3600).toString().padStart(2, "0");
  const mins = Math.floor((s % 3600) / 60).toString().padStart(2, "0");
  const secs = (s % 60).toString().padStart(2, "0");
  return `${hrs}:${mins}:${secs}`;
}

function escapeHtml(str) {
  return str.replace(/[&<>'"]/g, tag => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[tag] || tag));
}
