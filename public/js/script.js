"use strict";

// ---------- Config ----------
const ROOM_PATTERN = /^[a-z0-9-]{4,32}$/;
const SEND_INTERVAL_MS = 2000; // never send more often than this
const MIN_MOVE_METERS = 3; // ignore GPS jitter smaller than this...
const HEARTBEAT_MS = 15000; // ...unless this long has passed since the last send
const ROUTE_REFRESH_MS = 10000; // public OSRM demo server is rate limited
const OSRM_URL = "https://router.project-osrm.org/route/v1";

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const els = {
  overlay: $("join-overlay"),
  joinForm: $("join-form"),
  joinBtn: $("join-btn"),
  joinError: $("join-error"),
  nameInput: $("name-input"),
  roomLabel: $("room-label"),
  usersToggle: $("users-toggle"),
  userCount: $("user-count"),
  userList: $("user-list"),
  shareBtn: $("share-btn"),
  status: $("status"),
  statusText: $("status-text"),
  retryBtn: $("retry-btn"),
  connStatus: $("conn-status"),
  recenterBtn: $("recenter-btn"),
  user1: $("user1"),
  user2: $("user2"),
  routeBtn: $("route-btn"),
  routeInfo: $("route-info"),
};

// ---------- Helpers ----------
function randomRoomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => (b % 36).toString(36)).join("");
}

function getOrCreateRoom() {
  const params = new URLSearchParams(location.search);
  let room = (params.get("room") || "").toLowerCase();
  if (!ROOM_PATTERN.test(room)) {
    room = randomRoomId();
    params.set("room", room);
    history.replaceState(null, "", `${location.pathname}?${params}`);
  }
  return room;
}

function formatDistance(meters) {
  return meters < 1000 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(1)} km`;
}

function formatDuration(seconds) {
  const mins = Math.max(1, Math.round(seconds / 60));
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)} h ${mins % 60} min`;
}

function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable (private mode etc.), not critical */
  }
}

function showStatus(text, { error = false, retry = false } = {}) {
  els.statusText.textContent = text;
  els.status.classList.toggle("error-banner", error);
  els.retryBtn.hidden = !retry;
  els.status.hidden = false;
}

function hideStatus() {
  els.status.hidden = true;
}

// ---------- Map ----------
const map = L.map("map", { zoomControl: false }).setView([20, 0], 2);
L.control.zoom({ position: "bottomright" }).addTo(map);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

// ---------- State ----------
const room = getOrCreateRoom();
const socket = io({ autoConnect: false });
const users = new Map(); // id -> { id, username, latitude, longitude, marker }
let username = "";
let myId = null;
let followMe = true;
let hasCenteredOnMe = false;
let watchId = null;
let myPosition = null; // { latitude, longitude }
let lastSent = { at: 0, latitude: null, longitude: null };
let route = null; // { control, fromId, toId, lastUpdate, timer }

els.roomLabel.textContent = room;
els.nameInput.value = storageGet("username") || "";

// ---------- Users and markers ----------
function displayName(user) {
  return user.id === myId ? `${user.username} (you)` : user.username;
}

function upsertUser(data) {
  const { id, username: name, latitude, longitude } = data;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;

  const existing = users.get(id);
  if (existing) {
    existing.latitude = latitude;
    existing.longitude = longitude;
    existing.marker.setLatLng([latitude, longitude]);
    return;
  }

  const user = { id, username: name, latitude, longitude };
  // Build the label as a DOM node with textContent so names are never parsed as HTML
  const label = document.createElement("span");
  label.className = id === myId ? "name-label me" : "name-label";
  label.textContent = displayName(user);

  user.marker = L.marker([latitude, longitude], { title: name })
    .addTo(map)
    .bindTooltip(label, { permanent: true, direction: "top", offset: [-16, -14] });
  // Read the marker's current position at click time, not the position at creation
  user.marker.on("click", () => map.setView(user.marker.getLatLng(), Math.max(map.getZoom(), 16)));

  users.set(id, user);
  renderUsers();
}

function removeUser(id) {
  const user = users.get(id);
  if (!user) return;
  map.removeLayer(user.marker);
  users.delete(id);
  if (route && (route.fromId === id || route.toId === id)) {
    stopRoute(`${user.username} left, route stopped.`);
  }
  renderUsers();
}

function clearUsers() {
  for (const user of users.values()) map.removeLayer(user.marker);
  users.clear();
  renderUsers();
}

function fillSelect(select, placeholder, sorted) {
  const previous = select.value;
  select.replaceChildren(new Option(placeholder, "", true, false));
  select.options[0].disabled = true;
  for (const user of sorted) select.add(new Option(displayName(user), user.id));
  select.value = users.has(previous) ? previous : "";
}

// Single place that redraws the count, the list and both dropdowns
function renderUsers() {
  const sorted = [...users.values()].sort((a, b) =>
    a.id === myId ? -1 : b.id === myId ? 1 : a.username.localeCompare(b.username)
  );

  els.userCount.textContent = users.size;

  els.userList.replaceChildren(
    ...sorted.map((user) => {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = displayName(user);
      btn.addEventListener("click", () => {
        if (user.id !== myId) setFollow(false);
        map.setView(user.marker.getLatLng(), 16);
        toggleUserList(false);
      });
      li.append(btn);
      return li;
    })
  );

  fillSelect(els.user1, "From", sorted);
  fillSelect(els.user2, "To", sorted);
}

function toggleUserList(force) {
  const open = force ?? els.userList.hidden;
  els.userList.hidden = !open;
  els.usersToggle.setAttribute("aria-expanded", String(open));
}

els.usersToggle.addEventListener("click", () => toggleUserList());

// ---------- Following my own position ----------
function setFollow(value) {
  followMe = value;
  els.recenterBtn.hidden = value || !users.has(myId);
}

map.on("dragstart", () => setFollow(false));

els.recenterBtn.addEventListener("click", () => {
  setFollow(true);
  const me = users.get(myId);
  if (me) map.setView(me.marker.getLatLng(), Math.max(map.getZoom(), 16));
});

// ---------- Geolocation ----------
function sendLocation(force = false) {
  if (!myPosition || !socket.connected || !myId) return;
  const now = Date.now();
  const elapsed = now - lastSent.at;
  if (!force) {
    if (elapsed < SEND_INTERVAL_MS) return;
    const moved =
      lastSent.latitude == null
        ? Infinity
        : map.distance(
            [lastSent.latitude, lastSent.longitude],
            [myPosition.latitude, myPosition.longitude]
          );
    if (moved < MIN_MOVE_METERS && elapsed < HEARTBEAT_MS) return;
  }
  lastSent = { at: now, ...myPosition };
  socket.emit("send-location", myPosition);
}

function onPosition(position) {
  hideStatus();
  const { latitude, longitude } = position.coords;
  myPosition = { latitude, longitude };
  sendLocation();
}

function onPositionError(error) {
  switch (error.code) {
    case error.PERMISSION_DENIED:
      showStatus(
        "Location access is blocked. Allow location for this site in your browser settings, then press Retry.",
        { error: true, retry: true }
      );
      break;
    case error.POSITION_UNAVAILABLE:
      showStatus("Couldn't determine your location.", { error: true, retry: true });
      break;
    case error.TIMEOUT:
      // watchPosition keeps trying after a timeout, so just inform the user
      if (!myPosition) showStatus("Waiting for a location fix...");
      break;
    default:
      showStatus("Location error.", { error: true, retry: true });
  }
}

function startWatching() {
  if (!("geolocation" in navigator)) {
    showStatus("Your browser does not support location sharing.", { error: true });
    return;
  }
  if (!window.isSecureContext) {
    showStatus("Location only works over HTTPS (or on localhost).", { error: true });
    return;
  }
  // Clear any previous watcher so retries never create duplicates
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  showStatus("Getting your location...");
  watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
    enableHighAccuracy: true,
    timeout: 15000,
    maximumAge: 5000,
  });
}

els.retryBtn.addEventListener("click", startWatching);

// ---------- Socket ----------
function join() {
  socket.emit("join", { room, username }, (res) => {
    if (!res?.ok) {
      els.overlay.hidden = false;
      els.joinBtn.disabled = false;
      els.joinError.textContent = res?.error || "Could not join the room.";
      els.joinError.hidden = false;
      socket.disconnect();
      return;
    }
    myId = res.id;
    clearUsers(); // a reconnect gets a new socket id, so rebuild from the server snapshot
    res.users.forEach(upsertUser);
    els.overlay.hidden = true;
    if (watchId === null) startWatching();
    sendLocation(true); // after a reconnect, re-announce the last known position right away
  });
}

socket.on("connect", () => {
  els.connStatus.hidden = true;
  join();
});

socket.on("disconnect", (reason) => {
  if (reason !== "io client disconnect") els.connStatus.hidden = false;
});

socket.on("receive-location", (data) => {
  upsertUser(data);
  if (data.id === myId && followMe) {
    if (!hasCenteredOnMe) {
      map.setView([data.latitude, data.longitude], 16);
      hasCenteredOnMe = true;
    } else {
      map.panTo([data.latitude, data.longitude]);
    }
  }
  if (data.id === myId) setFollow(followMe); // shows the re-center button once I'm on the map
  if (route && (data.id === route.fromId || data.id === route.toId)) scheduleRouteUpdate();
});

socket.on("user-disconnected", removeUser);

els.joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = els.nameInput.value.trim().slice(0, 30);
  if (!name) {
    els.joinError.textContent = "Please enter a name.";
    els.joinError.hidden = false;
    els.nameInput.focus();
    return;
  }
  username = name;
  storageSet("username", name);
  els.joinError.hidden = true;
  els.joinBtn.disabled = true;
  socket.connect();
});

// ---------- Sharing ----------
els.shareBtn.addEventListener("click", async () => {
  const url = location.href;
  try {
    if (navigator.share) {
      await navigator.share({ title: "Join my live location room", url });
      return;
    }
    await navigator.clipboard.writeText(url);
    els.shareBtn.textContent = "Link copied";
    setTimeout(() => (els.shareBtn.textContent = "Share link"), 2000);
  } catch (err) {
    if (err?.name !== "AbortError") window.prompt("Copy this link:", url);
  }
});

// ---------- Routing ----------
function waypointsFor(fromId, toId) {
  const a = users.get(fromId);
  const b = users.get(toId);
  return [L.latLng(a.latitude, a.longitude), L.latLng(b.latitude, b.longitude)];
}

function startRoute() {
  const fromId = els.user1.value;
  const toId = els.user2.value;
  if (!users.has(fromId) || !users.has(toId)) {
    els.routeInfo.textContent = "Pick two people to route between.";
    return;
  }
  if (fromId === toId) {
    els.routeInfo.textContent = "Pick two different people.";
    return;
  }

  const control = L.Routing.control({
    waypoints: waypointsFor(fromId, toId),
    router: L.Routing.osrmv1({ serviceUrl: OSRM_URL }),
    addWaypoints: false,
    draggableWaypoints: false,
    routeWhileDragging: false,
    fitSelectedRoutes: "smart",
    show: false,
    collapsible: true,
    createMarker: () => null,
  })
    .on("routesfound", (e) => {
      const { totalDistance, totalTime } = e.routes[0].summary;
      els.routeInfo.textContent = `${formatDistance(totalDistance)} by road, about ${formatDuration(totalTime)}`;
    })
    .on("routingerror", () => {
      const [a, b] = waypointsFor(fromId, toId);
      els.routeInfo.textContent = `No road route found. Straight-line distance: ${formatDistance(map.distance(a, b))}`;
    })
    .addTo(map);

  route = { control, fromId, toId, lastUpdate: Date.now(), timer: null };
  setFollow(false);
  els.routeInfo.textContent = "Finding route...";
  els.routeBtn.textContent = "Stop";
  els.user1.disabled = true;
  els.user2.disabled = true;
}

function stopRoute(message = "") {
  if (route) {
    clearTimeout(route.timer);
    map.removeControl(route.control);
    route = null;
  }
  els.routeInfo.textContent = message;
  els.routeBtn.textContent = "Route";
  els.user1.disabled = false;
  els.user2.disabled = false;
}

// Re-route as people move, but no more than once every ROUTE_REFRESH_MS
function scheduleRouteUpdate() {
  if (!route || route.timer) return;
  const wait = Math.max(0, route.lastUpdate + ROUTE_REFRESH_MS - Date.now());
  route.timer = setTimeout(() => {
    if (!route) return;
    route.timer = null;
    route.lastUpdate = Date.now();
    route.control.setWaypoints(waypointsFor(route.fromId, route.toId));
  }, wait);
}

els.routeBtn.addEventListener("click", () => (route ? stopRoute() : startRoute()));
