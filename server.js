// Pisan Lig köprüsü: tarayıcıdan Minecraft sunucularına gerçek bir Minecraft istemcisiyle (mineflayer) bağlanır.
//
//   node server.js <port> <anahtar>
//
// Her tarayıcı için köprüde gerçek bir Minecraft istemcisi çalışır: sürüm sunucudan otomatik bulunur (1.8 – en yeni),
// cracked sunuculara sadece adla, online sunuculara Microsoft hesabıyla girilir. Varsayılan sunucu Pisan Lig'dir;
// orada oyuncu "(mobil)Ad" olur ve eklenti onu anahtarla doğrular. Sunucu kapalıysa giriş denemesi exaroton'un
// "oyuncu girince başlat" özelliğini tetikler; açılınca oyuncu içeri girer.
"use strict";
const http = require("http");
const https = require("https");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");
const mineflayer = require("mineflayer");
const { Vec3 } = require("vec3");

const PORT = +(process.argv[2] || process.env.PORT || 25565);
const KEY = (process.argv[3] || process.env.RELAY_KEY || readFile("pisan-relay-key.txt") || "").trim();
const HOME_SERVER = (process.env.MC_SERVER || "pisan-sf-league.exaroton.me").toLowerCase();
const PVP_SERVER = (process.env.PVP_SERVER || "pisanpvp.exaroton.me").toLowerCase();
const STRIKE_SERVER = (process.env.STRIKE_SERVER || "pisanstrike.exaroton.me").toLowerCase();
const WEB = path.join(__dirname, "web");
const MAX_PLAYERS = 40;
const MAX_PER_IP = 3;

if (KEY.length < 8) {
  console.error("Anahtar yok: node server.js <port> <anahtar>  (ya da yanına pisan-relay-key.txt koy)");
  process.exit(1);
}
function readFile(f) { try { return fs.readFileSync(path.join(__dirname, f), "utf8"); } catch (e) { return ""; } }
const log = (...a) => console.log("[" + new Date().toTimeString().slice(0, 8) + "]", ...a);

// ---------- HTTP: the game page, textures (bundled), skins (fetched from Mojang and kept) ----------
const skins = new Map();
function getJson(url) {
  return new Promise(res => https.get(url, r => { let d = ""; r.on("data", c => d += c); r.on("end", () => { try { res(r.statusCode === 200 ? JSON.parse(d) : null); } catch (e) { res(null); } }); }).on("error", () => res(null)));
}
function getBuffer(url) {
  return new Promise(res => https.get(url, r => { const b = []; r.on("data", c => b.push(c)); r.on("end", () => res(r.statusCode === 200 ? Buffer.concat(b) : null)); }).on("error", () => res(null)));
}
async function skinPng(name) {
  const k = name.toLowerCase();
  if (skins.has(k)) return skins.get(k);
  skins.set(k, null);
  let png = null;
  if (k === "@ball") {
    png = await getBuffer("https://textures.minecraft.net/texture/8e4a70b7bbcd7a8c322d522520491a27ea6b83d60ecf961d2b4efbbf9f605d");
  } else {
    const id = await getJson("https://api.mojang.com/users/profiles/minecraft/" + encodeURIComponent(name));
    const profile = id && await getJson("https://sessionserver.mojang.com/session/minecraft/profile/" + id.id);
    const tex = profile && profile.properties && profile.properties.find(p => p.name === "textures");
    if (tex) {
      const t = JSON.parse(Buffer.from(tex.value, "base64").toString()).textures || {};
      if (t.SKIN && t.SKIN.url) png = await getBuffer(t.SKIN.url.replace("http://", "https://"));
      capes.set(k, t.CAPE && t.CAPE.url ? await getBuffer(t.CAPE.url.replace("http://", "https://")) : null);
    }
  }
  skins.set(k, png);
  return png;
}
const capes = new Map();
async function capePng(name) { const k = name.toLowerCase(); if (!skins.has(k)) await skinPng(name); return capes.get(k) || null; }
/* pack.zip may be a whole Minecraft client .jar (23 MB): players get only what the game draws (block, item and
   GUI textures), copied entry by entry, still compressed, into pack-web.zip. */
function slimPack() {
  const src = path.join(__dirname, "pack.zip"), out = path.join(__dirname, "pack-web5.zip");
  let st; try { st = fs.statSync(src); } catch (e) { return null; }
  try { if (fs.statSync(out).mtimeMs >= st.mtimeMs) return out; } catch (e) { }
  try {
    const b = fs.readFileSync(src);
    let eocd = -1;
    for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error("zip değil");
    const count = b.readUInt16LE(eocd + 10);
    let p = b.readUInt32LE(eocd + 16);
    const locals = [], centrals = [];
    let offset = 0;
    for (let k = 0; k < count; k++) {
      if (b.readUInt32LE(p) !== 0x02014b50) throw new Error("bozuk zip");
      const nameLen = b.readUInt16LE(p + 28), extraLen = b.readUInt16LE(p + 30), commentLen = b.readUInt16LE(p + 32);
      const name = b.toString("utf8", p + 46, p + 46 + nameLen);
      const lo = b.readUInt32LE(p + 42), csize = b.readUInt32LE(p + 20);
      const central = b.subarray(p, p + 46 + nameLen + extraLen + commentLen);
      p += 46 + nameLen + extraLen + commentLen;
      if (!/^assets\/minecraft\/(textures\/(block|item|gui|font|environment|entity|models\/armor|painting|misc)\/[a-z0-9_\/]+\.png(\.mcmeta)?|font\/[a-z0-9_\/]+\.json)$/.test(name)) continue;
      const lNameLen = b.readUInt16LE(lo + 26), lExtraLen = b.readUInt16LE(lo + 28);
      const local = Buffer.from(b.subarray(lo, lo + 30 + lNameLen + lExtraLen + csize));
      local.writeUInt16LE(local.readUInt16LE(6) & ~8, 6); // sizes are in the header; no data descriptor follows
      const c = Buffer.from(central); c.writeUInt32LE(offset, 42); c.writeUInt16LE(c.readUInt16LE(8) & ~8, 8);
      locals.push(local); centrals.push(c); offset += local.length;
    }
    if (!locals.length) throw new Error("pakette doku yok");
    for (const old of ["pack-web.zip", "pack-web2.zip", "pack-web3.zip", "pack-web4.zip"]) try { fs.unlinkSync(path.join(__dirname, old)); } catch (e) { }
    const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(locals.length, 8); end.writeUInt16LE(locals.length, 10);
    end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
    fs.writeFileSync(out + ".tmp", Buffer.concat([...locals, cd, end])); fs.renameSync(out + ".tmp", out);
    log("Doku paketi hazırlandı:", locals.length, "doku,", Math.round(offset / 1024), "KB");
    return out;
  } catch (e) { log("Doku paketi okunamadı:", e.message); return null; }
}
/* Minecraft's sounds are not in the client .jar: they come from Mojang's asset server, looked up in the 1.20.1
   asset index, fetched the first time a player needs one and kept in sounds-cache/. */
const SND_DIR = path.join(__dirname, "sounds-cache");
let assetIndex = null;
async function assets() {
  if (assetIndex) return assetIndex;
  const f = path.join(SND_DIR, "index-1.20.1.json");
  try { assetIndex = JSON.parse(fs.readFileSync(f, "utf8")); return assetIndex; } catch (e) { }
  const manifest = await getJson("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json");
  const v = manifest && manifest.versions.find(x => x.id === "1.20.1");
  const ver = v && await getJson(v.url);
  const idx = ver && await getJson(ver.assetIndex.url);
  if (!idx) return null;
  fs.mkdirSync(SND_DIR, { recursive: true }); fs.writeFileSync(f, JSON.stringify(idx));
  assetIndex = idx; return idx;
}
const assetJobs = new Map();
async function asset(name) {
  const idx = await assets(); const o = idx && idx.objects[name];
  if (!o) return null;
  const f = path.join(SND_DIR, o.hash);
  try { return fs.readFileSync(f); } catch (e) { }
  if (!assetJobs.has(o.hash)) assetJobs.set(o.hash, getBuffer("https://resources.download.minecraft.net/" + o.hash.slice(0, 2) + "/" + o.hash).then(b => { assetJobs.delete(o.hash); if (b) { fs.mkdirSync(SND_DIR, { recursive: true }); fs.writeFileSync(f, b); } return b; }));
  return assetJobs.get(o.hash);
}
const server = http.createServer(async (req, res) => {
  const url = decodeURIComponent((req.url || "/").split("?")[0]);
  const send = (code, type, body, cache) => { res.writeHead(code, { "Content-Type": type, "Cache-Control": cache || "no-cache" }); res.end(body); };
  if (url === "/" || url === "/oyna") return send(200, "text/html; charset=utf-8", fs.readFileSync(path.join(WEB, "game.html")));
  let m = url.match(/^\/tex\/((?:item\/)?[a-z0-9_]{1,64}\.png)$/);
  if (m) { const f = path.join(WEB, "tex", m[1]); return fs.existsSync(f) ? send(200, "image/png", fs.readFileSync(f), "max-age=86400") : send(404, "text/plain", "404"); }
  // The server's own default texture pack: pack.zip next to server.js, put there by whoever runs the relay.
  if (url === "/pack.json" || url === "/pack.zip") {
    const f = slimPack();
    let st = null; try { st = f && fs.statSync(f); } catch (e) { }
    if (!st || !st.isFile()) return send(404, "text/plain", "404");
    if (url === "/pack.json") return send(200, "application/json", JSON.stringify({ name: process.env.PACK_NAME || "Sunucu paketi", size: st.size, v: Math.round(st.mtimeMs) }));
    res.writeHead(200, { "Content-Type": "application/zip", "Content-Length": st.size, "Cache-Control": "max-age=3600" });
    return fs.createReadStream(f).pipe(res);
  }
  if (url === "/sounds.json") { const b = await asset("minecraft/sounds.json"); return b ? send(200, "application/json", b, "max-age=86400") : send(404, "text/plain", "404"); }
  m = url.match(/^\/snd\/([a-z0-9_\/.-]{1,120})\.ogg$/);
  if (m && !m[1].includes("..")) { const b = await asset("minecraft/sounds/" + m[1] + ".ogg"); return b ? send(200, "audio/ogg", b, "max-age=604800") : send(404, "text/plain", "404"); }
  m = url.match(/^\/skinhash\/([0-9a-f]{20,80})$/);
  if (m) { const k = "#" + m[1]; if (!skins.has(k)) skins.set(k, await getBuffer("https://textures.minecraft.net/texture/" + m[1])); const png = skins.get(k); return png ? send(200, "image/png", png, "max-age=86400") : send(404, "text/plain", "404"); }
  m = url.match(/^\/cape\/([A-Za-z0-9_]{1,16})$/);
  if (m) { const png = await capePng(m[1]); return png ? send(200, "image/png", png, "max-age=600") : send(404, "text/plain", "404"); }
  m = url.match(/^\/skin\/(@ball|[A-Za-z0-9_]{1,16})$/);
  if (m) { const png = await skinPng(m[1]); return png ? send(200, "image/png", png, "max-age=600") : send(404, "text/plain", "404"); }
  send(404, "text/plain", "404");
});

// ---------- browser players ----------
const sessions = new Set();
const perIp = new Map();
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 16 * 1024 });
wss.on("connection", (ws, req) => {
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").toString().split(",")[0].trim();
  if (sessions.size >= MAX_PLAYERS || (perIp.get(ip) || 0) >= MAX_PER_IP) {
    ws.send(JSON.stringify({ t: "error", text: "Şu an çok fazla bağlantı var, biraz sonra dene." }));
    return ws.close();
  }
  perIp.set(ip, (perIp.get(ip) || 0) + 1);
  const s = new Session(ws);
  sessions.add(s);
  ws.on("message", data => { try { s.onMessage(JSON.parse(data.toString())); } catch (e) { } });
  ws.on("close", () => { sessions.delete(s); perIp.set(ip, (perIp.get(ip) || 1) - 1); s.stop(); });
});

const toYaw = deg => Math.PI - deg * Math.PI / 180;           // Minecraft degrees -> mineflayer radians
const toPitch = deg => -deg * Math.PI / 180;
const HELD_PACKETS = /^(arm_animation|use_item|block_place|use_entity|block_dig|held_item_slot|entity_action|window_click|close_window|set_creative_slot|pick_item)$/;
const fromYaw = rad => ((180 - rad * 180 / Math.PI) % 360 + 540) % 360 - 180;
const fromPitch = rad => -rad * 180 / Math.PI;
const r2 = v => Math.round(v * 100) / 100;
const INTERACTIVE = /door|gate|trapdoor|chest|barrel|shulker|furnace|smoker|crafting|table|anvil|button|lever|bed|repeater|comparator|hopper|dispenser|dropper|brewing|beacon|enchant|loom|stonecutter|grindstone|cartography|lectern|note_block|jukebox|cake|bell|respawn_anchor|sign/;

class Session {
  constructor(ws) { this.ws = ws; this.bot = null; this.closed = false; this.extras = {}; this.regionAt = null; this.lastHotbar = ""; this.useTimer = null; this.shapes = new Map(); }
  send(o) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); }

  hello(o) {
    if (this.bot || this.connecting) return;
    const name = String(o.name || "").trim(), skin = String(o.skin || "").trim();
    // Three servers only: Pisan Lig and Pisan Strike (cracked, "(mobil)" names) and Pisan PvP (online mode: a real
    // Minecraft account).
    const srv = String(o.server || "").trim().toLowerCase(), pvp = srv === "pvp", strike = srv === "strike";
    const addr = (pvp ? PVP_SERVER : strike ? STRIKE_SERVER : HOME_SERVER).split(":");
    this.host = addr[0]; this.port = +addr[1] || 25565;
    this.home = !pvp && !strike; this.pvp = pvp; this.strike = strike;
    this.label = pvp ? "Pisan PvP" : strike ? "Pisan Strike" : "Pisan Lig";
    this.microsoft = pvp;
    if (this.home || this.strike) {
      if (!/^[A-Za-z0-9_]{3,9}$/.test(name)) return this.send({ t: "error", text: "Ad 3–9 karakter olmalı: harf, rakam ve _ (başına (mobil) eklenir)." });
      this.name = "(mobil)" + name;
    } else {
      // Pisan PvP: the name is the Microsoft account's own; this one only keys the sign-in for this session.
      this.name = /^[A-Za-z0-9_]{1,16}$/.test(name) ? name : "pisan";
    }
    this.skin = /^[A-Za-z0-9_]{1,16}$/.test(skin) ? skin : "";
    this.connect();
  }

  connect() {
    if (this.closed) return;
    this.connecting = true;
    this.everSpawned = false; this.lastKick = "";
    this.send({ t: "waking", text: this.label + " sunucusuna bağlanılıyor…" });
    const options = { host: this.host, port: this.port, username: this.name, hideErrors: true, checkTimeoutInterval: 60000, version: "1.20.1" };
    if (this.microsoft) {
      // Microsoft sign-in with a device code; the token lives only for this session.
      this.authDir = this.authDir || fs.mkdtempSync(path.join(os.tmpdir(), "pisan-msa-"));
      Object.assign(options, { auth: "microsoft", profilesFolder: this.authDir, onMsaCode: d => this.send({ t: "msa", code: d.user_code, url: d.verification_uri, text: d.message }) });
    } else options.auth = "offline";
    let bot;
    try { bot = this.bot = mineflayer.createBot(options); }
    catch (e) { this.connecting = false; return this.send({ t: "error", text: "Bağlanılamadı: " + e.message }); }
    // Movement leaves only as the page's ticks: one packet per game tick, as a Minecraft client sends them.
    // mineflayer's own reports are held back, except its answer to a server teleport.
    const raw = bot._client.write.bind(bot._client);
    this.held = [];
    this.flushHeld = () => { if (!this.held.length) return; const q = this.held; this.held = []; this.flushing = true; try { for (const [n, d] of q) raw(n, d); } finally { this.flushing = false; } };
    bot._client.write = (name, data) => {
      // Clicks, item use, digging, slot and sprint changes go out in the next tick, before its move, where a
      // Minecraft client sends them.
      if (HELD_PACKETS.test(name) && !this.flushing) { if (!this.held.length) this.heldAt = Date.now(); this.held.push([name, data]); return; }
      if (name === "position_look" && !this.ownMove && this.dropTpReply) { this.dropTpReply = false; return; }
      if (/^(position|position_look|look|flying)$/.test(name) && !this.ownMove) {
        if (!(name === "position_look" && this.tpReply)) return;
        this.tpReply = false;
        // The teleport answer is the last position and look the server has from us.
        this.lastMove = { x: data.x, y: data.y, z: data.z, yaw: Math.fround(data.yaw), pitch: Math.fround(data.pitch), ground: !!data.onGround, remind: 0 };
      }
      return raw(name, data);
    };
    // Packets are answered in the order they came: the pings before a teleport are answered before its confirmation.
    bot._client.prependListener("position", () => { this.tpReply = true; this.pongUpTo(Infinity); });
    // After a respawn mineflayer holds its teleport answer back for a while; a Minecraft client answers at once.
    bot._client.on("position", () => queueMicrotask(() => { // after mineflayer's own handler (and its confirmation)
      if (!this.tpReply || !bot.entity) return;
      const p = bot.entity.position, yaw = Math.fround(fromYaw(bot.entity.yaw)), pitch = Math.fround(fromPitch(bot.entity.pitch));
      this.ownMove = true;
      try { bot._client.write("position_look", { x: p.x, y: p.y, z: p.z, yaw, pitch, onGround: false, flags: { onGround: false } }); } finally { this.ownMove = false; }
      this.tpReply = false; this.dropTpReply = true; this.tpSeq++;
      this.lastMove = { x: p.x, y: p.y, z: p.z, yaw, pitch, ground: false, remind: 0 };
    }));
    // The server's pings (which anticheats use to know what the client has seen) are answered by the page,
    // after it has taken in everything sent before them, as a Minecraft client answers them between its ticks.
    this.txq = []; this.txSent = [];
    bot.once("login", () => {
      bot._client.removeAllListeners("ping");
      bot._client.on("ping", p => { if (this.txq.length || (this.changes && this.changes.length) || !this.regionAt) this.txq.push(p.id); else this.sendTx(p.id); });
    });
    bot.once("login", () => {
      if (this.pvp) return;
      // Pisan Lig and Pisan Strike: prove this "(mobil)" player comes from the relay (and, on Pisan Lig, let the
      // plugin send the extras).
      bot._client.write("custom_payload", { channel: "minecraft:register", data: Buffer.from("pisan:web") });
      bot._client.write("custom_payload", { channel: "pisan:web", data: Buffer.from(JSON.stringify({ key: KEY, skin: this.skin })) });
    });
    bot.once("spawn", () => {
      this.everSpawned = true; this.connecting = false;
      bot.physicsEnabled = false;
      // Turn as fast as the page turns (mineflayer eases the look otherwise, so a quick turn-and-shoot aims late).
      bot.physics.yawSpeed = 1000; bot.physics.pitchSpeed = 1000;
      this.tpSeq = 0;
      bot.on("forcedMove", () => { this.tpSeq++; });
      log("Girdi:", this.name, "→", this.host, bot.version);
      this.meId = (bot.player && bot.player.uuid || "me").slice(0, 8);
      this.Block = require("prismarine-block")(bot.registry);
      this.send({ t: "welcome", name: this.name, me: this.meId, server: this.label, version: bot.version });
      // States follow the server's ticks (the plugin's extras arrive once per tick); the timer covers other servers.
      this.timer = setInterval(() => {
        if (Date.now() - (this.extrasAt || 0) > 200) this.tick();
        if (this.held.length && Date.now() - this.heldAt > 250) this.flushHeld(); // the page stopped ticking (in the background)
      }, 50);
      bot.world.on("blockUpdate", (old, now) => {
        if (!now || !this.box) return;
        const p = now.position, b = this.box;
        if (p.x < b.x0 || p.x > b.x1 || p.z < b.z0 || p.z > b.z1 || p.y < b.y0 || p.y >= b.y1) return;
        (this.changes = this.changes || []).push([p.x, p.y, p.z, now.stateId]);
      });
      bot.on("chunkColumnLoad", c => {
        // A chunk arriving inside the area already sent (just after joining or a teleport): send the area again, at most every 2 s.
        const b = this.box;
        if (b && c.x + 16 > b.x0 && c.x <= b.x1 && c.z + 16 > b.z0 && c.z <= b.z1) this.dirty = true;
      });
      bot.on("respawn", () => { this.regionAt = null; this.tpReply = true; this.sprintSent = this.sneakSent = false; this.send({ t: "noworld" }); }); // a new world: no move until its teleport is answered
      // Knockback and explosions push us: the page moves by them, and the check allows for them.
      this.move = { air: 0, rise: 0, hover: 0, kbH: 0, kbY: 0 };
      const push = (vx, vy, vz, add) => { this.move.kbH = Math.max(this.move.kbH, Math.hypot(vx, vz) + 0.1); this.move.kbY = Math.max(this.move.kbY, vy + 0.1); this.ordered(add ? { t: "vel", v: [vx, vy, vz], add: 1 } : { t: "vel", v: [vx, vy, vz] }); };
      bot._client.on("entity_velocity", p => { if (bot.entity && p.entityId === bot.entity.id) { const v = p.velocity || { x: p.velocityX, y: p.velocityY, z: p.velocityZ }; push(v.x / 8000, v.y / 8000, v.z / 8000); }; });
      bot._client.on("explosion", p => { const x = p.playerMotionX ?? (p.playerKnockback && p.playerKnockback.x), y = p.playerMotionY ?? (p.playerKnockback && p.playerKnockback.y), z = p.playerMotionZ ?? (p.playerKnockback && p.playerKnockback.z); if (x || y || z) push(+x || 0, +y || 0, +z || 0, true); });
      bot._client.on("tile_entity_data", p => {
        const l = p.location, b = this.box; if (!b || !l || l.x < b.x0 || l.x > b.x1 || l.z < b.z0 || l.z > b.z1 || l.y < b.y0 || l.y >= b.y1) return;
        setTimeout(() => { const d = this.beOf(l.x, l.y, l.z); this.send({ t: "be", list: [[l.x, l.y, l.z, d]] }); }, 50);
      });
      // Arm swings and hits on others, shown on their models as in Minecraft.
      this.anims = [];
      bot.on("entitySwingArm", e => { if (e !== bot.entity) this.anims.push([this.idOf(e), "s"]); });
      bot.on("entityHurt", e => this.anims.push([this.idOf(e), "h"]));
      // Paintings say which way they face in the spawn data (2 north, 3 south, 4 west, 5 east).
      this.faces = new Map();
      this.spawnData = new Map();
      bot._client.on("spawn_entity", p => { this.spawnData.set(p.entityId, p.objectData); if (p.objectData >= 2 && p.objectData <= 5) this.faces.set(p.entityId, { 2: 180, 3: 0, 4: 90, 5: -90 }[p.objectData]); });
      bot.on("entityGone", e => { this.spawnData.delete(e.id); this.faces.delete(e.id); });
      // Sounds: by name, or by number in the sound registry (minecraft-data counts from 1, the packet from 0).
      const soundOf = p => p.sound ? (p.sound.data ? p.sound.data.soundName : (bot.registry.sounds[p.sound.soundId + 1] || {}).name) : (bot.registry.sounds[p.soundId + 1] || {}).name;
      bot._client.on("sound_effect", p => { const n = soundOf(p); if (n) this.send({ t: "snd", n: n.replace(/^minecraft:/, ""), x: p.x / 8, y: p.y / 8, z: p.z / 8, v: +p.volume.toFixed(2), p: +p.pitch.toFixed(2) }); });
      bot._client.on("entity_sound_effect", p => { const n = soundOf(p), e = bot.entities[p.entityId]; if (n && e) this.send({ t: "snd", n: n.replace(/^minecraft:/, ""), x: e.position.x, y: e.position.y, z: e.position.z, v: +p.volume.toFixed(2), p: +p.pitch.toFixed(2) }); });
      bot._client.on("world_event", p => {
        // 2001: someone broke a block (the breaker plays it themselves, everyone else is told).
        if (p.effectId !== 2001) return;
        const b = bot.registry.blocksByStateId[p.data];
        if (b) this.send({ t: "blk", k: "break", n: b.name, x: p.location.x + 0.5, y: p.location.y + 0.5, z: p.location.z + 0.5 });
      });
    });
    bot._client.on("custom_payload", p => {
      if (p.channel !== "pisan:web") return;
      try {
        const e = JSON.parse(p.data.toString());
        if (e.texts) this.send({ t: "texts", list: e.texts });
        if (e.disp) { this.disp = e.disp; this.regionAt = null; }
        this.extras = e;
        if (e.texts || e.disp) return;
        this.extrasAt = Date.now();
        if (this.bot && this.bot.entity && this.extrasAt - (this.tickAt || 0) >= 30) this.tick();
      } catch (x) { if (!this.tickErr) { this.tickErr = true; log("Durum hatası:", x && x.stack || x); } }
    });
    bot.on("message", (msg, position) => { if (position !== "game_info") this.send({ t: "text", kind: "chat", json: JSON.stringify(msg.json) }); });
    bot.on("actionBar", msg => this.send({ t: "text", kind: "actionbar", json: JSON.stringify(msg.json) }));
    bot._client.on("set_title_text", p => this.send({ t: "text", kind: "title", json: typeof p.text === "string" ? p.text : JSON.stringify(p.text) }));
    bot._client.on("set_title_subtitle", p => this.send({ t: "text", kind: "subtitle", json: typeof p.text === "string" ? p.text : JSON.stringify(p.text) }));
    bot.on("windowOpen", w => {
      this.menu(w);
      // The server changes what is in an open menu (live counters, pages): show it as it changes.
      w.on("updateSlot", () => { clearTimeout(this.menuTimer); this.menuTimer = setTimeout(() => { if (this.bot && this.bot.currentWindow === w) this.menu(w); }, 60); });
    });
    bot.on("windowClose", () => this.send({ t: "menuclose" }));
    bot.on("death", () => this.send({ t: "text", kind: "title", json: JSON.stringify({ text: "Öldün!", color: "red" }) }));
    bot.on("kicked", reason => { this.lastKick = plainText(reason); log("Atıldı:", this.name, this.lastKick); });
    bot.on("error", e => { this.lastKick = this.lastKick || String(e.message || e); });
    bot.on("end", () => {
      clearInterval(this.timer); clearInterval(this.useTimer);
      this.bot = null; this.connecting = false;
      if (this.closed) return;
      if (this.everSpawned || (this.pvp && this.wakeTries > 30)) {
        this.send({ t: "error", text: "Sunucudan ayrıldın: " + (this.lastKick || "bağlantı koptu") });
        return this.ws.close();
      }
      // Not up yet: this join attempt has asked exaroton to start it (both servers start on join). Knock again shortly.
      this.wakeTries = (this.wakeTries || 0) + 1;
      this.send({ t: "waking", text: this.lastKick || "Sunucu başlatılıyor…" });
      this.retry = setTimeout(() => this.connect(), 8000);
    });
  }

  stop() {
    this.closed = true;
    clearInterval(this.timer); clearInterval(this.useTimer); clearTimeout(this.retry);
    if (this.bot) { try { this.bot.quit(); } catch (e) { } }
    if (this.authDir) fs.rm(this.authDir, { recursive: true, force: true }, () => { });
  }

  onMessage(o) {
    if (o.t === "hello") return this.hello(o);
    const bot = this.bot;
    if (!bot || !bot.entity) return;
    const adventure = bot.game && (bot.game.gameMode === "adventure" || bot.game.gameMode === "spectator");
    switch (o.t) {
      case "pong": this.pongUpTo(o.id); break;
      case "in": {
        const yaw = +o.yaw, pitch = Math.max(-90, Math.min(90, +o.pitch));
        if (Number.isFinite(yaw) && Number.isFinite(pitch)) { bot.entity.yaw = toYaw(yaw); bot.entity.pitch = toPitch(pitch); }
        if (!o.k) break;
        // One game tick of the page. First the sprint and sneak keys (as a client sends them before its move),
        const f = +o.f || 0;
        // sprinting as a client may: forward, not sneaking, not starving (food above 6).
        const sprint = !!o.run && f > 0.3 && !o.sneak && (bot.food === undefined || bot.food > 6);
        // (Kept here rather than in mineflayer: a respawned player starts fresh, and the keys still held are sent again.)
        const act = id => bot._client.write("entity_action", { entityId: bot.entity.id, actionId: id, jumpBoost: 0 });
        if (!!this.sprintSent !== sprint) { this.sprintSent = sprint; act(sprint ? 3 : 4); }
        if (!!this.sneakSent !== !!o.sneak) { this.sneakSent = !!o.sneak; act(o.sneak ? 0 : 1); }
        this.flushHeld();
        // then the move. The page moves the player (with collisions), as a Minecraft client does.
        // After a server teleport, positions from before the page saw it are ignored.
        // A dead player does not move, and nothing moves before the server's teleport has been answered.
        const alive = bot.isAlive !== false && !(bot.health <= 0);
        if (alive && !this.tpReply && Array.isArray(o.pos) && o.pos.length === 3 && o.pos.every(Number.isFinite) && o.tp === this.tpSeq && Number.isFinite(yaw) && Number.isFinite(pitch)) {
          const check = this.checkMove(o.pos, !!o.sneak);
          if (check.ok) {
            bot.entity.position.set(o.pos[0], o.pos[1], o.pos[2]);
            const ground = !!o.ground;
            bot.entity.onGround = ground;
            this.sendMove(yaw, pitch, ground);
          } else {
            // Not a move a Minecraft client could make: it never reaches the server; the page is put back.
            this.tpSeq++;
            this.rejects = (this.rejects || 0) + 1;
            if (this.rejects === 1 || this.rejects % 50 === 0) log("Geçersiz hareket engellendi:", this.name, check.why, "(" + this.rejects + ")");
          }
        }
        break;
      }
      case "act": this.act(o.a, adventure); break;
      case "slot": if (o.i >= 0 && o.i < 9) bot.setQuickBarSlot(o.i); break;
      case "click":
        if (o.inv && !bot.currentWindow) bot.clickWindow(o.slot, o.right ? 1 : 0, 0).catch(() => { }).finally(() => this.inventory());
        else if (bot.currentWindow && o.slot >= 0) bot.clickWindow(o.slot, o.right ? 1 : 0, 0).catch(() => { }).finally(() => { if (bot.currentWindow) this.menu(bot.currentWindow); });
        break;
      case "close": if (bot.currentWindow) bot.closeWindow(bot.currentWindow); break;
      case "inv": this.inventory(); break;
      case "chat": { const now = Date.now(); if (now - (this.lastChat || 0) < 400) break; this.lastChat = now; if (typeof o.text === "string" && o.text.trim()) bot.chat(o.text.trim().slice(0, 256)); break; }
    }
  }

  /* Clicks as a Minecraft client makes them: hit what you look at, dig, use and place blocks, use items. */
  act(a, adventure) {
    const bot = this.bot;
    const held = bot.heldItem;
    if (a === "ldown") {
      const creative = bot.game && bot.game.gameMode === "creative";
      const now = Date.now(); if (now - (this.lastAttack || 0) < 50) return; this.lastAttack = now;
      const entity = bot.entityAtCursor(creative ? 5 : 3);
      if (entity) {
        bot.attack(entity);
        return;
      }
      const block = !adventure && bot.blockAtCursor(creative ? 5 : 4.5);
      if (block && block.name !== "air" && bot.canDigBlock(block)) {
        const p = block.position, name = block.name;
        bot.dig(block, "ignore").then(() => this.send({ t: "blk", k: "break", n: name, x: p.x + 0.5, y: p.y + 0.5, z: p.z + 0.5 })).catch(() => { });
        this.digging = true; return;
      }
      bot.swingArm("right");
    } else if (a === "lup") {
      if (this.digging) { this.digging = false; try { bot.stopDigging(); } catch (e) { } }
    } else if (a === "left") {
      this.act("ldown", adventure);
      setTimeout(() => this.act("lup", adventure), 60);
    } else if (a === "rdown") {
      const creative = bot.game && bot.game.gameMode === "creative";
      const entity = bot.entityAtCursor(creative ? 5 : 3);
      if (entity && entity.type !== "object") { bot.activateEntity(entity).catch(() => { }); return; }
      const block = bot.blockAtCursor(creative ? 5 : 4.5);
      if (block && block.name !== "air" && !adventure) {
        if (INTERACTIVE.test(block.name) && !this.sneakSent) { bot.activateBlock(block).catch(() => { }); return; }
        if (held && bot.registry.blocksByName[held.name] && block.face !== undefined) {
          const faces = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(0, 0, -1), new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(1, 0, 0)];
          const at = block.position.plus(faces[block.face]), name = held.name;
          bot.placeBlock(block, faces[block.face]).catch(() => { });
          this.send({ t: "blk", k: "place", n: name, x: at.x + 0.5, y: at.y + 0.5, z: at.z + 0.5 });
          return;
        }
      }
      // Holding right click: a Minecraft client repeats "use" every 4 ticks; a bow is drawn and held.
      if (held && held.name === "bow") bot.activateItem();
      else { bot.activateItem(); clearInterval(this.useTimer); this.useTimer = setInterval(() => { try { bot.activateItem(); } catch (e) { } }, 200); }
    } else if (a === "rup") {
      clearInterval(this.useTimer); this.useTimer = null;
      if (bot.usingHeldItem || (held && held.name === "bow")) bot.deactivateItem();
    }
  }

  idOf(e) {
    if (e === this.bot.entity) return this.meId;
    if (e.type === "player") return (e.uuid || "").slice(0, 8);
    return (e.name === "armor_stand" ? "a" : e.name === "item" ? "i" : "m") + e.id.toString(16);
  }

  /* 20 times a second: everyone nearby, the ball, our own position, health; the blocks when they change. */
  tick() {
    const bot = this.bot;
    if (!bot || !bot.entity) return;
    const camera = this.extras.cam;
    const view = camera ? new Vec3(camera[0], camera[1], camera[2]) : bot.entity.position;
    // Watching (a goal replay's camera, spectator): the camera hangs above the pitch and looks across it, so the
    // area sent is centred ahead of it, where it looks, and reaches further down.
    const high = !!camera || (bot.game && bot.game.gameMode === "spectator");
    let centre = view;
    if (high) { const yaw = (camera ? camera[3] : fromYaw(bot.entity.yaw)) * Math.PI / 180; centre = view.offset(-Math.sin(yaw) * 22, 0, Math.cos(yaw) * 22); }
    // The ground under the player has not arrived yet: wait for it rather than send an empty world (the page would fall).
    const ground = bot.world.getColumnAt && !bot.world.getColumnAt(bot.entity.position);
    if (ground) { this.regionAt = null; }
    else if (!this.regionAt || this.regionAt.distanceTo(centre) > (high ? 10 : 26) || this.regionHigh !== high || (this.dirty && Date.now() - (this.regionSent || 0) > 2000)) { this.regionAt = centre.clone(); this.regionHigh = high; this.dirty = false; this.changes = []; this.regionSent = Date.now(); this.region(centre, high); }
    else if (this.changes && this.changes.length) {
      // Single blocks that changed (dug, placed, doors): only those, with their palette entries.
      const list = this.changes.splice(0, 400).map(([x, y, z, sid]) => {
        const block = bot.registry.blocksByStateId[sid];
        const name = !block || /^(air|cave_air|void_air)$/.test(block.name) ? "AIR" : block.name.toUpperCase();
        return [x, y, z, name === "AIR" ? { n: "AIR", s: [] } : this.palEntry(sid, block.name), BE_DATA.test(block ? block.name : "") ? this.beOf(x, y, z) : undefined];
      });
      this.send({ t: "blocks", list });
    }
    // Pings go after the blocks and states that came before them.
    if (this.txq.length) { const q = this.txq; this.txq = []; for (const x of q) { if (typeof x === "object") this.send(x); else this.sendTx(x); } }
    const people = [];
    for (const e of Object.values(bot.entities)) {
      if (!e.position || e.position.distanceTo(view) > 80) continue;
      const isMe = e === bot.entity;
      if (e.type === "player") {
        const info = Object.values(bot.players).find(p => p.uuid === e.uuid);
        const name = isMe ? this.name : (e.username || (info && info.username) || "");
        if (info && info.gamemode === 3 && !isMe) continue;
        // The skin the server gives this player (as a Minecraft client gets it), else their name for Mojang.
        const sd = (info && info.skinData) || (isMe && bot.player && bot.player.skinData) || null;
        const skinKey = sd && sd.url ? "#" + sd.url.split("/").pop() : isMe && this.skin ? this.skin : (name.startsWith("(mobil)") ? "" : name);
        const capeKey = sd && sd.capeUrl ? "#" + sd.capeUrl.split("/").pop() : "";
        people.push([isMe ? this.meId : (e.uuid || "").slice(0, 8), name, teamOf(bot, name), r2(e.position.x), r2(e.position.y), r2(e.position.z), Math.round(fromYaw(e.yaw)), Math.round(fromPitch(e.pitch)), sneaking(e) ? 1 : 0, skinKey, "p", 0.6, 1.8, heldName(isMe ? bot.heldItem : e.heldItem), 0, armourOf(isMe ? { equipment: [0, 0, bot.inventory.slots[8], bot.inventory.slots[7], bot.inventory.slots[6], bot.inventory.slots[5]] } : e), offhandOf(isMe ? { equipment: [0, bot.inventory.slots[45]] } : e), sd && sd.model === "slim" ? 1 : 0, capeKey]);
      } else if (e.name === "armor_stand") {
        if (invisible(e)) continue;
        people.push(["a" + e.id.toString(16), customName(e), -1, r2(e.position.x), r2(e.position.y), r2(e.position.z), Math.round(fromYaw(e.yaw)), 0, 0, "", "a"]);
      } else if (e.name === "item") {
        const item = e.getDroppedItem && e.getDroppedItem();
        people.push(["i" + e.id.toString(16), item ? itemSpec(item) : "stone", -1, r2(e.position.x), r2(e.position.y), r2(e.position.z), 0, 0, 0, "", "i"]);
      } else if (["mob", "hostile", "animal", "passive", "water_creature", "ambient", "projectile", "orb"].includes(e.type) || (e.type === "other" && e.height > 0.2 && !/display|marker|interaction|area_effect/.test(e.name || ""))) {
        if (invisible(e)) continue;
        const sd = this.spawnData.get(e.id), framed = /item_frame/.test(e.name);
        let looks = looksOf(bot, e);
        if (e.name === "falling_block" && sd != null) { const b = bot.registry.blocksByStateId[sd]; if (b) looks = Object.assign(looks || {}, { block: b.name }); }
        people.push(["m" + e.id.toString(16), e.name || "mob", -1, r2(e.position.x), r2(e.position.y), r2(e.position.z), (e.name === "painting" || framed) && this.faces.has(e.id) ? this.faces.get(e.id) : Math.round(fromYaw(e.headYaw ?? e.yaw)), framed && (sd === 0 || sd === 1) ? (sd === 1 ? -90 : 90) : Math.round(fromPitch(e.pitch)), 0, customName(e), "m", r2(e.width || 0.6), r2(e.height || 1.8), heldName(e.heldItem), looks, armourOf(e), offhandOf(e)]);
      }
    }
    const x = this.extras;
    this.tickAt = Date.now();
    const o = { t: "s", ts: this.tickAt, p: people, me: [+bot.entity.position.x.toFixed(3), +bot.entity.position.y.toFixed(3), +bot.entity.position.z.toFixed(3)], tp: this.tpSeq, hp: Math.round(bot.health || 0), food: Math.round(bot.food || 0), gm: bot.game && bot.game.gameMode };
    if (this.tpSent !== this.tpSeq) { this.tpSent = this.tpSeq; o.yaw = Math.round(fromYaw(bot.entity.yaw) * 10) / 10; o.pitch = Math.round(fromPitch(bot.entity.pitch) * 10) / 10; }
    if (x.b) { o.b = x.b; o.r = x.r; o.bl = x.bl; o.c = x.c; o.ph = x.ph; o.pause = x.pause; }
    if (camera) o.cam = camera;
    { const fx = this.effectsOf(); if (fx.s || fx.sl || fx.j || fx.sf || fx.lev) o.fx = fx; }
    if (bot.time) { o.time = bot.time.timeOfDay; o.mp = bot.time.moonPhase || 0; }
    if (bot.isRaining) o.rain = 1;
    if (bot.experience) o.xp = [bot.experience.level || 0, Math.round((bot.experience.progress || 0) * 100) / 100];
    if (this.anims && this.anims.length) { o.an = this.anims; this.anims = []; }
    this.send(o);
    this.hotbar();
  }

  hotbar() {
    const bot = this.bot;
    const items = [];
    for (let i = 36; i < 45; i++) items.push(itemJson(bot.inventory.slots[i]));
    const key = JSON.stringify(items) + bot.quickBarSlot;
    if (key === this.lastHotbar) return;
    this.lastHotbar = key;
    this.send({ t: "hotbar", items, held: bot.quickBarSlot });
  }

  menu(w) {
    const size = w.inventoryStart != null ? w.inventoryStart : w.slots.length - 36;
    const items = [];
    for (let i = 0; i < size; i++) items.push(itemJson(w.slots[i]));
    // The player's own inventory under the container, as in Minecraft (slot numbers are the window's).
    const own = [];
    for (let i = size; i < w.slots.length; i++) own.push(itemJson(w.slots[i]));
    // The window's kind (chest rows, furnace, hopper…) lays it out as Minecraft does; "cursor" is the item held on the pointer.
    this.send({ t: "menu", title: plainText(w.title), type: String(w.type || "").replace("minecraft:", ""), size, items, own, ownStart: size, cursor: itemJson(w.selectedItem) });
  }

  inventory() {
    const bot = this.bot;
    const own = [];
    for (let i = 9; i < 45; i++) own.push(itemJson(bot.inventory.slots[i]));
    const armor = [5, 6, 7, 8, 45].map(i => itemJson(bot.inventory.slots[i]));
    const craft = [0, 1, 2, 3, 4].map(i => itemJson(bot.inventory.slots[i]));
    this.send({ t: "menu", title: "Envanter", type: "inventory", size: 0, items: [], own, ownStart: 9, inv: true, armor, craft, cursor: itemJson(bot.inventory.selectedItem), skin: this.skin || (this.pvp ? this.name : "") });
  }

  /* Block shapes by state (stairs, slabs, fences…), worked out once per state. */
  shapeOf(sid) {
    if (this.shapes.has(sid)) return this.shapes.get(sid);
    let s = null;
    try {
      const b = this.Block.fromStateId(sid, 0);
      if (b.boundingBox === "empty") s = [];
      else if (b.shapes && b.shapes.length && !(b.shapes.length === 1 && b.shapes[0].every((v, i) => v === [0, 0, 0, 1, 1, 1][i]))) s = b.shapes.map(a => a.map(v => Math.round(v * 1000) / 1000));
    } catch (e) { }
    this.shapes.set(sid, s);
    return s;
  }

  /* The blocks in an 81x81x24 area around the view: a palette of block states and run-lengths. */

  /* Our effects that change movement: levels of speed, slowness, jump boost; slow falling, levitation. */
  effectsOf() {
    const e = (this.bot.entity && this.bot.entity.effects) || {}, lv = id => e[id] ? (e[id].amplifier || 0) + 1 : 0;
    return { s: lv(1), sl: lv(2), j: lv(8), sf: lv(28) ? 1 : 0, lev: lv(25) };
  }
  /* The blocks' collision boxes around a box, in world coordinates. */
  boxesNear(x0, y0, z0, x1, y1, z1) {
    const out = [], v = new Vec3(0, 0, 0);
    for (let bx = Math.floor(x0); bx <= Math.floor(x1); bx++) for (let by = Math.floor(y0) - 1; by <= Math.floor(y1); by++) for (let bz = Math.floor(z0); bz <= Math.floor(z1); bz++) {
      v.x = bx; v.y = by; v.z = bz;
      let b; try { b = this.bot.blockAt(v); } catch (e) { continue; }
      if (!b || b.boundingBox !== "block" || !b.shapes) continue;
      for (const s of b.shapes) out.push([bx + s[0], by + s[1], bz + s[2], bx + s[3], by + s[4], bz + s[5]]);
    }
    return out;
  }
  nameAt(x, y, z) { try { const b = this.bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))); return b ? b.name : ""; } catch (e) { return ""; } }
  /* Would a Minecraft client make this move? Not through blocks, not faster than running and jumping can take
     you (more on ice, with speed, after knockback), no climbing into the air or hanging in it. */
  sendTx(id) { this.send({ t: "tx", id }); this.txSent.push(id); }
  /* Something the server sent between pings (knockback): it reaches the page in the same order. */
  ordered(msg) { if (this.txq.length) this.txq.push(msg); else this.send(msg); }
  /* Answers the pings up to this one (only pings the server sent, each once, in order). id Infinity: all of them. */
  pongUpTo(id) {
    const c = this.bot && this.bot._client; if (!c) return;
    if (id === Infinity) { const q = this.txq; this.txq = []; for (const x of q) { if (typeof x === "object") this.send(x); else this.txSent.push(x); } }
    const i = id === Infinity ? this.txSent.length - 1 : this.txSent.indexOf(id);
    if (i < 0) return;
    for (const x of this.txSent.splice(0, i + 1)) c.write("pong", { id: x });
  }

  /* LocalPlayer.sendPosition: position and look only when they changed (the position at least once a second),
     or just the on-ground flag when only that changed. */
  sendMove(yaw, pitch, ground) {
    const p = this.bot.entity.position, L = this.lastMove || (this.lastMove = { x: NaN, y: NaN, z: NaN, yaw: NaN, pitch: NaN, ground: null, remind: 0 });
    // A Minecraft client's yaw keeps counting past ±180 as you turn round; the page's wraps.
    if (Number.isFinite(L.yaw)) yaw = L.yaw + ((((yaw - L.yaw) % 360) + 540) % 360 - 180);
    yaw = Math.fround(yaw); pitch = Math.fround(pitch);
    L.remind++;
    const dx = p.x - L.x, dy = p.y - L.y, dz = p.z - L.z;
    const pos = !(dx * dx + dy * dy + dz * dz <= 4e-8) || L.remind >= 20, rot = yaw !== L.yaw || pitch !== L.pitch;
    const c = this.bot._client;
    this.ownMove = true;
    try {
      if (pos && rot) c.write("position_look", { x: p.x, y: p.y, z: p.z, yaw, pitch, onGround: ground, flags: { onGround: ground } });
      else if (pos) c.write("position", { x: p.x, y: p.y, z: p.z, onGround: ground, flags: { onGround: ground } });
      else if (rot) c.write("look", { yaw, pitch, onGround: ground, flags: { onGround: ground } });
      else if (ground !== L.ground) c.write("flying", { onGround: ground, flags: { onGround: ground } });
    } finally { this.ownMove = false; }
    if (pos) { L.x = p.x; L.y = p.y; L.z = p.z; L.remind = 0; }
    if (rot) { L.yaw = yaw; L.pitch = pitch; }
    L.ground = ground;
  }

  checkMove(pos, sneak) {
    const from = this.bot.entity.position, m = this.move || (this.move = { air: 0, rise: 0, hover: 0, kbH: 0, kbY: 0 });
    const dx = pos[0] - from.x, dy = pos[1] - from.y, dz = pos[2] - from.z, hd = Math.hypot(dx, dz);
    // The page also repeats its position when only the view turns; a repeat is not a new tick of movement.
    const now = Date.now();
    if (dx === 0 && dy === 0 && dz === 0 && now - (m.at || 0) < 45) return { ok: true, ground: this.bot.entity.onGround };
    m.at = now;
    const fx = this.effectsOf(), h = sneak ? 1.5 : 1.8, eps = 1e-3;
    const feet = this.nameAt(pos[0], pos[1] + 0.1, pos[2]), chest = this.nameAt(pos[0], pos[1] + 0.9, pos[2]), under = this.nameAt(pos[0], pos[1] - 0.5, pos[2]);
    const fluid = /water|lava|bubble_column|kelp|seagrass/.test(feet + chest), climb = /ladder|^vine$|scaffolding|twisting_vines|weeping_vines|cave_vines/.test(feet);
    const ice = /ice/.test(under) || /ice/.test(this.nameAt(from.x, from.y - 0.5, from.z));
    const maxH = (ice ? 1.3 : 0.75) * (1 + 0.2 * fx.s) + m.kbH;
    const maxUp = 0.6 + 0.1 * fx.j + m.kbY + (fx.lev ? 0.5 : 0) + (fluid ? 0.2 : 0);
    const decay = () => { m.kbH *= 0.91; m.kbY = Math.max(0, m.kbY - 0.08); };
    if (hd > maxH) { decay(); return { ok: false, why: "hız " + hd.toFixed(2) }; }
    if (dy > maxUp) { decay(); return { ok: false, why: "yükselme " + dy.toFixed(2) }; }
    if (dy < -4) { decay(); return { ok: false, why: "düşüş " + dy.toFixed(2) }; }
    const boxes = this.boxesNear(pos[0] - 0.3, pos[1], pos[2] - 0.3, pos[0] + 0.3, pos[1] + h, pos[2] + 0.3);
    const overlaps = (q, list) => list.some(b => b[0] < q[0] + 0.3 - eps && b[3] > q[0] - 0.3 + eps && b[2] < q[2] + 0.3 - eps && b[5] > q[2] - 0.3 + eps && b[1] < q[1] + h - eps && b[4] > q[1] + eps);
    // Put inside a block by the server (a teleport, a block placed on them): as in Minecraft, they may climb back out.
    const stuck = () => overlaps([from.x, from.y, from.z], this.boxesNear(from.x - 0.3, from.y, from.z - 0.3, from.x + 0.3, from.y + h, from.z + 0.3));
    if (overlaps(pos, boxes) && !stuck()) { decay(); return { ok: false, why: "blok içinden geçiş" }; }
    const ground = boxes.some(b => b[0] < pos[0] + 0.3 - eps && b[3] > pos[0] - 0.3 + eps && b[2] < pos[2] + 0.3 - eps && b[5] > pos[2] - 0.3 + eps && b[4] <= pos[1] + eps && b[4] > pos[1] - 0.03);
    // In the air: a jump rises at most about 1.25 blocks; gravity always pulls (no hovering).
    if (ground || fluid || climb || fx.lev || fx.sf) { m.air = 0; m.rise = 0; m.hover = 0; }
    else {
      m.air++; if (dy > 0) m.rise += dy;
      m.hover = dy > -eps ? m.hover + 1 : 0;
      if (dy > 0 && m.rise > 1.3 + 0.55 * fx.j + m.kbY * 3) { decay(); return { ok: false, why: "havada yükselme" }; }
      if (m.hover > 12 && m.kbY < 0.1) { decay(); return { ok: false, why: "havada asılı kalma" }; }
    }
    decay();
    return { ok: true, ground };
  }

  /* A palette entry: name, shape; for blocks Minecraft draws as models (chests, beds, signs…) their state too. */
  palEntry(sid, name) {
    const s = this.shapeOf(sid), e = s === null ? { n: name.toUpperCase() } : { n: name.toUpperCase(), s };
    if (BE_BLOCK.test(name)) { try { e.p = this.Block.fromStateId(sid, 0).getProperties(); } catch (x) { } }
    return e;
  }
  /* What a sign says, a banner's patterns, whose head a skull is. */
  beOf(x, y, z) {
    let be; try { const b = this.bot.blockAt(new Vec3(x, y, z)); be = b && b.blockEntity; } catch (e) { }
    if (!be) return 0;
    const out = {};
    const side = t => t && { m: (t.messages || []).map(String), c: t.color || "black", g: t.has_glowing_text ? 1 : 0 };
    if (be.front_text) { out.f = side(be.front_text); out.b = side(be.back_text); }
    else if (be.Text1 !== undefined) out.f = { m: [be.Text1, be.Text2, be.Text3, be.Text4].map(v => String(v || "")), c: be.Color || "black", g: be.GlowingText ? 1 : 0 };
    if (be.Patterns) out.pt = be.Patterns.map(q => [q.Pattern, q.Color]);
    const owner = be.SkullOwner || be.profile;
    if (owner) {
      if (typeof owner === "string") out.o = owner;
      else {
        if (owner.Name || owner.name) out.o = owner.Name || owner.name;
        try { const v = (owner.Properties || owner.properties).textures[0].Value; const url = JSON.parse(Buffer.from(v, "base64").toString()).textures.SKIN.url; out.h = url.split("/").pop(); } catch (e) { }
      }
    }
    return Object.keys(out).length ? out : 0;
  }

  region(c, high) {
    const bot = this.bot, r = 40;
    // A replay camera hangs well above the pitch: reach further down so the ground stays in the picture.
    const bx = Math.floor(c.x), bz = Math.floor(c.z), y0 = Math.floor(c.y) - (high ? 20 : 8), y1 = y0 + (high ? 30 : 24);
    this.box = { x0: bx - r, x1: bx + r, z0: bz - r, z1: bz + r, y0, y1 };
    const palette = [{ n: "AIR", s: [] }], index = new Map();
    const runs = []; let last = -1, count = 0;
    const p = new Vec3(0, 0, 0);
    for (let y = y0; y < y1; y++) for (let z = bz - r; z <= bz + r; z++) for (let x = bx - r; x <= bx + r; x++) {
      p.x = x; p.y = y; p.z = z;
      const sid = bot.world.getBlockStateId(p);
      let id = 0;
      if (sid) {
        id = index.get(sid);
        if (id === undefined) {
          const block = bot.registry.blocksByStateId[sid];
          const name = block ? block.name : "air";
          if (name === "air" || name === "cave_air" || name === "void_air") id = 0;
          else { id = palette.length; palette.push(this.palEntry(sid, name)); }
          index.set(sid, id);
        }
      }
      if (id === last) count++; else { if (count > 0) runs.push(count === 1 ? String(last) : last + "*" + count); last = id; count = 1; }
    }
    runs.push(count === 1 ? String(last) : last + "*" + count);
    // Block entity data (sign text, banner patterns, head owners) for the area.
    const be = [];
    palette.forEach((e, i) => { e.be = BE_DATA.test(e.n.toLowerCase()); });
    if (palette.some(e => e.be)) {
      const q = new Vec3(0, 0, 0);
      for (let y = y0; y < y1; y++) for (let z = bz - r; z <= bz + r; z++) for (let x = bx - r; x <= bx + r; x++) {
        q.x = x; q.y = y; q.z = z; const sid = bot.world.getBlockStateId(q); const id = sid && index.get(sid);
        if (id && palette[id].be) { const d = this.beOf(x, y, z); if (d) be.push([x, y, z, d]); }
      }
    }
    palette.forEach(e => { delete e.be; });
    this.send({ t: "world", be, x0: bx - r, y0, z0: bz - r, nx: 2 * r + 1, ny: y1 - y0, nz: 2 * r + 1, pal: palette, runs: runs.join(","), disp: this.home ? (this.disp || []) : [] });
  }
}

const BE_BLOCK = /chest$|shulker_box$|_bed$|banner$|sign$|_skull$|_head$|^bell$|decorated_pot|^conduit$|^beacon$|^enchanting_table$|^lectern$/;
const BE_DATA = /sign$|banner$|_skull$|_head$/;
const nbtLib = require("prismarine-nbt");
/* What else shows on an item: enchantment glint, banner/shield patterns, whose head, dye colour. */
function itemExtras(item) {
  const x = {};
  try { if ((item.enchants && item.enchants.length) || item.name === "enchanted_book" || item.name === "enchanted_golden_apple") x.g = 1; } catch (e) { }
  let n = null; try { n = item.nbt ? nbtLib.simplify(item.nbt) : null; } catch (e) { }
  if (n) {
    const bet = n.BlockEntityTag;
    if (bet && bet.Patterns) x.pt = bet.Patterns.map(q => [q.Pattern, q.Color]);
    if (bet && bet.Base !== undefined) x.bc = bet.Base;
    const so = n.SkullOwner;
    if (so) { if (typeof so === "string") x.o = so; else { if (so.Name) x.o = so.Name; try { const v = so.Properties.textures[0].Value; x.h = JSON.parse(Buffer.from(v, "base64").toString()).textures.SKIN.url.split("/").pop(); } catch (e) { } } }
    if (n.display && n.display.color !== undefined) x.c = n.display.color;
    if (n.Enchantments && n.Enchantments.length) x.g = 1;
  }
  return x;
}
/* An item for the models: its name, then its extras as JSON after "~" when it has any. */
function itemSpec(item) {
  if (!item || !item.name) return "";
  const x = itemExtras(item);
  return Object.keys(x).length ? item.name + "~" + JSON.stringify(x) : item.name;
}
function heldName(item) { return itemSpec(item); }
function offhandOf(e) { return itemSpec((e.equipment || [])[1]); }
/* What a mob looks like beyond its kind (wool colour, horse coat, villager job, baby…), by metadata name. */
const LOOKS = ["baby", "wool", "flags", "type_variant", "variant", "collar_color", "type", "main_gene", "hidden_gene", "color", "villager_data", "saddle", "swag", "chest", "pumpkin", "is_powered", "suffocating", "remaining_anger_time", "health", "special_type", "owneruuid", "painting_variant", "item", "rotation"];
function looksOf(bot, e) {
  const def = bot.registry.entitiesByName[e.name]; if (!def || !def.metadataKeys || !e.metadata) return 0;
  const out = {}; let any = false;
  for (const k of LOOKS) {
    const i = def.metadataKeys.indexOf(k); if (i < 0) continue;
    let v = e.metadata[i]; if (v === undefined || v === null) continue;
    if (typeof v === "bigint") v = Number(v);
    if (k === "owneruuid") { out.tame = 1; any = true; continue; }
    if (k === "health") v = Math.round(v);
    if (k === "item") { const it = v && (v.itemId !== undefined ? bot.registry.items[v.itemId] : v.name ? v : null); if (it && it.name) { out.item = it.name; any = true; } continue; }
    if (typeof v === "object") { if (k !== "villager_data") continue; v = [v.villagerType ?? v.type ?? 0, v.villagerProfession ?? v.profession ?? 0, v.level ?? 1]; }
    out[k] = v; any = true;
  }
  return any ? out : 0;
}
/* Armour as worn: helmet, chestplate, leggings, boots (name, and a leather colour when dyed). */
function armourOf(e) {
  const eq = e.equipment || []; let any = false;
  const out = [5, 4, 3, 2].map(i => {
    const it = eq[i]; if (!it || !it.name) return "";
    any = true; return itemSpec(it);
  });
  return any ? out : 0;
}
function sneaking(e) { const m = e.metadata || []; return m[6] === 5 || m[6] === "crouching"; }
function invisible(e) { const m = e.metadata || []; return typeof m[0] === "number" && (m[0] & 0x20) !== 0; }
function customName(e) {
  const m = e.metadata || [];
  const n = m[2];
  if (!n) return "";
  try { return plainText(typeof n === "string" ? n : (n.value || n)); } catch (x) { return ""; }
}
function teamOf(bot, name) {
  for (const [key, team] of Object.entries(bot.teams || {})) {
    if (team.members && team.members.includes(name)) return key.startsWith("pisan_red") ? 0 : key.startsWith("pisan_blue") ? 1 : -1;
  }
  return -1;
}

function itemJson(item) {
  if (!item) return {};
  const o = { m: item.name };
  if (item.count > 1) o.n = item.count;
  try { if (item.customName) o.name = legacyOf(item.customName); } catch (e) { }
  try { if (item.customLore) o.lore = [].concat(item.customLore).map(legacyOf); } catch (e) { }
  try { if (item.enchants && item.enchants.length) o.glow = true; } catch (e) { }
  const nbt = item.nbt && item.nbt.value;
  const owner = nbt && nbt.SkullOwner;
  if (owner) o.skin = owner.type === "string" ? owner.value : (owner.value.Name && owner.value.Name.value) || "";
  try { const x = itemExtras(item); if (x.pt) o.pt = x.pt; if (x.bc !== undefined) o.bc = x.bc; if (x.h) o.h = x.h; if (x.c !== undefined) o.c = x.c; if (x.g) o.glow = true; } catch (e) { }
  return o;
}

/* JSON text component -> "§" coloured text (what the page understands). */
const COLOR = { black: "0", dark_blue: "1", dark_green: "2", dark_aqua: "3", dark_red: "4", dark_purple: "5", gold: "6", gray: "7", dark_gray: "8", blue: "9", green: "a", aqua: "b", red: "c", light_purple: "d", yellow: "e", white: "f" };
function legacyOf(json) {
  let c; try { c = typeof json === "string" ? (json.trim().startsWith("{") || json.trim().startsWith("[") || json.trim().startsWith('"') ? JSON.parse(json) : json) : json; } catch (e) { return String(json); }
  const walk = (n, inherited) => {
    if (n == null) return "";
    if (typeof n === "string") return n;
    if (Array.isArray(n)) return n.map(x => walk(x, inherited)).join("");
    if (n.type === "compound" || n.value !== undefined && typeof n.value === "object") return walk(simplifyNbt(n), inherited);
    const col = n.color && COLOR[n.color] ? "§" + COLOR[n.color] : inherited;
    let out = (col || "") + (n.bold ? "§l" : "") + (n.text !== undefined ? n.text : (n[""] || ""));
    if (n.translate) out += n.translate;
    if (n.extra) out += n.extra.map(x => walk(x, col)).join("");
    return out;
  };
  return walk(c, "");
}
function simplifyNbt(n) { try { return require("prismarine-nbt").simplify(n); } catch (e) { return {}; } }
function plainText(json) { return legacyOf(json).replace(/§./g, "").replace(/\s+/g, " ").trim(); }

server.listen(PORT, () => log("Pisan Lig köprüsü " + PORT + " portunda açık. Varsayılan sunucu: " + HOME_SERVER));
