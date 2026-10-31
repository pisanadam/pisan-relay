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
    if (tex) { const url = JSON.parse(Buffer.from(tex.value, "base64").toString()).textures?.SKIN?.url; if (url) png = await getBuffer(url.replace("http://", "https://")); }
  }
  skins.set(k, png);
  return png;
}
const server = http.createServer(async (req, res) => {
  const url = decodeURIComponent((req.url || "/").split("?")[0]);
  const send = (code, type, body, cache) => { res.writeHead(code, { "Content-Type": type, "Cache-Control": cache || "no-cache" }); res.end(body); };
  if (url === "/" || url === "/oyna") return send(200, "text/html; charset=utf-8", fs.readFileSync(path.join(WEB, "game.html")));
  let m = url.match(/^\/tex\/((?:item\/)?[a-z0-9_]{1,64}\.png)$/);
  if (m) { const f = path.join(WEB, "tex", m[1]); return fs.existsSync(f) ? send(200, "image/png", fs.readFileSync(f), "max-age=86400") : send(404, "text/plain", "404"); }
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
    let target = String(o.server || "").trim().toLowerCase() || HOME_SERVER;
    if (!/^[a-z0-9.-]{1,253}(:\d{1,5})?$/.test(target)) return this.send({ t: "error", text: "Sunucu adresi geçersiz." });
    const [host, port] = target.includes(":") ? [target.split(":")[0], +target.split(":")[1]] : [target, 25565];
    this.host = host; this.port = port || 25565;
    this.home = host === HOME_SERVER;
    this.microsoft = o.auth === "microsoft" && !this.home;
    if (this.home) {
      if (!/^[A-Za-z0-9_]{3,9}$/.test(name)) return this.send({ t: "error", text: "Ad 3–9 karakter olmalı: harf, rakam ve _ (Pisan Lig'de başına (mobil) eklenir)." });
      this.name = "(mobil)" + name;
    } else {
      if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) return this.send({ t: "error", text: "Ad 3–16 karakter olmalı: harf, rakam ve _." });
      this.name = name;
    }
    this.skin = /^[A-Za-z0-9_]{1,16}$/.test(skin) ? skin : "";
    this.connect();
  }

  connect() {
    if (this.closed) return;
    this.connecting = true;
    this.everSpawned = false; this.lastKick = "";
    this.send({ t: "waking", text: (this.home ? "Pisan Lig" : this.host) + " sunucusuna bağlanılıyor…" });
    const options = { host: this.host, port: this.port, username: this.name, hideErrors: true, checkTimeoutInterval: 60000, version: this.home ? "1.20.1" : false };
    if (this.microsoft) {
      // Microsoft sign-in with a device code; the token lives only for this session.
      this.authDir = this.authDir || fs.mkdtempSync(path.join(os.tmpdir(), "pisan-msa-"));
      Object.assign(options, { auth: "microsoft", profilesFolder: this.authDir, onMsaCode: d => this.send({ t: "msa", code: d.user_code, url: d.verification_uri, text: d.message }) });
    } else options.auth = "offline";
    let bot;
    try { bot = this.bot = mineflayer.createBot(options); }
    catch (e) { this.connecting = false; return this.send({ t: "error", text: "Bağlanılamadı: " + e.message }); }
    bot.once("login", () => {
      if (!this.home) return;
      // Pisan Lig: prove this "(mobil)" player comes from the relay, and let the plugin send the extras.
      bot._client.write("custom_payload", { channel: "minecraft:register", data: Buffer.from("pisan:web") });
      bot._client.write("custom_payload", { channel: "pisan:web", data: Buffer.from(JSON.stringify({ key: KEY, skin: this.skin })) });
    });
    bot.once("spawn", () => {
      this.everSpawned = true; this.connecting = false;
      log("Girdi:", this.name, "→", this.host, bot.version);
      this.meId = (bot.player && bot.player.uuid || "me").slice(0, 8);
      this.Block = require("prismarine-block")(bot.registry);
      this.send({ t: "welcome", name: this.name, me: this.meId, server: this.home ? "Pisan Lig" : this.host, version: bot.version });
      this.timer = setInterval(() => this.tick(), 50);
      bot.world.on("blockUpdate", (old, now) => { if (this.regionAt && now && now.position.distanceTo(this.regionAt) < 45) this.dirty = true; });
      bot.on("chunkColumnLoad", () => { this.dirty = true; });
      bot.on("respawn", () => { this.regionAt = null; });
    });
    bot._client.on("custom_payload", p => {
      if (p.channel !== "pisan:web") return;
      try {
        const e = JSON.parse(p.data.toString());
        if (e.texts) this.send({ t: "texts", list: e.texts });
        if (e.disp) { this.disp = e.disp; this.regionAt = null; }
        this.extras = e;
      } catch (x) { }
    });
    bot.on("message", (msg, position) => { if (position !== "game_info") this.send({ t: "text", kind: "chat", json: JSON.stringify(msg.json) }); });
    bot.on("actionBar", msg => this.send({ t: "text", kind: "actionbar", json: JSON.stringify(msg.json) }));
    bot._client.on("set_title_text", p => this.send({ t: "text", kind: "title", json: typeof p.text === "string" ? p.text : JSON.stringify(p.text) }));
    bot._client.on("set_title_subtitle", p => this.send({ t: "text", kind: "subtitle", json: typeof p.text === "string" ? p.text : JSON.stringify(p.text) }));
    bot.on("windowOpen", w => this.menu(w));
    bot.on("windowClose", () => this.send({ t: "menuclose" }));
    bot.on("death", () => this.send({ t: "text", kind: "title", json: JSON.stringify({ text: "Öldün!", color: "red" }) }));
    bot.on("kicked", reason => { this.lastKick = plainText(reason); log("Atıldı:", this.name, this.lastKick); });
    bot.on("error", e => { this.lastKick = this.lastKick || String(e.message || e); });
    bot.on("end", () => {
      clearInterval(this.timer); clearInterval(this.useTimer);
      this.bot = null; this.connecting = false;
      if (this.closed) return;
      if (this.everSpawned || this.microsoft || !this.home) {
        this.send({ t: "error", text: "Sunucudan ayrıldın: " + (this.lastKick || "bağlantı koptu") });
        return this.ws.close();
      }
      // Pisan Lig not up yet: this join attempt has asked exaroton to start it. Knock again shortly.
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
      case "in": {
        const f = +o.f || 0, s = +o.s || 0;
        bot.setControlState("forward", f > 0.3); bot.setControlState("back", f < -0.3);
        bot.setControlState("right", s > 0.3); bot.setControlState("left", s < -0.3);
        bot.setControlState("sprint", !!o.run && f > 0.3 && !o.sneak);
        bot.setControlState("sneak", !!o.sneak);
        if (o.jump) { bot.setControlState("jump", true); setTimeout(() => bot.setControlState("jump", false), 120); }
        if (Number.isFinite(+o.yaw) && Number.isFinite(+o.pitch)) bot.look(toYaw(+o.yaw), toPitch(Math.max(-90, Math.min(90, +o.pitch))), true);
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
      case "chat": if (typeof o.text === "string" && o.text.trim()) bot.chat(o.text.trim().slice(0, 250)); break;
    }
  }

  /* Clicks as a Minecraft client makes them: hit what you look at, dig, use and place blocks, use items. */
  act(a, adventure) {
    const bot = this.bot;
    const held = bot.heldItem;
    if (a === "ldown") {
      const entity = bot.entityAtCursor(3.5);
      if (entity) { bot.attack(entity); return; }
      const block = !adventure && bot.blockAtCursor(5);
      if (block && block.name !== "air" && bot.canDigBlock(block)) { bot.dig(block, "ignore").catch(() => { }); this.digging = true; return; }
      bot.swingArm("right");
    } else if (a === "lup") {
      if (this.digging) { this.digging = false; try { bot.stopDigging(); } catch (e) { } }
    } else if (a === "left") {
      this.act("ldown", adventure);
      setTimeout(() => this.act("lup", adventure), 60);
    } else if (a === "rdown") {
      const entity = bot.entityAtCursor(3.5);
      if (entity && entity.type !== "object") { bot.activateEntity(entity).catch(() => { }); return; }
      const block = bot.blockAtCursor(5);
      if (block && block.name !== "air" && !adventure) {
        if (INTERACTIVE.test(block.name) && !bot.getControlState("sneak")) { bot.activateBlock(block).catch(() => { }); return; }
        if (held && bot.registry.blocksByName[held.name] && block.face !== undefined) {
          const faces = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(0, 0, -1), new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(1, 0, 0)];
          bot.placeBlock(block, faces[block.face]).catch(() => { });
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

  /* 20 times a second: everyone nearby, the ball, our own position, health; the blocks when they change. */
  tick() {
    const bot = this.bot;
    if (!bot || !bot.entity) return;
    const camera = this.extras.cam;
    const view = camera ? new Vec3(camera[0], camera[1], camera[2]) : bot.entity.position;
    if (!this.regionAt || this.regionAt.distanceTo(view) > 26 || (this.dirty && Date.now() - (this.regionSent || 0) > 1000)) { this.regionAt = view.clone(); this.dirty = false; this.regionSent = Date.now(); this.region(view); }
    const people = [];
    for (const e of Object.values(bot.entities)) {
      if (!e.position || e.position.distanceTo(view) > 80) continue;
      const isMe = e === bot.entity;
      if (e.type === "player") {
        const info = Object.values(bot.players).find(p => p.uuid === e.uuid);
        const name = isMe ? this.name : (e.username || (info && info.username) || "");
        if (info && info.gamemode === 3 && !isMe) continue;
        people.push([isMe ? this.meId : (e.uuid || "").slice(0, 8), name, teamOf(bot, name), r2(e.position.x), r2(e.position.y), r2(e.position.z), Math.round(fromYaw(e.yaw)), Math.round(fromPitch(e.pitch)), sneaking(e) ? 1 : 0, name.startsWith("(mobil)") ? "" : name, "p"]);
      } else if (e.name === "armor_stand") {
        if (invisible(e)) continue;
        people.push(["a" + e.id.toString(16), customName(e), -1, r2(e.position.x), r2(e.position.y), r2(e.position.z), Math.round(fromYaw(e.yaw)), 0, 0, "", "a"]);
      } else if (e.name === "item") {
        const item = e.getDroppedItem && e.getDroppedItem();
        people.push(["i" + e.id.toString(16), item ? item.name : "stone", -1, r2(e.position.x), r2(e.position.y), r2(e.position.z), 0, 0, 0, "", "i"]);
      } else if (["mob", "hostile", "animal", "passive", "water_creature", "ambient"].includes(e.type) || (e.type === "other" && e.height > 0.2 && !/display|marker|interaction|area_effect/.test(e.name || ""))) {
        if (invisible(e)) continue;
        people.push(["m" + e.id.toString(16), e.name || "mob", -1, r2(e.position.x), r2(e.position.y), r2(e.position.z), Math.round(fromYaw(e.yaw)), Math.round(fromPitch(e.pitch)), 0, customName(e), "m", r2(e.width || 0.6), r2(e.height || 1.8)]);
      }
    }
    const x = this.extras;
    const o = { t: "s", p: people, me: [+bot.entity.position.x.toFixed(3), +bot.entity.position.y.toFixed(3), +bot.entity.position.z.toFixed(3)], hp: Math.round(bot.health || 0), food: Math.round(bot.food || 0), gm: bot.game && bot.game.gameMode };
    if (x.b) { o.b = x.b; o.r = x.r; o.bl = x.bl; o.c = x.c; o.ph = x.ph; o.pause = x.pause; }
    if (camera) o.cam = camera;
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
    this.send({ t: "menu", title: plainText(w.title), size, items, own, ownStart: size });
  }

  inventory() {
    const bot = this.bot;
    const own = [];
    for (let i = 9; i < 45; i++) own.push(itemJson(bot.inventory.slots[i]));
    const armor = [5, 6, 7, 8, 45].map(i => itemJson(bot.inventory.slots[i]));
    this.send({ t: "menu", title: "Envanter", size: 0, items: [], own, ownStart: 9, inv: true, armor });
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
  region(c) {
    const bot = this.bot, r = 40;
    const bx = Math.floor(c.x), bz = Math.floor(c.z), y0 = Math.floor(c.y) - 8, y1 = y0 + 24;
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
          else { id = palette.length; const s = this.shapeOf(sid); palette.push(s === null ? { n: name.toUpperCase() } : { n: name.toUpperCase(), s }); }
          index.set(sid, id);
        }
      }
      if (id === last) count++; else { if (count > 0) runs.push(count === 1 ? String(last) : last + "*" + count); last = id; count = 1; }
    }
    runs.push(count === 1 ? String(last) : last + "*" + count);
    this.send({ t: "world", x0: bx - r, y0, z0: bz - r, nx: 2 * r + 1, ny: y1 - y0, nz: 2 * r + 1, pal: palette, runs: runs.join(","), disp: this.home ? (this.disp || []) : [] });
  }
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
