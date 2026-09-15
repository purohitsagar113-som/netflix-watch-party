const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

// Global Crash Prevention Handlers
process.on("uncaughtException", (err) => {
  console.error("[CineSync Uncaught Exception]:", err.message, err.stack);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[CineSync Unhandled Rejection]:", reason);
});

const app = express();
app.use(cors());
app.use(express.json());

app.get("/robots.txt", (_req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.type("text/plain").send(
    "# Allow all crawlers to index the website\n" +
    "User-agent: *\n" +
    "Disallow:\n\n" +
    "Sitemap: https://cinesync-hcow.onrender.com/sitemap.xml\n"
  );
});

// Ensure uploads directory exists
const UPLOADS_DIR = path.join(__dirname, "../uploads");
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Serve static web pages from public
app.use(express.static(path.join(__dirname, "../public")));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  maxHttpBufferSize: 1e8,
  pingTimeout: 60000,
  pingInterval: 25000
});

/**
 * In-memory Room State Store:
 * Map<roomId, {
 *   roomId: string,
 *   mode: 'netflix' | 'personal',
 *   hostId: string,
 *   videoSource: { type: 'url' | 'file' | 'demo', url: string, title: string },
 *   isPlaying: boolean,
 *   currentTime: number,
 *   lastUpdated: number,
 *   members: Map<socketId, { id: string, username: string, isBuffering: boolean, isHost: boolean }>
 * }>
 */
const rooms = new Map();

function getSerializedRoom(room) {
  return {
    roomId: room.roomId,
    mode: room.mode || "personal",
    hostId: room.hostId,
    videoSource: room.videoSource,
    isPlaying: room.isPlaying,
    currentTime: room.currentTime,
    lastUpdated: room.lastUpdated,
    members: Array.from(room.members.values())
  };
}

io.on("connection", (socket) => {
  console.log(`[Socket] Client connected: ${socket.id}`);

  // 1. Join / Create Room
  socket.on("JOIN_ROOM", ({ roomId, username, mode = "personal", videoSource }) => {
    if (!roomId) return;

    socket.join(roomId);
    socket.roomId = roomId;
    socket.username = username?.trim() || `User_${socket.id.substring(0, 4)}`;

    if (!rooms.has(roomId)) {
      rooms.set(roomId, {
        roomId,
        mode,
        hostId: socket.id,
        videoSource: videoSource || {
          type: "demo",
          url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
          title: "Big Buck Bunny (Sample)"
        },
        isPlaying: false,
        currentTime: 0,
        lastUpdated: Date.now(),
        members: new Map()
      });
      console.log(`[Room Created] ${roomId} (Mode: ${mode}) by ${socket.username}`);
    }

    const room = rooms.get(roomId);
    const isHost = room.hostId === socket.id;

    room.members.set(socket.id, {
      id: socket.id,
      username: socket.username,
      isBuffering: false,
      isHost
    });

    // Provide initial state to client
    socket.emit("ROOM_STATE", getSerializedRoom(room));

    // Notify all members
    io.to(roomId).emit("MEMBERS_UPDATED", Array.from(room.members.values()));
    io.to(roomId).emit("SYSTEM_NOTIFICATION", {
      text: `${socket.username} joined the party.`,
      timestamp: Date.now()
    });
  });

  // 2. Change Video Source (Personal Movie File or Direct Stream URL)
  socket.on("CHANGE_VIDEO_SOURCE", ({ videoSource }) => {
    const roomId = socket.roomId;
    if (!roomId || !rooms.has(roomId)) return;

    const room = rooms.get(roomId);
    room.videoSource = videoSource;
    room.currentTime = 0;
    room.isPlaying = false;
    room.lastUpdated = Date.now();

    console.log(`[Room ${roomId}] Video source changed to: ${videoSource.title || videoSource.url}`);

    // Broadcast new video source to everyone in the room
    io.to(roomId).emit("VIDEO_SOURCE_CHANGED", {
      videoSource: room.videoSource,
      senderName: socket.username
    });
  });

  // 3. Playback Synchronization Action (PLAY, PAUSE, SEEK)
  socket.on("SYNC_ACTION", ({ action, time }) => {
    const roomId = socket.roomId;
    if (!roomId || !rooms.has(roomId)) return;

    const room = rooms.get(roomId);
    room.isPlaying = action === "PLAY";
    room.currentTime = typeof time === "number" ? time : room.currentTime;
    room.lastUpdated = Date.now();

    // Broadcast to everyone else in the room (prevent sender loop)
    socket.to(roomId).emit("REMOTE_ACTION", {
      action,
      time: room.currentTime,
      senderId: socket.id,
      senderName: socket.username,
      timestamp: room.lastUpdated
    });
  });

  // 4. Host Periodic Heartbeat
  socket.on("HOST_HEARTBEAT", ({ currentTime, isPlaying }) => {
    const roomId = socket.roomId;
    if (!roomId || !rooms.has(roomId)) return;

    const room = rooms.get(roomId);
    if (room.hostId === socket.id) {
      room.currentTime = currentTime;
      room.isPlaying = isPlaying;
      room.lastUpdated = Date.now();

      socket.to(roomId).emit("HEARTBEAT_SYNC", {
        currentTime,
        isPlaying,
        timestamp: room.lastUpdated
      });
    }
  });

  // 5. Buffer Lock State
  socket.on("BUFFER_STATE", ({ isBuffering }) => {
    const roomId = socket.roomId;
    if (!roomId || !rooms.has(roomId)) return;

    const room = rooms.get(roomId);
    const member = room.members.get(socket.id);
    if (member) member.isBuffering = isBuffering;

    const anyoneBuffering = Array.from(room.members.values()).some((m) => m.isBuffering);

    io.to(roomId).emit("ROOM_BUFFER_LOCK", {
      isLocked: anyoneBuffering,
      bufferingUser: isBuffering ? socket.username : null
    });
  });

  // 6. WebRTC P2P Signaling Relay
  socket.on("WEBRTC_SIGNAL", ({ targetId, signal }) => {
    if (targetId) {
      io.to(targetId).emit("WEBRTC_SIGNAL", {
        senderId: socket.id,
        signal
      });
    }
  });

  // 7. Chat Messaging
  socket.on("SEND_CHAT", ({ text }) => {
    const roomId = socket.roomId;
    if (!roomId || !text?.trim()) return;

    io.to(roomId).emit("CHAT_MESSAGE", {
      id: `${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      senderId: socket.id,
      senderName: socket.username,
      text: text.trim(),
      timestamp: Date.now()
    });
  });

  // 8. Disconnection & Host Migration
  socket.on("disconnect", (reason) => {
    const roomId = socket.roomId;
    if (!roomId || !rooms.has(roomId)) return;

    const room = rooms.get(roomId);
    room.members.delete(socket.id);

    console.log(`[Socket] Disconnected: ${socket.username} (${reason})`);

    if (room.members.size === 0) {
      rooms.delete(roomId);
      console.log(`[Room ${roomId}] All members left. Cleaned up.`);
    } else {
      if (room.hostId === socket.id) {
        const nextHost = Array.from(room.members.values())[0];
        room.hostId = nextHost.id;
        nextHost.isHost = true;
        io.to(roomId).emit("HOST_CHANGED", {
          newHostId: nextHost.id,
          newHostName: nextHost.username
        });
      }

      io.to(roomId).emit("MEMBERS_UPDATED", Array.from(room.members.values()));
      io.to(roomId).emit("SYSTEM_NOTIFICATION", {
        text: `${socket.username} left the party.`,
        timestamp: Date.now()
      });
    }
  });

  socket.on("error", (err) => {
    console.error(`[Socket Error - ${socket.id}]:`, err.message);
  });
});

// REST Endpoint: Fast Local Video Streaming via HTTP 206 Partial Content (Range Requests)
app.get("/api/stream-video/:filename", (req, res) => {
  // Sanitize filename to prevent path traversal
  const safeFilename = path.basename(req.params.filename);
  const filePath = path.join(UPLOADS_DIR, safeFilename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "Video file not found" });
  }

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (e) {
    return res.status(500).json({ error: "Could not read file stats" });
  }

  const fileSize = stat.size;
  const range = req.headers.range;

  // Determine mime type based on file extension
  let contentType = "video/mp4";
  if (safeFilename.endsWith(".mkv")) contentType = "video/x-matroska";
  else if (safeFilename.endsWith(".webm")) contentType = "video/webm";

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    if (start >= fileSize || end >= fileSize || start > end) {
      res.writeHead(416, {
        "Content-Range": `bytes */${fileSize}`
      });
      return res.end();
    }

    const chunkSize = end - start + 1;
    const file = fs.createReadStream(filePath, { start, end });

    // Handle abrupt client disconnects safely
    file.on("error", (err) => {
      console.warn(`[Stream Error - ${safeFilename}]:`, err.message);
      if (!res.headersSent) res.status(500).end();
    });

    req.on("close", () => {
      file.destroy();
    });

    const head = {
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunkSize,
      "Content-Type": contentType
    };

    res.writeHead(206, head);
    file.pipe(res);
  } else {
    const head = {
      "Content-Length": fileSize,
      "Content-Type": contentType,
      "Accept-Ranges": "bytes"
    };

    res.writeHead(200, head);
    const file = fs.createReadStream(filePath);

    file.on("error", (err) => {
      console.warn(`[Stream Error - ${safeFilename}]:`, err.message);
      if (!res.headersSent) res.status(500).end();
    });

    req.on("close", () => {
      file.destroy();
    });

    file.pipe(res);
  }
});

// REST Endpoint: Direct File Upload for Host Movie Files (Protected against aborts)
app.post("/api/upload-video", (req, res) => {
  const ext = req.query.ext ? `.${req.query.ext.replace(/[^a-z0-9]/gi, "")}` : ".mp4";
  const filename = `movie_${Date.now()}_${Math.random().toString(36).substr(2, 5)}${ext}`;
  const targetPath = path.join(UPLOADS_DIR, filename);
  const writeStream = fs.createWriteStream(targetPath);

  let isAborted = false;

  req.on("error", (err) => {
    console.warn("[Upload Request Error]:", err.message);
    isAborted = true;
    writeStream.destroy();
    if (fs.existsSync(targetPath)) fs.unlink(targetPath, () => {});
  });

  req.on("aborted", () => {
    console.warn("[Upload Aborted by Client]");
    isAborted = true;
    writeStream.destroy();
    if (fs.existsSync(targetPath)) fs.unlink(targetPath, () => {});
  });

  writeStream.on("error", (err) => {
    console.error("[Upload WriteStream Error]:", err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  });

  writeStream.on("finish", () => {
    if (isAborted) return;
    const isMkv = ext === ".mkv" || ext === ".mka" || ext === ".mks";
    if (!isMkv) {
      const videoUrl = `/api/stream-video/${filename}`;
      console.log(`[Upload Complete] Saved ${filename} (${fs.statSync(targetPath).size} bytes)`);
      return res.json({ success: true, filename, videoUrl });
    }

    const convertedFilename = `${path.basename(filename, ext)}.mp4`;
    const convertedPath = path.join(UPLOADS_DIR, convertedFilename);
    const ffmpeg = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel", "error",
      "-y",
      "-i", targetPath,
      "-map", "0:v:0",
      "-map", "0:a:0?",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "128k",
      "-movflags", "+faststart",
      convertedPath
    ], { windowsHide: true });

    let ffmpegError = "";
    ffmpeg.stderr.on("data", (chunk) => {
      ffmpegError += chunk.toString();
    });
    ffmpeg.on("error", (error) => {
      console.error("[MKV Conversion Error]:", error.message);
      if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
      if (!res.headersSent) res.status(500).json({
        error: "MKV conversion requires FFmpeg, but FFmpeg could not be started."
      });
    });
    ffmpeg.on("close", (code) => {
      if (code !== 0 || !fs.existsSync(convertedPath)) {
        console.error("[MKV Conversion Failed]:", ffmpegError.trim());
        if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
        if (fs.existsSync(convertedPath)) fs.unlinkSync(convertedPath);
        if (!res.headersSent) res.status(422).json({
          error: "The MKV file could not be converted to a browser-compatible MP4."
        });
        return;
      }

      fs.unlinkSync(targetPath);
      const videoUrl = `/api/stream-video/${convertedFilename}`;
      console.log(`[MKV Conversion Complete] Saved ${convertedFilename} (${fs.statSync(convertedPath).size} bytes)`);
      if (!res.headersSent) res.json({
        success: true,
        filename: convertedFilename,
        videoUrl,
        convertedFrom: "mkv"
      });
    });
  });

  req.pipe(writeStream);
});

// Health check & room discovery
app.get("/api/health", (req, res) => {
  res.json({
    status: "healthy",
    activeRooms: rooms.size,
    timestamp: new Date().toISOString()
  });
});

app.get("/api/room/:roomId", (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) return res.status(404).json({ error: "Room not found" });
  res.json(getSerializedRoom(room));
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`=========================================`);
  console.log(` CineSync Server active on port ${PORT}`);
  console.log(` Hub: http://localhost:${PORT}`);
  console.log(` Personal Video Room: http://localhost:${PORT}/watch.html`);
  console.log(` Health: http://localhost:${PORT}/api/health`);
  console.log(`=========================================`);
});
