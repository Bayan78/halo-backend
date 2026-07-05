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

const BOT_TOKEN      = process.env.BOT_TOKEN || "";
const OWNER_ID       = Number(process.env.OWNER_ID || 976860643);
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

// --- Видео-API (генеративное видео) ---
const REPLICATE_TOKEN = process.env.REPLICATE_TOKEN || "";        // ключ Replicate (r8_...)
const VIDEO_COST      = Number(process.env.VIDEO_COST || 10);     // сколько кредитов стоит 1 AI-видео
const VIDEO_DURATION  = Number(process.env.VIDEO_DURATION || 5);  // 5 или 10 сек (для Kling/Seedance)

// Три модели, сверенные по страницам Replicate (schema подтверждена).
// Каждая знает свой точный набор полей input.
const VIDEO_MODELS = {
  // Kling 2.1 Master — text-to-video, 1080p, 5/10 сек
  kling: {
    slug: "kwaivgi/kling-v2.1-master",
    cost: Number(process.env.COST_KLING || 10),
    build: (prompt, o) => ({ prompt, duration: pick(o.duration, [5, 10], 5), aspect_ratio: o.aspect })
  },
  // Veo 3.1 — 4/6/8 сек, 16:9/9:16, звук. Разрешение: 8с → 1080p, иначе 720p.
  veo3: {
    slug: "google/veo-3.1",
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
  // Seedance 1.0 Pro — 1080p, 5/10 сек
  seedance: {
    slug: "bytedance/seedance-1-pro",
    cost: Number(process.env.COST_SEEDANCE || 10),
    build: (prompt, o) => ({ prompt, duration: pick(o.duration, [5, 10], 5), aspect_ratio: o.aspect, resolution: "1080p", fps: 24 })
  }
};
function pick(val, allowed, def){ return allowed.includes(Number(val)) ? Number(val) : def; }
function videoModel(modelKey){ return VIDEO_MODELS[modelKey] || VIDEO_MODELS.kling; }
function videoCost(modelKey){ return videoModel(modelKey).cost; }
function buildVideoInput(modelKey, prompt, opts){
  const m = videoModel(modelKey);
  const aspect = ["16:9", "9:16", "1:1"].includes(opts.aspect) ? opts.aspect : "16:9";
  const audio  = opts.audio !== false; // по умолчанию со звуком
  return { slug: m.slug, input: m.build(prompt, { duration: opts.duration, aspect, audio }) };
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
function isProUser(id){ if (id === OWNER_ID) return true; const r = row(id); return (r.pro_until || 0) > Date.now(); }
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
app.use(express.json());
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
    owner: u.id === OWNER_ID,
    free: u.id === OWNER_ID ? null : r.credits,
    paid: u.id === OWNER_ID ? null : (r.paid_credits || 0),
    pro: isProUser(u.id),
    pro_until: r.pro_until || 0,
    bonus: bonusAvailable(u.id),
    referrals: r.referrals || 0
  });
});

// Списание за картинки/слайд-шоу (сперва бесплатные, потом купленные).
app.post("/api/spend", (req, res) => {
  const u = auth(req, res); if (!u) return;
  const amount = Math.max(1, Number(req.body.amount || 1));
  if (u.id === OWNER_ID) return res.json({ ok: true, owner: true, free: null, paid: null });
  const r = spendAny(u.id, amount);
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
  if (id !== OWNER_ID) addCredits(id, AD_REWARD);
  res.sendStatus(200); // AdsGram ждёт 200 OK
});

app.get("/", (_req, res) => res.type("text").send("HALO credits backend · OK"));

// ---------- Генеративное видео (Replicate) ----------
// Списывает VIDEO_COST кредитов (владельцу бесплатно), создаёт задачу у провайдера,
// клиент опрашивает статус до готовности. Ключ провайдера живёт только на сервере.
app.post("/api/video/generate", async (req, res) => {
  const u = auth(req, res); if (!u) return;
  const prompt = String((req.body && req.body.prompt) || "").slice(0, 1000);
  if (!prompt) return res.status(400).json({ ok: false, error: "no prompt" });
  if (!REPLICATE_TOKEN) return res.status(500).json({ ok: false, error: "video api not configured" });
  if (!isProUser(u.id)) return res.json({ ok: false, error: "pro_required" }); // AI-видео — только PRO

  const cost = videoCost(req.body.model); // цена зависит от модели (Veo дороже)
  // AI-видео — только за КУПЛЕННЫЕ кредиты (владельцу бесплатно)
  if (u.id !== OWNER_ID) {
    const r = spendPaid(u.id, cost);
    if (!r.ok) return res.json({ ok: false, error: "need_paid", paid: r.paid });
  }
  try {
    const { slug, input } = buildVideoInput(req.body.model, prompt, { aspect: req.body.aspect, duration: req.body.duration, audio: req.body.audio });
    const r = await fetch(`https://api.replicate.com/v1/models/${slug}/predictions`, {
      method: "POST",
      headers: { "Authorization": "Bearer " + REPLICATE_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ input })
    });
    const d = await r.json();
    if (!r.ok || !d.id) { if (u.id !== OWNER_ID) addPaid(u.id, cost); return res.status(502).json({ ok: false, error: "provider", detail: d.detail || null }); }
    res.json({ ok: true, id: d.id, status: d.status, paid: u.id === OWNER_ID ? null : paidBal(u.id) });
  } catch (e) {
    if (u.id !== OWNER_ID) addPaid(u.id, cost);
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
  if (u.id === OWNER_ID) return res.json({ ok: true, credits: null });
  res.json(claimBonus(u.id));
});

// Реферал: вызывается при первом заходе с ref-параметром
app.post("/api/referral", (req, res) => {
  const u = auth(req, res); if (!u) return;
  const refId = Number(req.body.ref);
  const applied = applyReferral(u.id, refId);
  res.json({ ok: applied, credits: u.id === OWNER_ID ? null : balance(u.id) });
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
      }
    }
  } catch (e) { /* глотаем, чтобы Telegram не ретраил бесконечно */ }
  res.sendStatus(200);
});

app.listen(PORT, () => console.log("HALO backend listening on :" + PORT));
