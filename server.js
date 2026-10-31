// Pisan Lig köprüsü: tarayıcı oyuncularını gerçek bir Minecraft istemcisiyle (mineflayer) sunucuya bağlar.
//
//   node server.js <port> <anahtar> [sunucu:port]
//
// Her tarayıcı için bir Minecraft 1.20.1 bağlantısı açılır ve yalnızca Pisan Lig sunucusuna (pisan-sf-league.exaroton.me)
// gidilir. Sunucu kapalıysa bu bağlantı exaroton'un "oyuncu girince başlat" özelliğini tetikler; açılınca oyuncu içeri girer.
// Tarayıcıya dünyanın blokları, çevredeki varlıklar, envanter, menüler ve sohbet gönderilir; tarayıcıdan gelen
// hareket ve tıklamalar Minecraft istemcisinin yapacağı gibi sunucuya iletilir.
"use strict";
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const mineflayer = require("mineflayer");
const { Vec3 } = require("vec3");

const PORT = +(process.argv[2] || process.env.PORT || readProperty("server-port") || 25565);
const KEY = (process.argv[3] || process.env.RELAY_KEY || readFile("pisan-relay-key.txt") || "").trim();
const TARGET = (process.argv[4] || process.env.MC_SERVER || "pisan-sf-league.exaroton.me").trim();
const [MC_HOST, MC_PORT] = TARGET.includes(":") ? [TARGET.split(":")[0], +TARGET.split(":")[1]] : [TARGET, 25565];
const VERSION = "1.20.1";
const WEB = path.join(__dirname, "web");
const MAX_PLAYERS = 40;

if (KEY.length < 8) {
  console.error("Anahtar yok: node server.js <port> <anahtar>  (ya da yanına pisan-relay-key.txt koy)");
  process.exit(1);
}
function readFile(f) { try { return fs.readFileSync(path.join(__dirname, f), "utf8"); } catch (e) { return ""; } }
function readProperty(name) { const m = readFile("server.properties").match(new RegExp("^" + name + "=(.*)$", "m")); return m ? m[1].trim() : ""; }
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

// ---------- one browser player ----------
const sessions = new Set();
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 16 * 1024 });
wss.on("connection", ws => {
  if (sessions.size >= MAX_PLAYERS) { ws.send(JSON.stringify({ t: "error", text: "Sunucu dolu, biraz sonra dene." })); return ws.close(); }
  const s = new Session(ws);
  sessions.add(s);
  ws.on("message", data => { try { s.onMessage(JSON.parse(data.toString())); } catch (e) { } });
  ws.on("close", () => { sessions.delete(s); s.stop(); });
});

const toYaw = deg => Math.PI - deg * Math.PI / 180;           // Minecraft degrees -> mineflayer radians
const toPitch = deg => -deg * Math.PI / 180;
const fromYaw = rad => ((180 - rad * 180 / Math.PI) % 360 + 540) % 360 - 180;
const fromPitch = rad => -rad * 180 / Math.PI;
const r2 = v => Math.round(v * 100) / 100;

class Session {
  constructor(ws) { this.ws = ws; this.bot = null; this.closed = false; this.extras = {}; this.regionAt = null; this.lastHotbar = ""; this.useTimer = null; }
  send(o) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); }

  onMessage(o) {
    if (o.t === "hello") return this.hello(o);
    const bot = this.bot;
    if (!bot || !bot.entity) return;
    switch (o.t) {
      case "in": {
        const f = +o.f || 0, s = +o.s || 0;
        bot.setControlState("forward", f > 0.3); bot.setControlState("back", f < -0.3);
        bot.setControlState("right", s > 0.3); bot.setControlState("left", s < -0.3);
        bot.setControlState("sprint", !!o.run && f > 0.3 && !o.sneak);
        bot.setControlState("sneak", !!o.sneak);
        bot.setControlState("jump", !!o.jump);
        if (o.jump) setTimeout(() => bot.setControlState("jump", false), 120);
        if (Number.isFinite(+o.yaw) && Number.isFinite(+o.pitch)) bot.look(toYaw(+o.yaw), toPitch(Math.max(-90, Math.min(90, +o.pitch))), true);
        break;
      }
      case "act": {
        const bow = bot.heldItem && bot.heldItem.name === "bow";
        if (o.a === "rdown") {
          // Holding right click: a Minecraft client repeats "use" every 4 ticks; a bow is drawn and held.
          if (bow) bot.activateItem();
          else { bot.activateItem(); clearInterval(this.useTimer); this.useTimer = setInterval(() => { try { bot.activateItem(); } catch (e) { } }, 200); }
        } else if (o.a === "rup") {
          clearInterval(this.useTimer); this.useTimer = null;
          if (bow) bot.deactivateItem();
        } else if (o.a === "left") bot.swingArm("right");
        break;
      }
      case "slot": if (o.i >= 0 && o.i < 9) bot.setQuickBarSlot(o.i); break;
      case "click": if (bot.currentWindow && o.slot >= 0) bot.clickWindow(o.slot, o.right ? 1 : 0, 0).catch(() => { }); break;
      case "close": if (bot.currentWindow) bot.closeWindow(bot.currentWindow); break;
      case "chat": if (typeof o.text === "string" && o.text.trim()) bot.chat(o.text.trim().slice(0, 200)); break;
    }
  }

  hello(o) {
    const name = String(o.name || "").trim(), skin = String(o.skin || "").trim();
    if (!/^[A-Za-z0-9_]{3,9}$/.test(name)) return this.send({ t: "error", text: "Ad 3–9 karakter olmalı: harf, rakam ve _ (oyunda başına (mobil) eklenir)." });
    if (this.bot) return;
    this.name = "(mobil)" + name; this.skin = /^[A-Za-z0-9_]{1,16}$/.test(skin) ? skin : "";
    this.connect();
  }

  connect() {
    if (this.closed) return;
    this.send({ t: "waking", text: "Sunucuya bağlanılıyor…" });
    const bot = this.bot = mineflayer.createBot({ host: MC_HOST, port: MC_PORT, username: this.name, version: VERSION, auth: "offline", hideErrors: true, checkTimeoutInterval: 60000 });
    bot.once("login", () => {
      // Prove to the plugin that this "(mobil)" player comes from the relay, and let it send us the extras.
      bot._client.write("custom_payload", { channel: "minecraft:register", data: Buffer.from("pisan:web") });
      bot._client.write("custom_payload", { channel: "pisan:web", data: Buffer.from(JSON.stringify({ key: KEY, skin: this.skin })) });
    });
    bot.once("spawn", () => {
      log("Girdi:", this.name);
      this.meId = (bot.player && bot.player.uuid || "me").slice(0, 8);
      this.send({ t: "welcome", name: this.name, me: this.meId });
      this.timer = setInterval(() => this.tick(), 50);
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
    bot._client.on("set_title_text", p => this.send({ t: "text", kind: "title", json: p.text }));
    bot._client.on("set_title_subtitle", p => this.send({ t: "text", kind: "subtitle", json: p.text }));
    bot._client.on("system_chat", p => { if (p.isActionBar) this.send({ t: "text", kind: "actionbar", json: p.content }); });
    bot.on("windowOpen", w => this.menu(w));
    bot.on("windowClose", () => this.send({ t: "menuclose" }));
    bot.on("kicked", reason => {
      const text = plainText(reason);
      log("Atıldı:", this.name, text);
      this.lastKick = text;
    });
    bot.on("end", () => {
      clearInterval(this.timer); clearInterval(this.useTimer);
      if (this.closed) return;
      const starting = /start|başla|wait|bekle|queue|sıra/i.test(this.lastKick || "") || !this.everSpawned;
      if (bot.entity && this.everSpawned) { this.send({ t: "error", text: "Sunucudan ayrıldın: " + (this.lastKick || "bağlantı koptu") }); this.ws.close(); return; }
      // Not in yet: exaroton is starting the server (that is what this join attempt asked for). Try again shortly.
      this.send({ t: "waking", text: this.lastKick || "Sunucu başlatılıyor…" });
      this.bot = null;
      this.retry = setTimeout(() => this.connect(), starting ? 8000 : 15000);
    });
    bot.on("error", e => { this.lastKick = this.lastKick || String(e.message || e); });
    bot.once("spawn", () => { this.everSpawned = true; });
  }

  stop() {
    this.closed = true;
    clearInterval(this.timer); clearInterval(this.useTimer); clearTimeout(this.retry);
    if (this.bot) { try { this.bot.quit(); } catch (e) { } }
  }

  /* 20 times a second: where everyone is, the ball, our own position; the blocks when we move far. */
  tick() {
    const bot = this.bot;
    if (!bot || !bot.entity) return;
    const camera = this.extras.cam;
    const view = camera ? new Vec3(camera[0], camera[1], camera[2]) : bot.entity.position;
    if (!this.regionAt || this.regionAt.distanceTo(view) > 26) { this.regionAt = view.clone(); this.region(view); }
    const people = [];
    for (const e of Object.values(bot.entities)) {
      if (!e.position || e.position.distanceTo(view) > 80) continue;
      if (e.type === "player") {
        const info = Object.values(bot.players).find(p => p.uuid === e.uuid);
        const name = e.username || (info && info.username) || "";
        const isMe = e === bot.entity;
        const gm = info && info.gamemode;
        if (gm === 3 && !isMe) continue;
        people.push([isMe ? this.meId : (e.uuid || "").slice(0, 8), isMe ? this.name : name, teamOf(bot, name), r2(e.position.x), r2(e.position.y), r2(e.position.z), Math.round(fromYaw(e.yaw)), Math.round(fromPitch(e.pitch)), e.metadata && e.metadata[6] === 5 ? 1 : 0, name.startsWith("(mobil)") ? "" : name]);
      } else if (e.name === "armor_stand") {
        const flags = e.metadata && e.metadata[0];
        if (flags & 0x20) continue; // invisible (cameras, markers)
        people.push(["a" + e.id.toString(16), "", -1, r2(e.position.x), r2(e.position.y), r2(e.position.z), Math.round(fromYaw(e.yaw)), 0, 0, ""]);
      }
    }
    const x = this.extras;
    const o = { t: "s", p: people, me: [+bot.entity.position.x.toFixed(3), +bot.entity.position.y.toFixed(3), +bot.entity.position.z.toFixed(3)] };
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
    this.send({ t: "menu", title: plainText(w.title), size, items });
  }

  /* The blocks in an 81x81x22 area around the view, palette + run-length, like the plugin used to send. */
  region(c) {
    const bot = this.bot, r = 40;
    const bx = Math.floor(c.x), bz = Math.floor(c.z), y0 = Math.floor(c.y) - 6, y1 = y0 + 22;
    const palette = ["AIR"], index = new Map([["air", 0]]);
    const runs = []; let last = -1, count = 0;
    const p = new Vec3(0, 0, 0);
    for (let y = y0; y < y1; y++) for (let z = bz - r; z <= bz + r; z++) for (let x = bx - r; x <= bx + r; x++) {
      p.x = x; p.y = y; p.z = z;
      const sid = bot.world.getBlockStateId(p);
      const block = sid == null ? null : bot.registry.blocksByStateId[sid];
      const name = block ? block.name : "air";
      let id = index.get(name);
      if (id === undefined) { id = palette.length; palette.push(name === "cave_air" || name === "void_air" ? "AIR" : name.toUpperCase()); index.set(name, id); }
      if (id === last) count++; else { if (count > 0) runs.push(count === 1 ? String(last) : last + "*" + count); last = id; count = 1; }
    }
    runs.push(count === 1 ? String(last) : last + "*" + count);
    this.send({ t: "world", x0: bx - r, y0, z0: bz - r, nx: 2 * r + 1, ny: y1 - y0, nz: 2 * r + 1, pal: palette, runs: runs.join(","), disp: this.disp || [] });
  }
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
  const nbt = item.nbt && item.nbt.value;
  const display = nbt && nbt.display && nbt.display.value;
  if (display && display.Name) o.name = legacyOf(display.Name.value);
  if (display && display.Lore) o.lore = (display.Lore.value.value || []).map(legacyOf);
  if (nbt && (nbt.Enchantments || nbt.StoredEnchantments)) o.glow = true;
  const owner = nbt && nbt.SkullOwner;
  if (owner) o.skin = owner.type === "string" ? owner.value : (owner.value.Name && owner.value.Name.value) || "";
  return o;
}

/* JSON text component -> "§" coloured text (what the page already understands). */
const COLOR = { black: "0", dark_blue: "1", dark_green: "2", dark_aqua: "3", dark_red: "4", dark_purple: "5", gold: "6", gray: "7", dark_gray: "8", blue: "9", green: "a", aqua: "b", red: "c", light_purple: "d", yellow: "e", white: "f" };
function legacyOf(json) {
  let c; try { c = typeof json === "string" ? JSON.parse(json) : json; } catch (e) { return String(json); }
  const walk = (n, inherited) => {
    if (n == null) return "";
    if (typeof n === "string") return n;
    if (Array.isArray(n)) return n.map(x => walk(x, inherited)).join("");
    const col = n.color && COLOR[n.color] ? "§" + COLOR[n.color] : inherited;
    let out = (col || "") + (n.bold ? "§l" : "") + (n.text || "");
    if (n.extra) out += n.extra.map(x => walk(x, col)).join("");
    return out;
  };
  return walk(c, "");
}
function plainText(json) { return legacyOf(json).replace(/§./g, "").replace(/\s+/g, " ").trim(); }

server.listen(PORT, () => log("Pisan Lig köprüsü " + PORT + " portunda açık. Hedef sunucu: " + MC_HOST + ":" + MC_PORT));
