// ============================================================
//  HALO Studio — credits backend (Railway)
//  Node 18+ · Express · better-sqlite3
//
//  Хранит баланс кредитов по каждому пользователю, проверяет
//  подпись Telegram WebApp (initData), даёт владельцу безлимит,
//  и принимает серверное начисление наград от AdsGram (Reward URL).
//
//  ENV (Railway → Variables):
//    BOT_TOKEN        — токен бота Mini App (обязательно; тот же, что генерит initData)
//    OWNER_ID         — Telegram ID владельца (по умолчанию 976860643) → безлимит
//    ADSGRAM_SECRET   — свой секрет, который добавишь в Reward URL (?key=...) — защита эндпоинта
//    START_CREDITS    — стартовый баланс (по умолчанию 8)
//    AD_REWARD        — начисление за просмотр рекламы (по умолчанию 5)
//    DB_PATH          — путь к SQLite (по умолчанию /data/halo.db — Railway Volume)
//    PORT             — Railway задаёт сам
// ============================================================

import express from "express";
import crypto from "crypto";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BOT_TOKEN      = process.env.BOT_TOKEN || "";
const OWNER_ID       = Number(process.env.OWNER_ID || 976860643);
// Белый список безлимитных «своих» (жена/сын/партнёр): OWNER_IDS=976860643,111,222
const OWNER_SET      = new Set(String(process.env.OWNER_IDS || process.env.OWNER_ID || 976860643).split(",").map(s => Number(s.trim())).filter(Boolean));
OWNER_SET.add(OWNER_ID);
function isOwnerId(id){ return OWNER_SET.has(Number(id)); }
const ADSGRAM_SECRET = process.env.ADSGRAM_SECRET || "";
const START_CREDITS  = Number(process.env.START_CREDITS || 8);
const AD_REWARD      = Number(process.env.AD_REWARD || 5);
const DB_PATH        = process.env.DB_PATH || "/data/halo.db";
const PORT           = process.env.PORT || 3000;

// --- Бонусы, рефералы, PRO ---
const BONUS_CREDITS  = Number(process.env.BONUS_CREDITS || 5);   // дневной бонус
const REF_BONUS      = Number(process.env.REF_BONUS || 20);      // приглашающему за друга
const REF_BONUS_NEW  = Number(process.env.REF_BONUS_NEW || 10);  // новичку по приглашению
const PRO_DAYS       = Number(process.env.PRO_DAYS || 30);       // длительность PRO за одну покупку
const PRO_STARS      = Number(process.env.PRO_STARS || 250);     // цена PRO в Telegram Stars
const GROQ_API_KEY   = process.env.GROQ_API_KEY || "";           // ключ Groq для улучшения промптов
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";         // ключ Google Gemini (основной, с фолбэком на Groq)
const ADMIN_KEY      = process.env.ADMIN_KEY || "";              // ключ для доступа к /admin (задай свой)
const APP_URL        = process.env.APP_URL || "https://halo-backend-production-44c1.up.railway.app/app"; // ссылка Mini App для кнопки /start
// Дорогие модели — только владельцу/«своим» (чтобы чужие не сожгли баланс Replicate)
const PREMIUM_MODELS = new Set(String(process.env.PREMIUM_MODELS || "veo3,seedance2,luma").split(",").map(s => s.trim()).filter(Boolean));
// Полностью скрытые модели (для всех, включая владельца). Очисти переменную в Railway, чтобы вернуть.
const DISABLED_MODELS = new Set(String(process.env.DISABLED_MODELS || "veo3,seedance2,luma").split(",").map(s => s.trim()).filter(Boolean));

// --- Видео-API (генеративное видео) ---
const REPLICATE_TOKEN = process.env.REPLICATE_TOKEN || "";        // ключ Replicate (r8_...)
const VIDEO_COST      = Number(process.env.VIDEO_COST || 10);     // сколько кредитов стоит 1 AI-видео
const VIDEO_DURATION  = Number(process.env.VIDEO_DURATION || 5);  // 5 или 10 сек (для Kling/Seedance)

// Три модели, сверенные по страницам Replicate (schema подтверждена).
// Каждая знает свой точный набор полей input.
const VIDEO_MODELS = {
  // Kling 2.1 Master — text/image-to-video, поле картинки: start_image
  kling: {
    slug: "kwaivgi/kling-v2.1-master", imgField: "start_image",
    cost: Number(process.env.COST_KLING || 10),
    build: (prompt, o) => ({ prompt, duration: pick(o.duration, [5, 10], 5), aspect_ratio: o.aspect })
  },
  // Veo 3.1 — поле картинки: image
  veo3: {
    slug: "google/veo-3.1", imgField: "image",
    cost: Number(process.env.COST_VEO || 15),
    build: (prompt, o) => {
      const dur = pick(o.duration, [4, 6, 8], 8);
      return {
        prompt,
        duration: dur,
        aspect_ratio: o.aspect === "9:16" ? "9:16" : "16:9",
        resolution: dur === 8 ? "1080p" : "720p",
        generate_audio: o.audio
      };
    }
  },
  // Seedance 1.0 Pro — поле картинки: image
  seedance: {
    slug: "bytedance/seedance-1-pro", imgField: "image",
    cost: Number(process.env.COST_SEEDANCE || 10),
    build: (prompt, o) => ({ prompt, duration: pick(o.duration, [5, 10], 5), aspect_ratio: o.aspect, resolution: "1080p", fps: 24 })
  },
  // Seedance 2.0 — мультимодальный: первый кадр (image), последний (last_frame_image), референсы (reference_images), звук
  seedance2: {
    slug: "bytedance/seedance-2.0", imgField: "image", audio: true,
    cost: Number(process.env.COST_SEEDANCE2 || 15),
    build: (prompt, o) => ({ prompt, duration: pick(o.duration, [5, 10], 5), aspect_ratio: o.aspect, resolution: "720p", generate_audio: o.audio })
  },
  // Hailuo (Minimax) — оживление фото, поле картинки: first_frame_image. Дёшево, 6/10 сек.
  hailuo: {
    slug: "minimax/hailuo-02", imgField: "first_frame_image",
    cost: Number(process.env.COST_HAILUO || 8),
    build: (prompt, o) => ({ prompt, duration: pick(o.duration, [6, 10], 6) })
  },
  // Luma Ray — плавное движение, поле картинки: start_image_url. Фото/текст, 5/10 сек.
  luma: {
    slug: "luma/ray-flash-2-720p", imgField: "start_image_url",
    cost: Number(process.env.COST_LUMA || 12),
    build: (prompt, o) => ({ prompt, duration: pick(o.duration, [5, 10], 5) })
  }
};
function pick(val, allowed, def){ return allowed.includes(Number(val)) ? Number(val) : def; }
function videoModel(modelKey){ return VIDEO_MODELS[modelKey] || VIDEO_MODELS.kling; }
function videoCost(modelKey){ return videoModel(modelKey).cost; }
function buildVideoInput(modelKey, prompt, opts){
  const m = videoModel(modelKey);
  const aspect = ["16:9", "9:16", "1:1"].includes(opts.aspect) ? opts.aspect : "16:9";
  const audio  = opts.audio !== false;
  const input = m.build(prompt, { duration: opts.duration, aspect, audio });
  const imgs = Array.isArray(opts.images) ? opts.images.filter(Boolean) : [];
  if (imgs.length && m.imgField) {
    input[m.imgField] = imgs[0]; // первый кадр — у всех моделей
    if (modelKey === "seedance2") { // расширенные режимы — только Seedance 2.0
      if (opts.photoMode === "firstlast" && imgs[1]) input.last_frame_image = imgs[1];
      if (opts.photoMode === "refs" && imgs.length > 1) input.reference_images = imgs;
    }
  }
  return { slug: m.slug, input };
}

if (!BOT_TOKEN) console.warn("WARN: BOT_TOKEN не задан — проверка подписи Telegram работать не будет.");

// ---------- DB ----------
const db = new Database(DB_PATH);
db.exec(`CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY,
  credits INTEGER NOT NULL DEFAULT ${START_CREDITS},
  updated INTEGER
)`);
// Доп. колонки (безопасно добавляем для уже существующих БД)
for (const col of ["pro_until INTEGER DEFAULT 0", "last_bonus TEXT", "ref_by INTEGER DEFAULT 0", "referrals INTEGER DEFAULT 0", "paid_credits INTEGER DEFAULT 0"]) {
  try { db.exec(`ALTER TABLE users ADD COLUMN ${col}`); } catch (e) { /* уже есть */ }
}
const qGet  = db.prepare("SELECT * FROM users WHERE id=?");
const qIns  = db.prepare("INSERT OR IGNORE INTO users(id,credits,updated) VALUES(?,?,?)");
const qSet  = db.prepare("UPDATE users SET credits=?, updated=? WHERE id=?");
const qPro  = db.prepare("UPDATE users SET pro_until=? WHERE id=?");
const qBon  = db.prepare("UPDATE users SET last_bonus=? WHERE id=?");
const qRef  = db.prepare("UPDATE users SET ref_by=? WHERE id=?");
const qRefN = db.prepare("UPDATE users SET referrals=referrals+1 WHERE id=?");

function row(id){ qIns.run(id, START_CREDITS, Date.now()); return qGet.get(id); }
function balance(id){ return row(id).credits; }                 // «бесплатные» кредиты (реклама/бонус/рефералы)
function setBal(id, c){ qSet.run(c, Date.now(), id); return c; }
function addCredits(id, n){ return setBal(id, balance(id) + n); }
function subCredits(id, n){ return setBal(id, Math.max(0, balance(id) - n)); }

// «Купленные» кредиты (только за Telegram Stars) — на них покупается AI-видео
const qSetPaid = db.prepare("UPDATE users SET paid_credits=? WHERE id=?");
function paidBal(id){ return row(id).paid_credits || 0; }
function setPaid(id, c){ qSetPaid.run(Math.max(0, c), id); return Math.max(0, c); }
function addPaid(id, n){ return setPaid(id, paidBal(id) + n); }

// Картинки/слайд-шоу: списываем сперва бесплатные, потом купленные
function spendAny(id, n){
  const f = balance(id), p = paidBal(id);
  if (f + p < n) return { ok: false, free: f, paid: p };
  const useF = Math.min(f, n), useP = n - useF;
  if (useF) setBal(id, f - useF);
  if (useP) setPaid(id, p - useP);
  return { ok: true, free: balance(id), paid: paidBal(id) };
}
// AI-видео: только купленные кредиты
function spendPaid(id, n){
  const p = paidBal(id);
  if (p < n) return { ok: false, paid: p };
  setPaid(id, p - n);
  return { ok: true, paid: paidBal(id) };
}

// PRO
function isProUser(id){ if (isOwnerId(id)) return true; const r = row(id); return (r.pro_until || 0) > Date.now(); }
function grantProDays(id, days){ const base = Math.max(Date.now(), row(id).pro_until || 0); const until = base + days * 86400000; qPro.run(until, id); return until; }

// Дневной бонус
function todayStr(){ return new Date().toISOString().slice(0, 10); }
function claimBonus(id){ const r = row(id); if (r.last_bonus === todayStr()) return { ok: false, credits: r.credits }; qBon.run(todayStr(), id); const credits = addCredits(id, BONUS_CREDITS); return { ok: true, credits }; }
function bonusAvailable(id){ return row(id).last_bonus !== todayStr(); }

// Рефералы: засчитываем один раз для нового пользователя
function applyReferral(newId, refId){
  if (!refId || refId === newId) return false;
  const r = row(newId);
  if (r.ref_by) return false;           // уже приглашён
  row(refId);                            // убедимся, что реферер есть
  qRef.run(refId, newId);
  addCredits(newId, REF_BONUS_NEW);      // бонус новичку
  addCredits(refId, REF_BONUS);          // бонус пригласившему
  qRefN.run(refId);
  return true;
}

// ---------- Статистика (для админ-панели) ----------
db.exec(`CREATE TABLE IF NOT EXISTS counters(name TEXT PRIMARY KEY, val INTEGER NOT NULL DEFAULT 0)`);
db.exec(`CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY AUTOINCREMENT, uid INTEGER, kind TEXT, stars INTEGER, ts INTEGER)`);
const qIncC   = db.prepare("INSERT INTO counters(name,val) VALUES(?,?) ON CONFLICT(name) DO UPDATE SET val=val+excluded.val");
const qGetC   = db.prepare("SELECT val FROM counters WHERE name=?");
const qPayIns = db.prepare("INSERT INTO payments(uid,kind,stars,ts) VALUES(?,?,?,?)");
function incCounter(name, by = 1){ qIncC.run(name, by); }
function getCounter(name){ const r = qGetC.get(name); return r ? r.val : 0; }
function logPayment(uid, kind, stars){ qPayIns.run(uid, kind, stars, Date.now()); }

// ---------- Telegram WebApp initData validation ----------
// secret_key = HMAC_SHA256(key="WebAppData", data=BOT_TOKEN)
// hash       = HMAC_SHA256(key=secret_key, data=data_check_string) в hex
function verifyInitData(initData){
  if (!initData || !BOT_TOKEN) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const dcs = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const calc = crypto.createHmac("sha256", secret).update(dcs).digest("hex");
  if (calc !== hash) return null;
  // (опционально) свежесть: auth_date не старше суток
  const authDate = Number(params.get("auth_date") || 0);
  if (authDate && (Date.now() / 1000 - authDate) > 86400) return null;
  try { return JSON.parse(params.get("user")); } catch { return null; }
}

// ---------- App ----------
const app = express();
app.use(express.json({ limit: "8mb" })); // до 8МБ — для загрузки фото (image-to-video)
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  res.set("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

function auth(req, res){
  const user = verifyInitData(req.body && req.body.initData);
  if (!user){ res.status(401).json({ error: "bad initData" }); return null; }
  return user;
}

// Текущий баланс + статус PRO/бонус (владельцу — null = безлимит)
app.post("/api/credits", (req, res) => {
  const u = auth(req, res); if (!u) return;
  const r = row(u.id);
  res.json({
    owner: isOwnerId(u.id),
    free: isOwnerId(u.id) ? null : r.credits,
    paid: isOwnerId(u.id) ? null : (r.paid_credits || 0),
    pro: isProUser(u.id),
    pro_until: r.pro_until || 0,
    bonus: bonusAvailable(u.id),
    referrals: r.referrals || 0,
    disabled: [...DISABLED_MODELS]
  });
});

// Списание за картинки/слайд-шоу (сперва бесплатные, потом купленные).
app.post("/api/spend", (req, res) => {
  const u = auth(req, res); if (!u) return;
  const amount = Math.max(1, Number(req.body.amount || 1));
  if (isOwnerId(u.id)) return res.json({ ok: true, owner: true, free: null, paid: null });
  const r = spendAny(u.id, amount);
  if (r.ok) incCounter("gen_media");
  res.json(r);
});

// AdsGram Reward URL (S2S). Настрой в кабинете AdsGram для блока 36520:
//   https://<твой-railway-домен>/api/adsgram/reward?userid={userid}&key=<ADSGRAM_SECRET>
// AdsGram дёргает этот URL только после ПОЛНОГО просмотра rewarded-рекламы
// (в debug-режиме запрос не шлётся). Клиент это подделать не может.
// ВАЖНО: точное имя макроса ({userid}) сверь в настройках блока AdsGram.
app.get("/api/adsgram/reward", (req, res) => {
  if (ADSGRAM_SECRET && req.query.key !== ADSGRAM_SECRET) return res.sendStatus(403);
  const id = Number(req.query.userid);
  if (!id) return res.sendStatus(400);
  if (!isOwnerId(id)) addCredits(id, AD_REWARD);
  res.sendStatus(200); // AdsGram ждёт 200 OK
});

// Отдаём само приложение с этого же сервера (Railway открывается без VPN)
app.get(["/app", "/studio"], (_req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/health", (_req, res) => res.type("text").send("HALO credits backend · OK"));

// ---------- Генеративное видео (Replicate) ----------
// Списывает VIDEO_COST кредитов (владельцу бесплатно), создаёт задачу у провайдера,
// клиент опрашивает статус до готовности. Ключ провайдера живёт только на сервере.
app.post("/api/video/generate", async (req, res) => {
  const u = auth(req, res); if (!u) return;
  const images = Array.isArray(req.body && req.body.images) ? req.body.images
               : ((req.body && req.body.image) ? [req.body.image] : []);
  let prompt = String((req.body && req.body.prompt) || "").slice(0, 1000).trim();
  if (!prompt && !images.length) return res.status(400).json({ ok: false, error: "no prompt" });
  if (!prompt && images.length) prompt = "cinematic subtle natural motion, smooth camera movement";
  if (!REPLICATE_TOKEN) return res.status(500).json({ ok: false, error: "video api not configured" });
  if (!isProUser(u.id)) return res.json({ ok: false, error: "pro_required" }); // AI-видео — только PRO
  if (DISABLED_MODELS.has(req.body.model)) return res.json({ ok: false, error: "model_disabled" }); // временно отключена
  if (PREMIUM_MODELS.has(req.body.model) && !isOwnerId(u.id)) return res.json({ ok: false, error: "premium_only" }); // дорогие модели — только владелец/свои

  const cost = videoCost(req.body.model); // цена зависит от модели (Veo дороже)
  // AI-видео — только за КУПЛЕННЫЕ кредиты (владельцу бесплатно)
  if (!isOwnerId(u.id)) {
    const r = spendPaid(u.id, cost);
    if (!r.ok) return res.json({ ok: false, error: "need_paid", paid: r.paid });
  }
  try {
    const { slug, input } = buildVideoInput(req.body.model, prompt, { aspect: req.body.aspect, duration: req.body.duration, audio: req.body.audio, images, photoMode: req.body.photoMode });
    const r = await fetch(`https://api.replicate.com/v1/models/${slug}/predictions`, {
      method: "POST",
      headers: { "Authorization": "Bearer " + REPLICATE_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ input })
    });
    const d = await r.json();
    if (!r.ok || !d.id) { if (!isOwnerId(u.id)) addPaid(u.id, cost); return res.status(502).json({ ok: false, error: "provider", detail: d.detail || null }); }
    incCounter("gen_video");
    res.json({ ok: true, id: d.id, status: d.status, paid: isOwnerId(u.id) ? null : paidBal(u.id) });
  } catch (e) {
    if (!isOwnerId(u.id)) addPaid(u.id, cost);
    res.status(500).json({ ok: false, error: "provider" });
  }
});

app.post("/api/video/status", async (req, res) => {
  const u = auth(req, res); if (!u) return;
  const id = String((req.body && req.body.id) || "");
  if (!id) return res.status(400).json({ status: "error" });
  try {
    const r = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
      headers: { "Authorization": "Bearer " + REPLICATE_TOKEN }
    });
    const d = await r.json();
    let url = null;
    if (d.status === "succeeded") url = Array.isArray(d.output) ? d.output[0] : d.output;
    res.json({ status: d.status, url });
  } catch (e) {
    res.status(500).json({ status: "error" });
  }
});

// Переделать фото (image-to-image через FLUX Kontext) — PRO, за купленные кредиты
app.post("/api/restyle", async (req, res) => {
  const u = auth(req, res); if (!u) return;
  if (!isProUser(u.id)) return res.json({ ok: false, error: "pro_required" });
  const image = req.body && req.body.image ? String(req.body.image) : null;
  const prompt = String((req.body && req.body.prompt) || "").slice(0, 600).trim();
  if (!image || !prompt) return res.status(400).json({ ok: false, error: "need image+prompt" });
  if (!REPLICATE_TOKEN) return res.status(500).json({ ok: false, error: "no api" });
  const cost = Number(process.env.COST_RESTYLE || 4);
  if (!isOwnerId(u.id)) { const r = spendPaid(u.id, cost); if (!r.ok) return res.json({ ok: false, error: "need_paid", paid: r.paid }); }
  // Kontext лучше слушается инструкции-команды: «преврати это фото в …, сохранив лицо»
  const editPrompt = `Transform this photo: ${prompt}. Keep the person's face and identity recognizable, change the clothing, background and lighting to match the description. Photorealistic, high detail.`;
  try {
    const rr = await fetch("https://api.replicate.com/v1/models/black-forest-labs/flux-kontext-pro/predictions", {
      method: "POST", headers: { "Authorization": "Bearer " + REPLICATE_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ input: { prompt: editPrompt, input_image: image, output_format: "jpg", safety_tolerance: 2 } })
    });
    const d = await rr.json();
    if (!rr.ok || !d.id) { if (!isOwnerId(u.id)) addPaid(u.id, cost); return res.status(502).json({ ok: false, error: "provider", detail: d.detail || null }); }
    incCounter("gen_media");
    res.json({ ok: true, id: d.id, status: d.status, paid: isOwnerId(u.id) ? null : paidBal(u.id) });
  } catch (e) { if (!isOwnerId(u.id)) addPaid(u.id, cost); res.status(500).json({ ok: false, error: "provider" }); }
});

// Апскейл / HD (Real-ESRGAN) — PRO, за купленные кредиты
app.post("/api/upscale", async (req, res) => {
  const u = auth(req, res); if (!u) return;
  if (!isProUser(u.id)) return res.json({ ok: false, error: "pro_required" });
  const image = req.body && req.body.image ? String(req.body.image) : null;
  const scale = [2, 4].includes(Number(req.body.scale)) ? Number(req.body.scale) : 2;
  if (!image) return res.status(400).json({ ok: false, error: "no image" });
  if (!REPLICATE_TOKEN) return res.status(500).json({ ok: false, error: "no api" });
  const cost = Number(process.env.COST_UPSCALE || 2) * (scale === 4 ? 2 : 1);
  if (!isOwnerId(u.id)) { const r = spendPaid(u.id, cost); if (!r.ok) return res.json({ ok: false, error: "need_paid", paid: r.paid }); }
  try {
    const rr = await fetch("https://api.replicate.com/v1/models/nightmareai/real-esrgan/predictions", {
      method: "POST", headers: { "Authorization": "Bearer " + REPLICATE_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ input: { image, scale, face_enhance: true } })
    });
    const d = await rr.json();
    if (!rr.ok || !d.id) { if (!isOwnerId(u.id)) addPaid(u.id, cost); return res.status(502).json({ ok: false, error: "provider", detail: d.detail || null }); }
    incCounter("gen_media");
    res.json({ ok: true, id: d.id, status: d.status, paid: isOwnerId(u.id) ? null : paidBal(u.id) });
  } catch (e) { if (!isOwnerId(u.id)) addPaid(u.id, cost); res.status(500).json({ ok: false, error: "provider" }); }
});

// ---------- Telegram Stars: продажа кредитов ----------
const CREDIT_PACKS = [
  { credits: 60,  stars: Number(process.env.PACK1_STARS || 50)  },
  { credits: 200, stars: Number(process.env.PACK2_STARS || 150) },
  { credits: 600, stars: Number(process.env.PACK3_STARS || 400) }
];
async function tgApi(method, body){
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  return r.json();
}

// Создать счёт: kind="pack" (кредиты) или kind="pro" (PRO за Stars)
app.post("/api/pay/invoice", async (req, res) => {
  const u = auth(req, res); if (!u) return;
  if (!BOT_TOKEN) return res.status(500).json({ error: "no bot token" });
  const kind = req.body.kind === "pro" ? "pro" : "pack";
  let title, description, payload, stars;
  if (kind === "pro") {
    title = `PRO-доступ HALO · ${PRO_DAYS} дн.`;
    description = `AI-видео и все PRO-функции на ${PRO_DAYS} дней`;
    payload = `pro:${u.id}:${PRO_DAYS}`;
    stars = PRO_STARS;
  } else {
    const pack = CREDIT_PACKS[Number(req.body.pack)];
    if (!pack) return res.status(400).json({ error: "bad pack" });
    title = `${pack.credits} кредитов HALO`;
    description = `Пополнение баланса на ${pack.credits} кредитов`;
    payload = `credits:${u.id}:${pack.credits}`;
    stars = pack.stars;
  }
  try {
    const inv = await tgApi("createInvoiceLink", {
      title, description, payload,
      currency: "XTR",                     // Telegram Stars
      prices: [{ label: title, amount: stars }]
    });
    if (!inv.ok) return res.status(502).json({ error: "invoice", detail: inv.description || null });
    res.json({ ok: true, link: inv.result });
  } catch (e) {
    res.status(500).json({ error: "invoice" });
  }
});

// Дневной бонус
app.post("/api/bonus/claim", (req, res) => {
  const u = auth(req, res); if (!u) return;
  if (isOwnerId(u.id)) return res.json({ ok: true, credits: null });
  res.json(claimBonus(u.id));
});

// Реферал: вызывается при первом заходе с ref-параметром
app.post("/api/referral", (req, res) => {
  const u = auth(req, res); if (!u) return;
  const refId = Number(req.body.ref);
  const applied = applyReferral(u.id, refId);
  res.json({ ok: applied, credits: isOwnerId(u.id) ? null : balance(u.id) });
});

// Вебхук Telegram: подтверждаем оплату и начисляем кредиты.
// Настрой webhook бота на этот URL: https://<railway>/api/telegram/webhook
// (или перенеси эту логику в свой уже работающий бот).
app.post("/api/telegram/webhook", async (req, res) => {
  const upd = req.body || {};
  try {
    if (upd.pre_checkout_query) {
      await tgApi("answerPreCheckoutQuery", { pre_checkout_query_id: upd.pre_checkout_query.id, ok: true });
    } else if (upd.message && upd.message.successful_payment) {
      const sp = upd.message.successful_payment;
      if (sp.currency === "XTR") {
        const parts = String(sp.invoice_payload || "").split(":"); // credits:uid:amount | pro:uid:days
        const uid = Number(parts[1]);
        if (parts[0] === "credits" && uid && Number(parts[2])) addPaid(uid, Number(parts[2]));   // купленные кредиты
        else if (parts[0] === "pro" && uid && Number(parts[2])) grantProDays(uid, Number(parts[2]));
        if (uid) logPayment(uid, parts[0] || "?", Number(sp.total_amount || 0)); // лог для статистики
      }
    } else if (upd.message && typeof upd.message.text === "string" && upd.message.text.trim().startsWith("/start")) {
      await tgApi("sendMessage", {
        chat_id: upd.message.chat.id,
        text: "✨ HALO Studio — AI фото и видео прямо в Telegram.\n\nСоздавай изображения, оживляй фото и делай клипы. Нажми кнопку ниже 👇",
        reply_markup: { inline_keyboard: [[{ text: "🚀 Открыть HALO Studio", web_app: { url: APP_URL } }]] }
      });
    }
  } catch (e) { /* глотаем, чтобы Telegram не ретраил бесконечно */ }
  res.sendStatus(200);
});

// Улучшение промпта: сначала Gemini, если не вышло — Groq. Оба на сервере, работают без VPN.
const ENHANCE_PROMPT = (text) => `Ты — эксперт по промптам для AI-генерации фото и видео. Перепиши идею в один яркий детальный промпт на английском (40-70 слов): конкретный субъект, окружение, освещение, ракурс камеры, настроение, художественный стиль. Сохрани имена собственные и казахские/национальные слова и детали как есть (при необходимости латинской транслитерацией). Выведи ТОЛЬКО текст промпта — без кавычек и пояснений.\n\nИдея: ${text}`;

async function enhanceGemini(text){
  if (!GEMINI_API_KEY) return null;
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: ENHANCE_PROMPT(text) }] }], generationConfig: { temperature: 0.8, maxOutputTokens: 300 } })
    });
    const d = await r.json();
    const out = d?.candidates?.[0]?.content?.parts?.[0]?.text;
    return out ? out.trim() : null;
  } catch (e) { return null; }
}
async function enhanceGroq(text){
  if (!GROQ_API_KEY) return null;
  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST", headers: { "Authorization": "Bearer " + GROQ_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "llama-3.3-70b-versatile", temperature: 0.8, max_tokens: 300, messages: [{ role: "user", content: ENHANCE_PROMPT(text) }] })
    });
    const d = await r.json();
    const out = d?.choices?.[0]?.message?.content;
    return out ? out.trim() : null;
  } catch (e) { return null; }
}

app.post("/api/enhance", async (req, res) => {
  const u = auth(req, res); if (!u) return;
  const text = String((req.body && req.body.text) || "").slice(0, 600).trim();
  if (!text) return res.status(400).json({ error: "no text" });
  if (!GEMINI_API_KEY && !GROQ_API_KEY) return res.status(500).json({ error: "no ai configured" });
  let out = await enhanceGemini(text);
  if (!out) out = await enhanceGroq(text);
  if (!out) return res.status(502).json({ error: "empty" });
  res.json({ ok: true, prompt: out });
});

// ---------- Админ-панель (только по ADMIN_KEY) ----------
app.get("/api/admin/stats", (req, res) => {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) return res.sendStatus(403);
  const now = Date.now();
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  res.json({
    users:      one("SELECT COUNT(*) c FROM users").c,
    proActive:  one("SELECT COUNT(*) c FROM users WHERE pro_until > ?", now).c,
    referrals:  one("SELECT COALESCE(SUM(referrals),0) s FROM users").s,
    freeOut:    one("SELECT COALESCE(SUM(credits),0) s FROM users").s,
    paidOut:    one("SELECT COALESCE(SUM(paid_credits),0) s FROM users").s,
    genMedia:   getCounter("gen_media"),
    genVideo:   getCounter("gen_video"),
    payCount:   one("SELECT COUNT(*) c FROM payments").c,
    starsTotal: one("SELECT COALESCE(SUM(stars),0) s FROM payments").s,
    recent:     db.prepare("SELECT uid,kind,stars,ts FROM payments ORDER BY id DESC LIMIT 20").all()
  });
});

const ADMIN_HTML = `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HALO · Админ</title>
<style>body{margin:0;background:#0B0A14;color:#F5F3FF;font-family:system-ui,sans-serif;padding:22px}h1{font-size:20px;margin:0 0 4px}.sub{color:#9C97B8;font-size:13px;margin-bottom:18px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}
.card{background:#161327;border:1px solid rgba(160,150,220,.18);border-radius:14px;padding:16px}
.card .n{font-size:26px;font-weight:700;background:linear-gradient(105deg,#A855F7,#EC4899,#22D3EE);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.card .l{font-size:12px;color:#9C97B8;margin-top:4px}
h2{font-size:14px;color:#9C97B8;margin:24px 0 10px;text-transform:uppercase;letter-spacing:.1em}
table{width:100%;border-collapse:collapse;font-size:13px}td,th{text-align:left;padding:8px;border-bottom:1px solid rgba(160,150,220,.12)}th{color:#9C97B8}
.err{color:#FCA5A5;padding:20px}</style></head><body>
<h1>HALO Studio · Админ</h1><div class="sub" id="sub">загрузка…</div>
<div class="grid" id="cards"></div>
<h2>Выдать PRO вручную</h2>
<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:6px">
<input id="g-uid" placeholder="Telegram ID" style="background:#0B0A14;border:1px solid rgba(160,150,220,.28);border-radius:10px;color:#F5F3FF;padding:10px 12px;font-size:14px">
<input id="g-days" value="30" style="width:70px;background:#0B0A14;border:1px solid rgba(160,150,220,.28);border-radius:10px;color:#F5F3FF;padding:10px 12px;font-size:14px">
<button onclick="grant()" style="background:linear-gradient(105deg,#A855F7,#EC4899,#22D3EE);color:#0B0A14;border:none;border-radius:10px;padding:10px 16px;font-weight:700;cursor:pointer">Выдать PRO</button>
<button onclick="revoke()" style="background:#161327;color:#FCA5A5;border:1px solid rgba(160,150,220,.28);border-radius:10px;padding:10px 16px;cursor:pointer">Забрать</button>
<span id="g-res" style="color:#9C97B8;font-size:13px"></span>
</div>
<div class="sub" style="margin-top:0">ID узнаётся через @userinfobot. Дни — на сколько выдать (по умолчанию 30).</div>
<h2>Последние платежи</h2><table id="pay"><thead><tr><th>Когда</th><th>User ID</th><th>Тип</th><th>Stars</th></tr></thead><tbody></tbody></table>
<script>
const key=new URLSearchParams(location.search).get("key");
async function load(){
  try{
    const r=await fetch("/api/admin/stats?key="+encodeURIComponent(key||""));
    if(!r.ok){ document.body.innerHTML='<div class="err">Нет доступа. Открой /admin?key=ТВОЙ_ADMIN_KEY</div>'; return; }
    const d=await r.json();
    document.getElementById("sub").textContent="обновлено "+new Date().toLocaleString("ru");
    const cards=[["Пользователей",d.users],["Активных PRO",d.proActive],["Продано Stars",d.starsTotal],["Покупок",d.payCount],["Генераций фото/слайд",d.genMedia],["AI-видео",d.genVideo],["Рефералов",d.referrals],["Бесплатных ⚡ на руках",d.freeOut],["Купленных 💎 на руках",d.paidOut]];
    document.getElementById("cards").innerHTML=cards.map(([l,n])=>'<div class="card"><div class="n">'+n+'</div><div class="l">'+l+'</div></div>').join("");
    document.querySelector("#pay tbody").innerHTML=(d.recent||[]).map(p=>'<tr><td>'+new Date(p.ts).toLocaleString("ru")+'</td><td>'+p.uid+'</td><td>'+(p.kind==="pro"?"PRO":"Кредиты")+'</td><td>'+p.stars+' ★</td></tr>').join("")||'<tr><td colspan=4 style="color:#6F6A8C">пока нет платежей</td></tr>';
  }catch(e){ document.getElementById("sub").textContent="ошибка загрузки"; }
}
load(); setInterval(load, 15000);
async function grant(){
  const uid=document.getElementById("g-uid").value.trim(), days=document.getElementById("g-days").value.trim()||"30";
  if(!uid){ document.getElementById("g-res").textContent="введи ID"; return; }
  const r=await fetch("/api/admin/grant?key="+encodeURIComponent(key)+"&uid="+uid+"&days="+days);
  document.getElementById("g-res").textContent = r.ok ? ("✓ PRO выдан на "+days+" дн.") : "ошибка";
  if(r.ok) load();
}
async function revoke(){
  const uid=document.getElementById("g-uid").value.trim();
  if(!uid){ document.getElementById("g-res").textContent="введи ID"; return; }
  const r=await fetch("/api/admin/revoke?key="+encodeURIComponent(key)+"&uid="+uid);
  document.getElementById("g-res").textContent = r.ok ? "✓ PRO забран" : "ошибка";
  if(r.ok) load();
}
</script></body></html>`;
app.get("/admin", (_req, res) => res.type("html").send(ADMIN_HTML));

// Выдать / забрать PRO вручную (только по ADMIN_KEY)
app.get("/api/admin/grant", (req, res) => {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) return res.sendStatus(403);
  const uid = Number(req.query.uid), days = Number(req.query.days || 30);
  if (!uid) return res.status(400).json({ error: "no uid" });
  const until = grantProDays(uid, days > 0 ? days : 30);
  res.json({ ok: true, uid, pro_until: until });
});
app.get("/api/admin/revoke", (req, res) => {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) return res.sendStatus(403);
  const uid = Number(req.query.uid);
  if (!uid) return res.status(400).json({ error: "no uid" });
  qPro.run(0, uid);
  res.json({ ok: true, uid });
});

app.listen(PORT, () => console.log("HALO backend listening on :" + PORT));
