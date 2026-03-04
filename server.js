const express = require("express");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const session = require("express-session");

// ✅ NEW
let Pool = null;
try {
  ({ Pool } = require("pg"));
} catch (e) {
  // pg may not be installed locally yet
}

const app = express();
const PORT = process.env.PORT || 3000;

const DB_FILE = path.join(__dirname, "db.json");

/* ---------------- Helpers ---------------- */
function nowISO() { return new Date().toISOString(); }

function parseUsd(v) {
  const x = Number(String(v ?? "").replace(",", ".").trim());
  return (Number.isFinite(x) && x > 0) ? x : 0;
}

function usdToPoints(db, usd) {
  const rate = Number(db.settings?.usd_to_points ?? 10);
  return Math.floor(usd * rate);
}

function makeReferralCode(userId){
  return "U" + String(userId);
}

/* ---------------- Default DB ---------------- */
function defaultDb() {
  return {
    settings: {
      app_name: "MRP Logistic",
      usd_to_points: 10,
      min_deposit_usd: 5,
      min_withdraw_usd: 10,
      manager_contact: {
        title: "تواصل مع المدير لإتمام العملية",
        whatsapp: "+212619692685",
        telegram: "@Mrp_logistic"
      },
      referral: {
        signup_bonus_points: 1,
        deposit_bonus_points: 30
      },

      // ✅ NEW (اختياري): حد افتراضي لعدد المهام لكل مستخدم (null = بلا حد)
      default_tasks_limit: null
    },
    meta: { next_user_id: 555555 },
    users: [],
    wallet_transactions: [],
    tasks: [
      { id: 1, title: "مهمة 1", order_index: 1, reward_points: 15, wait_seconds: 10, is_active: true },
      { id: 2, title: "مهمة 2", order_index: 2, reward_points: 15, wait_seconds: 10, is_active: true },
      { id: 3, title: "مهمة 3", order_index: 3, reward_points: 15, wait_seconds: 10, is_active: true },
      { id: 4, title: "مهمة 4", order_index: 4, reward_points: 15, wait_seconds: 10, is_active: true },
      { id: 5, title: "مهمة 5", order_index: 5, reward_points: 15, wait_seconds: 10, is_active: true }
    ],
    user_tasks: [],
    task_runs: [],
    referrals: []
  };
}

/* ---------------- Storage Layer ----------------
   ✅ If DATABASE_URL exists -> store whole db as JSONB in Postgres
   ✅ Else -> use db.json file (local dev)
--------------------------------------------------*/

const USE_PG = !!process.env.DATABASE_URL && !!Pool;
const PG_TABLE = "app_kv";
const PG_KEY = "db";

/* ✅ SAFETY: Limit pool size to avoid max_conn */
const pool = (USE_PG)
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL?.includes("railway") ? { rejectUnauthorized: false } : false,
      max: Number(process.env.PGPOOL_MAX || 5),
      idleTimeoutMillis: Number(process.env.PGPOOL_IDLE || 30000),
      connectionTimeoutMillis: Number(process.env.PGPOOL_CONN_TIMEOUT || 5000),
    })
  : null;

function ensureDbFile() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify(defaultDb(), null, 2), "utf8");
  }
}

function readDbFile() {
  ensureDbFile();
  return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}

function writeDbFile(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf8");
}

/* ✅ SAFETY: ensurePg only once */
let PG_READY = false;
async function ensurePg() {
  if (PG_READY) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${PG_TABLE} (
      k TEXT PRIMARY KEY,
      v JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  PG_READY = true;
}

async function pgGetDb() {
  const r = await pool.query(`SELECT v FROM ${PG_TABLE} WHERE k=$1 LIMIT 1`, [PG_KEY]);
  return r.rows[0]?.v || null;
}

async function pgSetDb(db) {
  await pool.query(
    `INSERT INTO ${PG_TABLE} (k, v, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v, updated_at=NOW()`,
    [PG_KEY, db]
  );
}

/* ✅ SAFETY: In-memory cache + single-flight to reduce PG queries */
let DB_CACHE = null;
let DB_CACHE_AT = 0;
const DB_CACHE_TTL_MS = Number(process.env.DB_CACHE_TTL_MS || 800); // small, safe
let DB_READ_INFLIGHT = null;

let DB_WRITE_INFLIGHT = Promise.resolve();
let DB_LAST_WRITE_AT = 0;

async function readDb() {
  if (!USE_PG) return readDbFile();

  const now = Date.now();
  if (DB_CACHE && (now - DB_CACHE_AT) < DB_CACHE_TTL_MS) {
    return DB_CACHE;
  }

  if (DB_READ_INFLIGHT) return DB_READ_INFLIGHT;

  DB_READ_INFLIGHT = (async () => {
    await ensurePg();
    let db = await pgGetDb();

    // ✅ First time: if Postgres empty, import from db.json if exists, else create default
    if (!db) {
      if (fs.existsSync(DB_FILE)) {
        try {
          db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
        } catch {
          db = defaultDb();
        }
      } else {
        db = defaultDb();
      }
      await pgSetDb(db);
    }

    DB_CACHE = db;
    DB_CACHE_AT = Date.now();
    return db;
  })().finally(() => {
    DB_READ_INFLIGHT = null;
  });

  return DB_READ_INFLIGHT;
}

async function writeDb(db) {
  // update local cache always
  DB_CACHE = db;
  DB_CACHE_AT = Date.now();

  if (!USE_PG) return writeDbFile(db);

  // ✅ serialize writes to avoid flooding PG
  DB_LAST_WRITE_AT = Date.now();
  DB_WRITE_INFLIGHT = DB_WRITE_INFLIGHT.then(async () => {
    await ensurePg();
    await pgSetDb(db);
  }).catch(err => {
    console.error("❌ writeDb queue error:", err);
  });

  return DB_WRITE_INFLIGHT;
}

/* ---------------- Logic helpers ---------------- */
function ensureAdmin(db) {
  db.users = db.users || [];
  const exists = db.users.some(u => u.is_admin === true);
  if (exists) return;

  db.meta = db.meta || {};
  if (!Number.isFinite(db.meta.next_user_id)) db.meta.next_user_id = 555555;

  const adminEmail = process.env.ADMIN_EMAIL || "admin@mrp.local";
  const adminPass = process.env.ADMIN_PASSWORD || "Med@19851985";

  const adminId = db.meta.next_user_id;

  const admin = {
    id: adminId,
    full_name: "Admin",
    email: adminEmail,
    phone: null,
    password_hash: bcrypt.hashSync(adminPass, 10),
    points_balance: 0,
    is_admin: true,
    status: "active",
    created_at: nowISO(),
    last_login_at: null,
    referral_code: makeReferralCode(adminId),
    tasks_enabled: true,
    tasks_limit: null
  };

  db.users.push(admin);
  db.meta.next_user_id += 1;

  console.log("✅ Admin ensured:", adminEmail, "/", adminPass);
}

/* ✅ NEW: per-user tasks limit */
function getTasksLimitForUser(db, userId){
  const u = (db.users || []).find(x => x.id === userId);
  const raw = (u && u.tasks_limit !== undefined) ? u.tasks_limit : (db.settings?.default_tasks_limit ?? null);

  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return 0;
  return Math.floor(n);
}

/* ✅ NEW: return active tasks respecting user limit */
function getActiveTasksForUser(db, userId){
  const all = (db.tasks || []).filter(t => t.is_active).sort((a,b)=>a.order_index-b.order_index);
  const lim = getTasksLimitForUser(db, userId);
  if (lim === null) return all;
  return all.slice(0, lim);
}

function ensureUserTasks(db, userId) {
  db.tasks = db.tasks || [];
  db.user_tasks = db.user_tasks || [];

  const active = db.tasks.filter(t => t.is_active).sort((a,b)=>a.order_index-b.order_index);

  for (const t of active) {
    const found = db.user_tasks.find(x => x.user_id === userId && x.task_id === t.id);
    if (!found) {
      db.user_tasks.push({
        id: `${userId}-${t.id}`,
        user_id: userId,
        task_id: t.id,
        status: (t.order_index === 1) ? "available" : "locked",
        started_at: null,
        completed_at: null,
        earned_points: 0
      });
    }
  }
}

/* ✅ UPDATED: syncLocks respects per-user tasks limit */
function syncLocks(db, userId) {
  ensureUserTasks(db, userId);

  const tasksAllowed = getActiveTasksForUser(db, userId);
  const allowedIds = new Set(tasksAllowed.map(t => t.id));

  for (const ut of (db.user_tasks || [])) {
    if (ut.user_id !== userId) continue;
    if (!allowedIds.has(ut.task_id)) {
      if (ut.status !== "completed") ut.status = "locked";
    }
  }

  const uts = tasksAllowed.map(t => ({
    t,
    ut: db.user_tasks.find(x => x.user_id === userId && x.task_id === t.id)
  }));

  let seenAvailable = false;
  for (const x of uts) {
    if (!x.ut) continue;
    if (x.ut.status === "completed") continue;

    if (x.ut.status === "available") {
      if (!seenAvailable) seenAvailable = true;
      else x.ut.status = "locked";
    }
  }

  const anyAvailable = uts.some(x => x.ut?.status === "available");
  const allCompleted = uts.every(x => x.ut?.status === "completed");
  if (!anyAvailable && !allCompleted) {
    const firstNot = uts.find(x => x.ut && x.ut.status !== "completed");
    if (firstNot?.ut) firstNot.ut.status = "available";
  }
}

/* ✅ UPDATED: reset only allowed tasks for that user */
function resetUserProgress(db, userId) {
  ensureUserTasks(db, userId);
  const tasksAllowed = getActiveTasksForUser(db, userId);

  for (const t of tasksAllowed) {
    const ut = db.user_tasks.find(x => x.user_id === userId && x.task_id === t.id);
    if (!ut) continue;
    ut.status = (t.order_index === 1) ? "available" : "locked";
    ut.started_at = null;
    ut.completed_at = null;
    ut.earned_points = 0;
  }

  const allowedIds = new Set(tasksAllowed.map(t => t.id));
  for (const ut of (db.user_tasks || [])) {
    if (ut.user_id !== userId) continue;
    if (!allowedIds.has(ut.task_id)) {
      if (ut.status !== "completed") ut.status = "locked";
    }
  }

  db.task_runs = db.task_runs || [];
  for (const r of db.task_runs) {
    if (r.user_id === userId && r.status === "running") {
      r.status = "expired";
      r.finished_at = nowISO();
    }
  }
}

/* ---------------- Init (async) ---------------- */
async function init() {
  const db = await readDb();

  db.settings = db.settings || {};
  db.settings.referral = db.settings.referral || { signup_bonus_points: 1, deposit_bonus_points: 30 };
  if (db.settings.default_tasks_limit === undefined) db.settings.default_tasks_limit = null;

  db.meta = db.meta || { next_user_id: 555555 };
  db.users = db.users || [];
  db.wallet_transactions = db.wallet_transactions || [];
  db.tasks = db.tasks || [];
  db.user_tasks = db.user_tasks || [];
  db.task_runs = db.task_runs || [];
  db.referrals = db.referrals || [];

  ensureAdmin(db);

  for (const u of db.users) {
    if (!u.referral_code) u.referral_code = makeReferralCode(u.id);
    if (u.tasks_enabled === undefined) u.tasks_enabled = true;
    if (u.tasks_limit === undefined) u.tasks_limit = null;
  }

  for (const u of db.users) {
    if (!u.is_admin && u.tasks_enabled !== false) {
      ensureUserTasks(db, u.id);
      syncLocks(db, u.id);
    }
  }

  await writeDb(db);
}

/* ---------------- Middleware ---------------- */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(require("path").join(__dirname, "public")));
app.set("trust proxy", 1);
const isProd = process.env.NODE_ENV === "production";

app.use(session({
  name: "mrp.sid",
  secret: process.env.SESSION_SECRET || "mrp_secret_change_me",
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: isProd,
    sameSite: isProd ? "none" : "lax"
  }
}));

app.use("/public", express.static(path.join(__dirname, "public")));

/* ✅ SAFETY: very small rate-limit (memory) */
function makeRateLimiter({ windowMs = 60_000, max = 15 } = {}) {
  const hits = new Map(); // key -> {count, resetAt}
  return (req, res, next) => {
    const key = (req.ip || "ip") + "|" + req.path;
    const now = Date.now();
    const v = hits.get(key);
    if (!v || now > v.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    v.count += 1;
    if (v.count > max) {
      return res.status(429).json({ ok: false, message: "طلبات كثيرة، حاول بعد قليل." });
    }
    next();
  };
}

const limitAuth = makeRateLimiter({ windowMs: 60_000, max: 20 });

/* ---------------- Async wrapper ---------------- */
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* ---------------- Guards ---------------- */
const requireAuth = wrap(async (req, res, next) => {
  const db = await readDb();
  const u = (db.users || []).find(x => x.id === req.session.userId);
  const isApi = req.path.startsWith("/api/");

  if (!u || u.status !== "active") {
    if (isApi) return res.status(401).json({ ok: false, message: "Unauthorized" });
    return res.redirect("/login");
  }

  req.user = u;
  req._db = db;
  next();
});

function requireAdmin(req, res, next) {
  const isApi = req.path.startsWith("/api/");
  if (!req.user?.is_admin) {
    return isApi
      ? res.status(403).json({ ok: false, message: "Forbidden" })
      : res.status(403).send("Forbidden");
  }
  next();
}

function requireTasksEnabled(req, res, next){
  if (req.user?.is_admin) return next();
  if (req.user?.tasks_enabled === false) {
    return res.status(403).json({ ok: false, message: "تم إيقاف المهام لهذا الحساب." });
  }
  next();
}

/* ---------------- Pages ---------------- */
app.get("/", (req, res) => res.redirect("/home"));
app.get("/login", (req, res) => res.sendFile(path.join(__dirname, "views/login.html")));
app.get("/register", (req, res) => res.sendFile(path.join(__dirname, "views/register.html")));
app.get("/home", requireAuth, (req, res) => res.sendFile(path.join(__dirname, "views/home.html")));
app.get("/tasks", requireAuth, (req, res) => res.sendFile(path.join(__dirname, "views/tasks.html")));
app.get("/profile", requireAuth, (req, res) => res.sendFile(path.join(__dirname, "views/profile.html")));
app.get("/admin", requireAuth, requireAdmin, (req, res) => res.sendFile(path.join(__dirname, "views/admin.html")));
app.post("/logout", (req, res) => req.session.destroy(() => res.redirect("/login")));
app.get("/withdraw", requireAuth, (req, res) => res.sendFile(path.join(__dirname, "views/withdraw.html")));
app.get("/deposit", requireAuth, (req, res) => res.sendFile(path.join(__dirname, "views/deposit.html")));

/* ---------------- Referral API ---------------- */
app.get("/api/referral/me", requireAuth, wrap(async (req, res) => {
  const db = req._db;
  db.referrals = db.referrals || [];

  const code = req.user.referral_code || makeReferralCode(req.user.id);
  const total = db.referrals.filter(r => r.referrer_id === req.user.id).length;

  const base = `${req.protocol}://${req.get("host")}`;
  const link = `${base}/register?ref=${encodeURIComponent(code)}`;

  await writeDb(db);
  res.json({ ok: true, code, link, total });
}));

/* ---------------- Auth APIs ---------------- */
app.post("/api/register", limitAuth, wrap(async (req, res) => {
  const db = await readDb();
  const { full_name, email, phone, password, ref_code } = req.body;

  const pw = String(password || "").trim();
  if (pw.length < 6) return res.status(400).json({ ok: false, message: "كلمة المرور 6 أحرف على الأقل." });

  const keyEmail = email ? String(email).trim() : "";
  const keyPhone = phone ? String(phone).trim() : "";
  if (!keyEmail && !keyPhone) return res.status(400).json({ ok: false, message: "أدخل البريد أو الهاتف." });

  const exists = (db.users || []).find(u =>
    (keyEmail && u.email && String(u.email).toLowerCase() === keyEmail.toLowerCase()) ||
    (keyPhone && u.phone && String(u.phone) === keyPhone)
  );
  if (exists) return res.status(400).json({ ok: false, message: "الحساب موجود." });

  db.meta = db.meta || {};
  if (!Number.isFinite(db.meta.next_user_id)) db.meta.next_user_id = 555555;

  const newId = db.meta.next_user_id;

  const user = {
    id: newId,
    full_name: String(full_name || "").trim() || null,
    email: keyEmail || null,
    phone: keyPhone || null,
    password_hash: bcrypt.hashSync(pw, 10),
    points_balance: 0,
    is_admin: false,
    status: "active",
    created_at: nowISO(),
    last_login_at: null,
    referral_code: makeReferralCode(newId),
    tasks_enabled: true,
    tasks_limit: null
  };

  db.users.push(user);
  db.meta.next_user_id += 1;

  db.referrals = db.referrals || [];
  const code = String(ref_code || "").trim();
  if (code) {
    const referrer = db.users.find(u => u.referral_code === code);
    if (referrer && referrer.id !== user.id) {
      const already = db.referrals.find(r => r.referred_id === user.id);
      if (!already) {
        const signupBonus = Number(db.settings?.referral?.signup_bonus_points ?? 1);
        db.referrals.push({
          id: String(Date.now()) + "-" + Math.floor(Math.random() * 99999),
          referrer_id: referrer.id,
          referred_id: user.id,
          ref_code: code,
          created_at: nowISO(),
          signup_bonus_points: signupBonus,
          deposit_bonus_points: Number(db.settings?.referral?.deposit_bonus_points ?? 30),
          deposit_bonus_awarded: false
        });
        referrer.points_balance += signupBonus;
      }
    }
  }

  if (user.tasks_enabled !== false) {
    ensureUserTasks(db, user.id);
    resetUserProgress(db, user.id);
    syncLocks(db, user.id);
  }

  await writeDb(db);
  return res.json({ ok: true });
}));

app.post("/api/login", limitAuth, wrap(async (req, res) => {
  const db = await readDb();
  const keyRaw = String(req.body.emailOrPhone || "").trim();
  const keyLower = keyRaw.toLowerCase();
  const password = String(req.body.password || "");

  const u = (db.users || []).find(x => {
    const emailOk = x.email && String(x.email).toLowerCase() === keyLower;
    const phoneOk = x.phone && String(x.phone).trim() === keyRaw;
    return emailOk || phoneOk;
  });

  if (!u) return res.status(400).json({ ok: false, message: "بيانات غير صحيحة." });

  const ok = bcrypt.compareSync(password, u.password_hash);
  if (!ok) return res.status(400).json({ ok: false, message: "بيانات غير صحيحة." });

  if (u.status !== "active") return res.status(403).json({ ok: false, message: "الحساب غير نشط." });

  u.last_login_at = nowISO();
  req.session.userId = u.id;

  await writeDb(db);
  return res.json({ ok: true, is_admin: !!u.is_admin });
}));

/* ✅ SAFETY: support form POST /login too (won't break fetch) */
app.post("/login", limitAuth, wrap(async (req, res) => {
  // accept both: emailOrPhone/password OR email/password
  const emailOrPhone = String(req.body.emailOrPhone || req.body.email || req.body.phone || "").trim();
  const password = String(req.body.password || "").trim();

  // mimic API login
  const db = await readDb();
  const keyLower = emailOrPhone.toLowerCase();

  const u = (db.users || []).find(x => {
    const emailOk = x.email && String(x.email).toLowerCase() === keyLower;
    const phoneOk = x.phone && String(x.phone).trim() === emailOrPhone;
    return emailOk || phoneOk;
  });

  if (!u) return res.redirect("/login");
  const ok = bcrypt.compareSync(password, u.password_hash);
  if (!ok) return res.redirect("/login");
  if (u.status !== "active") return res.status(403).send("Forbidden");

  u.last_login_at = nowISO();
  req.session.userId = u.id;
  await writeDb(db);

  return res.redirect(u.is_admin ? "/admin" : "/home");
}));

app.get("/api/me", requireAuth, wrap(async (req, res) => {
  const db = req._db;

  if (!req.user.is_admin && req.user.tasks_enabled !== false) {
    ensureUserTasks(db, req.user.id);
    syncLocks(db, req.user.id);
    await writeDb(db);
  }

  const activeTasksAllowed = getActiveTasksForUser(db, req.user.id);
  const done = (db.user_tasks || []).filter(x => x.user_id === req.user.id && x.status === "completed").filter(x => {
    return activeTasksAllowed.some(t => t.id === x.task_id);
  }).length;

  res.json({
    ok: true,
    app: { name: db.settings.app_name },
    user: {
      id: req.user.id,
      full_name: req.user.full_name,
      points_balance: req.user.points_balance,
      is_admin: !!req.user.is_admin,
      tasks_enabled: req.user.tasks_enabled !== false,
      tasks_limit: (req.user.tasks_limit === undefined ? null : req.user.tasks_limit)
    },
    settings: db.settings,
    tasks: { total: activeTasksAllowed.length, done }
  });
}));

/* ---------------- Wallet ---------------- */
app.post("/api/wallet/request", requireAuth, wrap(async (req, res) => {
  const db = req._db;
  const { type, amount_usd } = req.body;

  if (!["deposit", "withdraw"].includes(type)) return res.status(400).json({ ok: false, message: "نوع غير صحيح." });

  const usd = parseUsd(amount_usd);
  if (!usd) return res.status(400).json({ ok: false, message: "أدخل مبلغ صحيح بالدولار." });

  const minDep = Number(db.settings.min_deposit_usd ?? 5);
  const minW = Number(db.settings.min_withdraw_usd ?? 10);

  if (type === "deposit" && usd < minDep) return res.status(400).json({ ok: false, message: `أقل إيداع هو ${minDep}$` });
  if (type === "withdraw" && usd < minW) return res.status(400).json({ ok: false, message: `أقل سحب هو ${minW}$` });

  const points = usdToPoints(db, usd);
  if (type === "withdraw" && req.user.points_balance < points) {
    return res.status(400).json({ ok: false, message: "رصيد النقاط غير كافٍ." });
  }

  db.wallet_transactions = db.wallet_transactions || [];
  db.wallet_transactions.push({
    id: String(Date.now()) + "-" + Math.floor(Math.random() * 9999),
    user_id: req.user.id,
    type,
    amount_usd: usd,
    rate_usd_to_points: Number(db.settings.usd_to_points ?? 10),
    points_delta: type === "deposit" ? points : -points,
    status: "pending",
    created_at: nowISO(),
    processed_at: null
  });

  await writeDb(db);
  res.json({ ok: true, message: "تم إرسال الطلب.", manager: db.settings.manager_contact });
}));

app.get("/api/wallet/my", requireAuth, (req, res) => {
  const db = req._db;
  const rows = (db.wallet_transactions || []).filter(x => x.user_id === req.user.id).slice(-30).reverse();
  res.json({ ok: true, rows });
});

/* ---------------- Tasks (User) ---------------- */
app.get("/api/tasks", requireAuth, requireTasksEnabled, wrap(async (req, res) => {
  const db = req._db;

  ensureUserTasks(db, req.user.id);
  syncLocks(db, req.user.id);

  const allowed = getActiveTasksForUser(db, req.user.id);

  const rows = allowed
    .sort((a, b) => a.order_index - b.order_index)
    .map(t => {
      const ut = (db.user_tasks || []).find(x => x.user_id === req.user.id && x.task_id === t.id);
      return {
        id: t.id,
        title: t.title,
        order_index: t.order_index,
        reward_points: t.reward_points,
        wait_seconds: t.wait_seconds,
        status: ut?.status || "locked"
      };
    });

  await writeDb(db);
  res.json({ ok: true, rows, limit: getTasksLimitForUser(db, req.user.id) });
}));

app.post("/api/tasks/start", requireAuth, requireTasksEnabled, wrap(async (req, res) => {
  const db = req._db;

  ensureUserTasks(db, req.user.id);
  syncLocks(db, req.user.id);

  const allowedTasks = getActiveTasksForUser(db, req.user.id);
  const allowedIds = new Set(allowedTasks.map(t => t.id));

  const available = (db.user_tasks || [])
    .filter(x => x.user_id === req.user.id && x.status === "available" && allowedIds.has(x.task_id))
    .map(x => ({ ut: x, t: (db.tasks || []).find(tt => tt.id === x.task_id) }))
    .filter(x => x.t && x.t.is_active && allowedIds.has(x.t.id))
    .sort((a, b) => a.t.order_index - b.t.order_index);

  const pick = available[0];
  if (!pick) return res.status(400).json({ ok: false, message: "لا توجد مهمة جاهزة." });

  db.task_runs = db.task_runs || [];
  const running = db.task_runs.find(r => r.user_id === req.user.id && r.status === "running");
  if (running) return res.status(400).json({ ok: false, message: "هناك مهمة قيد التنفيذ." });

  const token = String(Date.now()) + "-" + Math.floor(Math.random() * 99999);
  const expected = Date.now() + (pick.t.wait_seconds * 1000);

  db.task_runs.push({
    id: token,
    user_id: req.user.id,
    task_id: pick.t.id,
    run_token: token,
    started_at: nowISO(),
    expected_finish_ms: expected,
    finished_at: null,
    status: "running"
  });

  await writeDb(db);
  res.json({ ok: true, run_token: token, wait_seconds: pick.t.wait_seconds });
}));

app.post("/api/tasks/finish", requireAuth, requireTasksEnabled, wrap(async (req, res) => {
  const db = req._db;
  ensureUserTasks(db, req.user.id);

  const allowedTasks = getActiveTasksForUser(db, req.user.id);
  const allowedIds = new Set(allowedTasks.map(t => t.id));

  const { run_token } = req.body;
  const run = (db.task_runs || []).find(r => r.run_token === run_token && r.user_id === req.user.id && r.status === "running");
  if (!run) return res.status(400).json({ ok: false, message: "جلسة غير صالحة." });

  if (!allowedIds.has(run.task_id)) {
    run.status = "expired";
    run.finished_at = nowISO();
    await writeDb(db);
    return res.status(403).json({ ok: false, message: "هذه المهمة غير مسموحة لهذا الحساب." });
  }

  if (Date.now() < run.expected_finish_ms) {
    return res.status(400).json({ ok: false, message: "يجب الانتظار لإكمال المهمة." });
  }

  const task = (db.tasks || []).find(t => t.id === run.task_id && t.is_active);
  if (!task) return res.status(400).json({ ok: false, message: "المهمة غير موجودة." });

  const ut = (db.user_tasks || []).find(x => x.user_id === req.user.id && x.task_id === task.id);
  if (!ut || ut.status !== "available") return res.status(400).json({ ok: false, message: "المهمة غير جاهزة." });

  ut.status = "completed";
  ut.completed_at = nowISO();
  ut.earned_points = task.reward_points;

  const allowedSorted = allowedTasks.sort((a,b)=>a.order_index-b.order_index);
  const idx = allowedSorted.findIndex(t => t.id === task.id);
  const next = (idx >= 0) ? allowedSorted[idx + 1] : null;

  if (next) {
    const nextUT = (db.user_tasks || []).find(x => x.user_id === req.user.id && x.task_id === next.id);
    if (nextUT && nextUT.status === "locked") nextUT.status = "available";
  }

  req.user.points_balance += task.reward_points;

  run.status = "completed";
  run.finished_at = nowISO();

  await writeDb(db);
  res.json({ ok: true, message: "لقد اكتملت المهمة ✅ وتمت إضافة المكافأة." });
}));

/* ---------------- ADMIN: Pending Requests ---------------- */
app.get("/api/admin/requests", requireAuth, requireAdmin, (req, res) => {
  const db = req._db;
  const rows = (db.wallet_transactions || [])
    .filter(x => x.status === "pending")
    .slice(-200)
    .reverse()
    .map(x => {
      const u = db.users.find(uu => uu.id === x.user_id);
      return { ...x, full_name: u?.full_name, email: u?.email, phone: u?.phone };
    });
  res.json({ ok: true, rows });
});

app.post("/api/admin/requests/:id/approve", requireAuth, requireAdmin, wrap(async (req, res) => {
  const db = req._db;
  const id = req.params.id;

  const row = (db.wallet_transactions || []).find(x => x.id === id && x.status === "pending");
  if (!row) return res.status(400).json({ ok: false, message: "طلب غير صالح." });

  const u = db.users.find(uu => uu.id === row.user_id);
  if (!u) return res.status(400).json({ ok: false, message: "مستخدم غير موجود." });

  u.points_balance += row.points_delta;
  row.status = "approved";
  row.processed_at = nowISO();

  if (String(row.type).toLowerCase() === "deposit") {
    db.referrals = db.referrals || [];
    const rel = db.referrals.find(r => r.referred_id === u.id && r.deposit_bonus_awarded === false);
    if (rel) {
      const referrer = db.users.find(x => x.id === rel.referrer_id);
      if (referrer) {
        const bonus = Number(db.settings?.referral?.deposit_bonus_points ?? rel.deposit_bonus_points ?? 30);
        referrer.points_balance += bonus;
        rel.deposit_bonus_awarded = true;
        rel.deposit_bonus_awarded_at = nowISO();
      }
    }
  }

  await writeDb(db);
  res.json({ ok: true });
}));

app.post("/api/admin/requests/:id/reject", requireAuth, requireAdmin, wrap(async (req, res) => {
  const db = req._db;
  const id = req.params.id;

  const row = (db.wallet_transactions || []).find(x => x.id === id && x.status === "pending");
  if (!row) return res.status(400).json({ ok: false, message: "طلب غير صالح." });

  row.status = "rejected";
  row.processed_at = nowISO();

  await writeDb(db);
  res.json({ ok: true });
}));

/* ---------------- ADMIN: Users ---------------- */
app.get("/api/admin/users", requireAuth, requireAdmin, wrap(async (req, res) => {
  const db = req._db;

  for (const u of (db.users || [])) {
    if (u.tasks_enabled === undefined) u.tasks_enabled = true;
    if (u.tasks_limit === undefined) u.tasks_limit = null;
  }
  await writeDb(db);

  const rows = (db.users || [])
    .filter(u => !u.is_admin)
    .slice(-300)
    .reverse();

  res.json({ ok: true, rows });
}));

app.post("/api/admin/users/:id/points", requireAuth, requireAdmin, wrap(async (req, res) => {
  const db = req._db;
  const userId = Number(req.params.id);
  const points = Number(req.body.points);

  if (!Number.isFinite(points) || points < 0) return res.status(400).json({ ok: false, message: "نقاط غير صالحة." });

  const u = db.users.find(x => x.id === userId && !x.is_admin);
  if (!u) return res.status(400).json({ ok: false, message: "مستخدم غير موجود." });

  u.points_balance = Math.floor(points);
  await writeDb(db);
  res.json({ ok: true });
}));

app.post("/api/admin/users/:id/password", requireAuth, requireAdmin, wrap(async (req, res) => {
  const db = req._db;
  const userId = Number(req.params.id);

  const new_password = String(req.body.new_password || "").trim();
  if (new_password.length < 6) return res.status(400).json({ ok: false, message: "كلمة المرور 6 أحرف على الأقل." });

  const u = db.users.find(x => x.id === userId && !x.is_admin);
  if (!u) return res.status(400).json({ ok: false, message: "مستخدم غير موجود." });

  u.password_hash = bcrypt.hashSync(new_password, 10);
  await writeDb(db);
  res.json({ ok: true });
}));

app.post("/api/admin/users/:id/reset-tasks", requireAuth, requireAdmin, wrap(async (req, res) => {
  const db = req._db;
  const userId = Number(req.params.id);

  const u = db.users.find(x => x.id === userId && !x.is_admin);
  if (!u) return res.status(404).json({ ok: false, message: "مستخدم غير موجود." });

  resetUserProgress(db, userId);
  syncLocks(db, userId);
  await writeDb(db);
  res.json({ ok: true });
}));

app.post("/api/admin/users/:id/tasks-enabled", requireAuth, requireAdmin, wrap(async (req, res) => {
  const db = req._db;
  const userId = Number(req.params.id);
  const enabled = !!req.body.enabled;

  const u = db.users.find(x => x.id === userId && !x.is_admin);
  if (!u) return res.status(404).json({ ok: false, message: "مستخدم غير موجود." });

  u.tasks_enabled = enabled;

  db.task_runs = db.task_runs || [];
  if (!enabled) {
    for (const r of db.task_runs) {
      if (r.user_id === userId && r.status === "running") {
        r.status = "expired";
        r.finished_at = nowISO();
      }
    }
  }

  await writeDb(db);
  res.json({ ok: true, tasks_enabled: u.tasks_enabled });
}));

/* ✅ NEW: set per-user tasks limit */
app.post("/api/admin/users/:id/tasks-limit", requireAuth, requireAdmin, wrap(async (req, res) => {
  const db = req._db;
  const userId = Number(req.params.id);

  const u = db.users.find(x => x.id === userId && !x.is_admin);
  if (!u) return res.status(404).json({ ok: false, message: "مستخدم غير موجود." });

  const raw = req.body.limit;

  if (raw === null || raw === undefined || raw === "") {
    u.tasks_limit = null;
  } else {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return res.status(400).json({ ok: false, message: "limit غير صالح" });
    u.tasks_limit = Math.floor(n);
  }

  ensureUserTasks(db, userId);
  syncLocks(db, userId);

  await writeDb(db);
  res.json({ ok: true, tasks_limit: u.tasks_limit });
}));

/* ---------------- ADMIN: Settings ---------------- */
app.get("/api/admin/settings", requireAuth, requireAdmin, (req, res) => {
  const db = req._db;
  res.json({ ok: true, settings: db.settings });
});

app.post("/api/admin/settings", requireAuth, requireAdmin, wrap(async (req, res) => {
  const db = req._db;

  const usd_to_points = Number(req.body.usd_to_points);
  const min_deposit_usd = Number(req.body.min_deposit_usd);
  const min_withdraw_usd = Number(req.body.min_withdraw_usd);

  if (!Number.isFinite(usd_to_points) || usd_to_points <= 0) return res.status(400).json({ ok: false, message: "usd_to_points غير صالح" });
  if (!Number.isFinite(min_deposit_usd) || min_deposit_usd <= 0) return res.status(400).json({ ok: false, message: "min_deposit_usd غير صالح" });
  if (!Number.isFinite(min_withdraw_usd) || min_withdraw_usd <= 0) return res.status(400).json({ ok: false, message: "min_withdraw_usd غير صالح" });

  db.settings.usd_to_points = Math.floor(usd_to_points);
  db.settings.min_deposit_usd = min_deposit_usd;
  db.settings.min_withdraw_usd = min_withdraw_usd;

  db.settings.manager_contact = db.settings.manager_contact || {};
  if (req.body.whatsapp !== undefined) db.settings.manager_contact.whatsapp = String(req.body.whatsapp || "");
  if (req.body.telegram !== undefined) db.settings.manager_contact.telegram = String(req.body.telegram || "");

  db.settings.referral = db.settings.referral || {};
  if (req.body.signup_bonus_points !== undefined) db.settings.referral.signup_bonus_points = Number(req.body.signup_bonus_points) || 1;
  if (req.body.deposit_bonus_points !== undefined) db.settings.referral.deposit_bonus_points = Number(req.body.deposit_bonus_points) || 30;

  if (req.body.default_tasks_limit !== undefined) {
    const raw = req.body.default_tasks_limit;
    if (raw === null || raw === "" || raw === undefined) db.settings.default_tasks_limit = null;
    else {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) return res.status(400).json({ ok: false, message: "default_tasks_limit غير صالح" });
      db.settings.default_tasks_limit = Math.floor(n);
    }
  }

  await writeDb(db);
  res.json({ ok: true });
}));

/* ---------------- ADMIN: Tasks ---------------- */
app.get("/api/admin/tasks", requireAuth, requireAdmin, (req, res) => {
  const db = req._db;
  const rows = (db.tasks || []).sort((a, b) => a.order_index - b.order_index);
  res.json({ ok: true, rows });
});

app.post("/api/admin/tasks/create", requireAuth, requireAdmin, wrap(async (req, res) => {
  const db = req._db;

  const title = String(req.body.title || "").trim();
  const reward_points = Number(req.body.reward_points);
  const wait_seconds = Number(req.body.wait_seconds);

  if (!title) return res.status(400).json({ ok: false, message: "العنوان مطلوب" });
  if (!Number.isFinite(reward_points) || reward_points < 0) return res.status(400).json({ ok: false, message: "reward غير صالح" });
  if (!Number.isFinite(wait_seconds) || wait_seconds < 1) return res.status(400).json({ ok: false, message: "wait غير صالح" });

  const maxOrder = (db.tasks || []).length ? Math.max(...db.tasks.map(t => t.order_index)) : 0;
  const newId = (db.tasks || []).length ? (Math.max(...db.tasks.map(t => t.id)) + 1) : 1;

  const task = {
    id: newId,
    title,
    order_index: maxOrder + 1,
    reward_points: Math.floor(reward_points),
    wait_seconds: Math.floor(wait_seconds),
    is_active: true
  };

  db.tasks.push(task);

  for (const u of db.users) {
    if (!u.is_admin && u.tasks_enabled !== false) {
      ensureUserTasks(db, u.id);
      syncLocks(db, u.id);
    }
  }

  await writeDb(db);
  res.json({ ok: true, task });
}));

app.post("/api/admin/tasks/:id/update", requireAuth, requireAdmin, wrap(async (req, res) => {
  const db = req._db;
  const id = Number(req.params.id);

  const t = (db.tasks || []).find(x => x.id === id);
  if (!t) return res.status(404).json({ ok: false, message: "مهمة غير موجودة" });

  const title = String(req.body.title ?? t.title).trim();
  const reward_points = Number(req.body.reward_points ?? t.reward_points);
  const wait_seconds = Number(req.body.wait_seconds ?? t.wait_seconds);
  const is_active = (req.body.is_active === undefined) ? t.is_active : !!req.body.is_active;

  if (!title) return res.status(400).json({ ok: false, message: "العنوان مطلوب" });
  if (!Number.isFinite(reward_points) || reward_points < 0) return res.status(400).json({ ok: false, message: "reward غير صالح" });
  if (!Number.isFinite(wait_seconds) || wait_seconds < 1) return res.status(400).json({ ok: false, message: "wait غير صالح" });

  t.title = title;
  t.reward_points = Math.floor(reward_points);
  t.wait_seconds = Math.floor(wait_seconds);
  t.is_active = is_active;

  for (const u of db.users) {
    if (!u.is_admin && u.tasks_enabled !== false) {
      ensureUserTasks(db, u.id);
      syncLocks(db, u.id);
    }
  }

  await writeDb(db);
  res.json({ ok: true });
}));

/* ---------------- ADMIN: Create User ---------------- */
app.post("/api/admin/users/create", requireAuth, requireAdmin, wrap(async (req,res)=>{
  const db = req._db;

  const full_name = String(req.body.full_name || "").trim();
  const email = String(req.body.email || "").trim();
  const password = String(req.body.password || "").trim();

  if(!full_name || !email || password.length < 6){
    return res.status(400).json({ ok:false, message:"المعطيات غير صحيحة" });
  }

  const exists = db.users.find(u => u.email === email);
  if(exists){
    return res.status(400).json({ ok:false, message:"البريد مستعمل" });
  }

  const newId = db.meta.next_user_id;

  const user = {
    id:newId,
    full_name,
    email,
    phone:null,
    password_hash:bcrypt.hashSync(password,10),
    points_balance:0,
    is_admin:false,
    status:"active",
    created_at:nowISO(),
    last_login_at:null,
    referral_code:makeReferralCode(newId),
    tasks_enabled:true,
    tasks_limit: null
  };

  db.users.push(user);
  db.meta.next_user_id++;

  ensureUserTasks(db,user.id);
  resetUserProgress(db,user.id);
  syncLocks(db,user.id);

  await writeDb(db);

  res.json({ ok:true });
}));

/* ---------------- ADMIN: Delete User ---------------- */
app.post("/api/admin/users/:id/delete", requireAuth, requireAdmin, wrap(async (req,res)=>{
  const db = req._db;
  const userId = Number(req.params.id);

  const index = db.users.findIndex(u => u.id === userId && !u.is_admin);

  if(index === -1){
    return res.status(404).json({ ok:false, message:"المستخدم غير موجود" });
  }

  db.users.splice(index,1);

  db.user_tasks = (db.user_tasks || []).filter(x => x.user_id !== userId);
  db.task_runs = (db.task_runs || []).filter(x => x.user_id !== userId);
  db.wallet_transactions = (db.wallet_transactions || []).filter(x => x.user_id !== userId);

  await writeDb(db);

  res.json({ ok:true });
}));

/* ---------------- Debug ---------------- */
app.get("/test", (req, res) => res.send("SERVER UPDATED ✅"));

/* ---------------- Error Handler ---------------- */
app.use((err, req, res, next) => {
  console.error("❌ Error:", err);
  res.status(500).json({ ok: false, message: "Server error", error: String(err?.message || err) });
});

/* ✅ graceful shutdown (Railway) */
async function shutdown(signal){
  console.log(`🟡 ${signal} received. Closing...`);
  try{
    if (USE_PG && pool) await pool.end();
  }catch(e){}
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

/* ---------------- Start ---------------- */
(async () => {
  await init();
  app.listen(PORT, () => {
    console.log("✅ MRP Logistic running on port", PORT);
    console.log("✅ Storage:", USE_PG ? "PostgreSQL (persistent)" : "db.json (local)");
    if (USE_PG) {
      console.log("✅ PGPOOL_MAX =", Number(process.env.PGPOOL_MAX || 5));
      console.log("✅ DB_CACHE_TTL_MS =", Number(process.env.DB_CACHE_TTL_MS || 800));
    }
  });
})();