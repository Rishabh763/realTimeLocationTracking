import express from "express";
import http from "node:http";
import path from "node:path";
import { Server } from "socket.io";

const ROOT = import.meta.dirname;
const PORT = Number(process.env.PORT) || 3000;
const MIN_UPDATE_INTERVAL_MS = 1000; // server-side rate limit per socket
const MAX_NAME_LENGTH = 30;
const ROOM_PATTERN = /^[a-z0-9-]{4,32}$/;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e4, // location payloads are tiny; reject anything large
  cors: process.env.CORS_ORIGIN ? { origin: process.env.CORS_ORIGIN } : undefined,
});

app.disable("x-powered-by");
app.set("trust proxy", 1); // correct client IPs/protocol behind Render, Railway, nginx etc.
app.set("view engine", "ejs");
app.set("views", path.join(ROOT, "views"));

app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "geolocation=(self)",
  });
  next();
});

app.use(express.static(path.join(ROOT, "public")));
// Serve front-end libraries from node_modules so versions are pinned by package-lock.json
app.use("/vendor/leaflet", express.static(path.join(ROOT, "node_modules/leaflet/dist")));
app.use(
  "/vendor/leaflet-routing-machine",
  express.static(path.join(ROOT, "node_modules/leaflet-routing-machine/dist"))
);

app.get("/", (req, res) => res.render("index"));
app.get("/healthz", (req, res) => res.json({ status: "ok", uptime: process.uptime() }));

// rooms: Map<roomId, Map<socketId, { id, username, latitude, longitude, updatedAt }>>
const rooms = new Map();

function cleanName(value) {
  if (typeof value !== "string") return null;
  const name = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_NAME_LENGTH);
  return name || null;
}

function isValidCoord(lat, lng) {
  return (
    Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
  );
}

// Only users who have shared a position are visible to others
function visibleUsers(room) {
  return [...(rooms.get(room)?.values() ?? [])].filter((u) => u.latitude != null);
}

io.on("connection", (socket) => {
  let room = null;
  let lastUpdate = 0;

  socket.on("join", (payload, ack) => {
    const respond = typeof ack === "function" ? ack : () => {};
    if (room) return respond({ ok: false, error: "Already joined" });

    const roomId = typeof payload?.room === "string" ? payload.room.toLowerCase() : "";
    const username = cleanName(payload?.username);
    if (!ROOM_PATTERN.test(roomId)) return respond({ ok: false, error: "Invalid room" });
    if (!username) return respond({ ok: false, error: "Invalid name" });

    room = roomId;
    if (!rooms.has(room)) rooms.set(room, new Map());
    rooms.get(room).set(socket.id, {
      id: socket.id, username, latitude: null, longitude: null, updatedAt: null,
    });
    socket.join(room);

    // Late joiners immediately get everyone who is already sharing
    respond({ ok: true, id: socket.id, users: visibleUsers(room) });
  });

  socket.on("send-location", (payload) => {
    if (!room) return;
    const now = Date.now();
    if (now - lastUpdate < MIN_UPDATE_INTERVAL_MS) return;

    const latitude = Number(payload?.latitude);
    const longitude = Number(payload?.longitude);
    if (!isValidCoord(latitude, longitude)) return;

    const user = rooms.get(room)?.get(socket.id);
    if (!user) return;
    lastUpdate = now;
    Object.assign(user, { latitude, longitude, updatedAt: now });

    // id and username always come from the server, never from the client payload
    io.to(room).emit("receive-location", { ...user });
  });

  socket.on("disconnect", () => {
    if (!room) return;
    const members = rooms.get(room);
    members?.delete(socket.id);
    if (members && members.size === 0) rooms.delete(room);
    io.to(room).emit("user-disconnected", socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

function shutdown() {
  io.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
