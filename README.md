# 🍿 CineSync — Dual-Mode Watch Party Platform

CineSync is a full-stack real-time watch party platform that supports **both**:
1. **Personal Movie Mode (No Extension Required)**:
   - Works on iPhone, Android, iPad, Laptop, and Desktop browsers.
   - Stream local video files (MP4, MKV, WebM, Ogg) or paste direct video links.
   - Real-time play, pause, seek, and drift correction with live chat and emoji reactions.
2. **OTT Mode (Manifest V3 Browser Extension)**:
   - Supports Netflix, Prime Video, and JioHotstar watch pages with a native Side Panel UI.
   - Controls Netflix's internal Cadmium `videoPlayer` API with HTML5 `<video>` fallback.
   - Syncs legally across Netflix subscribers without DRM black-screen issues.

---

## 🚀 Quickstart

### Step 1: Start the Backend Server
```powershell
cd C:\Users\puroh\.gemini\antigravity\scratch\netflix-watch-party\backend
npm start
```

### Step 2: Open the CineSync Hub
Open your browser to:
👉 **[http://localhost:4000](http://localhost:4000)**

* **Option 1: Personal Movie Room ([http://localhost:4000/watch.html](http://localhost:4000/watch.html))**
  - Click **"📁 Choose Movie File"** to pick an MP4, MKV, WebM, or Ogg movie.
  - MKV uploads are converted on the server to H.264/AAC MP4 so phones and browsers can play them.
  - The movie is uploaded before its server URL is shared; device-local `blob:` URLs are never sent to other participants.
  - Click **"🔗 Copy Link"** and send it to your friend on their phone or laptop.
  - Both players will stay locked in millisecond sync!
* **Option 2: Netflix Watch Party ([http://localhost:4000/extension-guide.html](http://localhost:4000/extension-guide.html))**
  - Load the `extension/` directory in `chrome://extensions` (Developer Mode).
  - Open Netflix, launch the Side Panel, create a room, and share the invite.

---

## 🌐 Watching with Friends Over the Internet (Remote Devices)

When your friend is not on your local Wi-Fi, you can expose your local server to the internet using **ngrok** (or deploy to free cloud hosts like Render / Railway / Glitch):

```powershell
# Using ngrok (free instant tunnel)
npx ngrok http 4000
```
This gives you a public URL (e.g. `https://xyz.ngrok-free.app`). Send `https://xyz.ngrok-free.app/watch.html?room=CINE-1234` to your friend, and they can watch along from anywhere in the world on their smartphone or PC!

Open the watch room through the public HTTPS URL before selecting a movie. The uploaded movie URL is relative to the room origin, so guests resolve it through the same public tunnel instead of receiving a `localhost` or device-local URL. MKV uploads are transcoded with FFmpeg; this can take time for large files and requires FFmpeg to be installed and available on the server PATH.
