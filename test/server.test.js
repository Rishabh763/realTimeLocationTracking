import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { io as connect } from "socket.io-client";

const PORT = 3998;
const URL = `http://localhost:${PORT}`;
let server;
const sockets = [];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function client() {
  const s = connect(URL, { transports: ["websocket"], forceNew: true });
  sockets.push(s);
  return s;
}

function join(socket, payload) {
  return new Promise((resolve) => socket.emit("join", payload, resolve));
}

function nextEvent(socket, event, timeout = 1500) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeout);
    socket.once(event, (data) => {
      clearTimeout(t);
      resolve(data);
    });
  });
}

before(async () => {
  server = spawn(process.execPath, [path.join(import.meta.dirname, "..", "index.js")], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: "ignore",
  });
  for (let i = 0; i < 300; i++) {
    try {
      if ((await fetch(`${URL}/healthz`)).ok) return;
    } catch {}
    await wait(100);
  }
  throw new Error("server did not start");
}, { timeout: 40000 });

after(() => {
  sockets.forEach((s) => s.close());
  server.kill();
});

test("serves the page, vendor libraries and health check", async () => {
  for (const p of [
    "/",
    "/healthz",
    "/js/script.js",
    "/css/style.css",
    "/vendor/leaflet/leaflet.js",
    "/vendor/leaflet/leaflet.css",
    "/vendor/leaflet/images/marker-icon.png",
    "/vendor/leaflet-routing-machine/leaflet-routing-machine.min.js",
    "/socket.io/socket.io.min.js",
  ]) {
    const res = await fetch(URL + p);
    assert.equal(res.status, 200, p);
  }
});

test("rejects invalid rooms and names", async () => {
  const s = client();
  assert.equal((await join(s, { room: "x", username: "A" })).ok, false);
  assert.equal((await join(s, { room: "valid-room", username: "   " })).ok, false);
  assert.equal((await join(s, { room: "valid-room", username: 42 })).ok, false);
});

test("late joiner receives existing users; rooms are isolated", async () => {
  const alice = client();
  await join(alice, { room: "room-one", username: "Alice" });
  const echo = nextEvent(alice, "receive-location");
  alice.emit("send-location", { latitude: 19.07, longitude: 72.87 });
  await echo;

  const outsider = client();
  const outsiderRes = await join(outsider, { room: "room-two", username: "Eve" });
  assert.deepEqual(outsiderRes.users, [], "other rooms must not leak users");

  const bob = client();
  const res = await join(bob, { room: "room-one", username: "Bob" });
  assert.equal(res.ok, true);
  assert.equal(res.users.length, 1);
  assert.equal(res.users[0].username, "Alice");
  assert.equal(res.users[0].latitude, 19.07);
});

test("clients cannot spoof id or username, and bad coordinates are dropped", async () => {
  const victim = client();
  const vRes = await join(victim, { room: "room-spoof", username: "Victim" });
  const attacker = client();
  const aRes = await join(attacker, { room: "room-spoof", username: "Attacker" });

  const received = nextEvent(victim, "receive-location");
  attacker.emit("send-location", {
    id: vRes.id,
    username: "<img src=x onerror=alert(1)>",
    latitude: 10,
    longitude: 20,
  });
  const data = await received;
  assert.equal(data.id, aRes.id);
  assert.equal(data.username, "Attacker");

  await wait(1100); // let the per-socket rate limit pass
  let got = false;
  victim.once("receive-location", () => (got = true));
  attacker.emit("send-location", { latitude: 200, longitude: 20 });
  attacker.emit("send-location", { latitude: "abc", longitude: null });
  await wait(300);
  assert.equal(got, false, "invalid coordinates must not be broadcast");
});

test("rate limits rapid updates", async () => {
  const s = client();
  await join(s, { room: "room-rate", username: "Fast" });
  let count = 0;
  s.on("receive-location", () => count++);
  for (let i = 0; i < 10; i++) s.emit("send-location", { latitude: 1 + i / 1000, longitude: 1 });
  await wait(400);
  assert.equal(count, 1);
});

test("disconnect is broadcast and the user is removed from the snapshot", async () => {
  const a = client();
  const aRes = await join(a, { room: "room-leave", username: "Stays" });
  const b = client();
  const bRes = await join(b, { room: "room-leave", username: "Leaves" });
  const located = nextEvent(a, "receive-location");
  b.emit("send-location", { latitude: 5, longitude: 5 });
  await located;

  const gone = nextEvent(a, "user-disconnected");
  b.close();
  assert.equal(await gone, bRes.id);

  const c = client();
  const cRes = await join(c, { room: "room-leave", username: "New" });
  assert.ok(!cRes.users.some((u) => u.id === bRes.id));
  assert.ok(aRes.ok);
});
