/**
 * MRP Logistic - server.js (FULL)
 * - Storage: db.json (local) OR Railway volume
 * - Added: Rate limit + timeouts (fix 503 max_conn) + body limit + trust proxy
 * - Added: Per-user tasks_limit (0..5 or null=unlimited) controlled by admin panel
 */

const express = require("express");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const http = require("http");
const rateLimit = require("express-rate-limit");

const app = express();
app.set("trust proxy", 1); // IMPORTANT on Railway

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, "db.json");

/* ---------------- Security / Limits ---------------- */
app.use(express.json({ limit: "200kb" }));
app.use(express.urlencoded({ extended: true, limit: "200kb" }));

// Rate limits to prevent Backend.max_conn reached
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120, // 120 req/min لكل IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, message: "Too many requests" }
});

const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 25,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, message: "Slow down" }
});

app.use("/api", apiLimiter);
app.use("/login", authLimiter);
app.use("/api/auth", authLimiter);

/* ---------------- Sessions ---------------- */
app.use(
  session({
    secret: process.env.SESSION_SECRET || "mrp_logistic_secret_change_me",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: false // Railway behind HTTPS, but keep false if you test local http
    }
  })
);

/* ---------------- Static & Views ---------------- */
app.use("/public", express.static(path.join(__dirname, "public")));

function view(name) {
  return path.join(__dirname, "views", name);
}

/* ---------------- Helpers ---------------- */
function nowISO() {
  return new Date().toISOString();
}

function wrap(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function ensureDbFile() {
  if (!fs.existsSync(DB_FILE)) {
    const init = {
      meta: {
        next_user_id: 2,
        next_request_id: 1,
        next_wallet_tx_id: 1
      },
      settings: {
        app_name: "MRP Logistic",
        usd_to_points: 10,
        min_deposit_usd: 5,
        min_withdraw_usd: 10,
        manager_contact: {
          whatsapp: "",
          telegram: ""
        }
      },
      users: [
        {
          id: 1,
          full_name: "Admin",
          email: "admin@mrp.local",
          phone: null,
          password_hash: bcrypt.hashSync("admin123", 10),
          points_balance: 0,
          is_admin: true,
          status: "active",
          created_at: nowISO(),
          last_login_at: null,
          referral_code: "ADMIN1",
          tasks_enabled: true,
          tasks_limit: null // null = unlimited
        }
      ],
      tasks: [
        { id: 1, title: "مهمة 1", order_index: 1, reward_points: 15, wait_seconds: 10, is_active: true },
        { id: 2, title: "مهمة 2", order_index: 2, reward_points: 15, wait_seconds: 10, is_active: true },
        { id: 3, title: "مهمة 3", order_index: 3, reward_points: 15, wait_seconds: 10, is_active: true },
        { id: 4, title: "مهمة 4", order_index: 4, reward_points: 15, wait_seconds: 10, is_active: true },
        { id: 5, title: "مهمة 5", order_index: 5, reward_points: 15, wait_seconds: 10, is_active: true }
      ],
      // per-user progress/locks:
      user_tasks: [],
      task_runs: [],
      wallet_transactions: [],
      requests: []
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(init, null, 2), "utf8");
  }
}

function readDb() {
  ensureDbFile();
  const raw = fs.readFileSync(DB_FILE, "utf8");
  return JSON.parse(raw);
}

function writeDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf8");
}

function getUserById(db, id) {
  return (db.users || []).find(u => u.id === id);
}

function makeReferralCode(userId) {
  return "MRP" + String(userId).padStart(4, "0");
}

/**
 * Ensure user_tasks rows exist for all tasks
 */
function ensureUserTasks(db, userId) {
  db.user_tasks = db.user_tasks || [];
  const tasks = db.tasks || [];
  for (const t of tasks) {
    const exists = db.user_tasks.find(x => x.user_id === userId && x.task_id === t.id);
    if (!exists) {
      db.user_tasks.push({
        user_id: userId,
        task_id: t.id,
        is_locked: false,
        done_count: 0,
        last_done_at: null
      });
    }
  }
}

/**
 * Reset user progress (keeps tasks)
 */
function resetUserProgress(db, userId) {
  db.user_tasks = db.user_tasks || [];
  for (const ut of db.user_tasks) {
    if (ut.user_id === userId) {
      ut.is_locked = false;
      ut.done_count = 0;
      ut.last_done_at = null;
    }
  }
  // also clear runs
  db.task_runs = (db.task_runs || []).filter(r => r.user_id !== userId);
}

/**
 * Sync locks based on task active + user tasks_enabled + per-user tasks_limit
 * - If tasks_enabled=false => lock all tasks for that user
 * - If tasks_limit is number => lock tasks with order_index > limit
 * - If task is_active=false => lock for everyone
 */
function syncLocks(db, userId) {
  const user = getUserById(db, userId);
  if (!user || user.is_admin) return;

  ensureUserTasks(db, userId);

  const tasks = (db.tasks || []).slice().sort((a, b) => a.order_index - b.order_index);
  const limit = (user.tasks_limit === null || user.tasks_limit === undefined || user.tasks_limit === "")
    ? null
    : Math.max(0, Math.floor(Number(user.tasks_limit)));

  for (const t of tasks) {
    const ut = db.user_tasks.find(x => x.user_id === userId && x.task_id === t.id);
    if (!ut) continue;

    let lock = false;

    // global user toggle
    if (user.tasks_enabled === false) lock = true;

    // global task active
    if (!t.is_active) lock = true;

    // per-user limit (0..5)
    if (limit !== null) {
      if (t.order_index > limit) lock = true;
    }

    ut.is_locked = !!lock;
  }
}

/**
 * Return tasks list for user respecting locks/limit/active
 */
function getTasksForUser(db, userId) {
  const user = getUserById(db, userId);
  if (!user) return [];

  ensureUserTasks(db, userId);
  syncLocks(db, userId);

  const tasks = (db.tasks || []).slice().sort((a, b) => a.order_index - b.order_index);
  const out = [];

  for (const t of tasks) {
    const ut = db.user_tasks.find(x => x.user_id === userId && x.task_id === t.id);
    out.push({
      id: t.id,
      title: t.title,
      order_index: t.order_index,
      reward_points: t.reward_points,
      wait_seconds: t.wait_seconds,
      is_active: !!t.is_active,
      is_locked: ut ? !!ut.is_locked : true,
      done_count: ut ? ut.done_count : 0
    });
  }
  return out;
}

/* ---------------- DB middleware ---------------- */
app.use((req, res, next) => {
  req._db = readDb();
  next();
});

/* ---------------- Auth middlewares ---------------- */
function requireAuth(req, res, next) {
  if (!req.session?.user_id) {
    return res.status(401).json({ ok: false, message: "غير مسجل" });
  }
  next();
}

function requireAdmin(req, res, next) {
  const db = req._db;
  const u = getUserById(db, Number(req.session.user_id));
  if (!u || !u.is_admin) return res.status(403).send("Forbidden");
  next();
}

/* ---------------- Pages ---------------- */
app.get("/", (req, res) => res.redirect("/home"));

app.get("/login", (req, res) => res.sendFile(view("login.html")));
app.get("/register", (req, res) => res.sendFile(view("register.html")));

app.get("/home", (req, res) => res.sendFile(view("home.html")));
app.get("/tasks", (req, res) => res.sendFile(view("tasks.html")));
app.get("/deposit", (req, res) => res.sendFile(view("deposit.html")));
app.get("/withdraw", (req, res) => res.sendFile(view("withdraw.html")));
app.get("/profile", (req, res) => res.sendFile(view("profile.html")));

app.get("/admin", requireAuth, requireAdmin, (req, res) => res.sendFile(view("admin.html")));

/* ---------------- Auth APIs ---------------- */
app.post("/api/auth/login", wrap(async (req, res) => {
  const db = req._db;
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "").trim();

  const user = (db.users || []).find(u => (u.email || "").toLowerCase() === email);
  if (!user) return res.status(400).json({ ok: false, message: "بيانات خاطئة" });

  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) return res.status(400).json({ ok: false, message: "بيانات خاطئة" });

  req.session.user_id = user.id;
  user.last_login_at = nowISO();
  writeDb(db);

  res.json({ ok: true, user: { id: user.id, full_name: user.full_name, is_admin: !!user.is_admin } });
}));

app.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

app.get("/api/me", requireAuth, (req, res) => {
  const db = req._db;
  const u = getUserById(db, Number(req.session.user_id));
  if (!u) return res.status(404).json({ ok: false, message: "Not found" });
  res.json({
    ok: true,
    user: {
      id: u.id,
      full_name: u.full_name,
      email: u.email,
      phone: u.phone,
      points_balance: u.points_balance,
      is_admin: !!u.is_admin
    }
  });
});

/* ---------------- User APIs ---------------- */
app.get("/api/tasks", requireAuth, (req, res) => {
  const db = req._db;
  const userId = Number(req.session.user_id);
  const u = getUserById(db, userId);
  if (!u) return res.status(404).json({ ok: false, message: "Not found" });

  // if tasks_enabled is false => still return list but locked
  const rows = getTasksForUser(db, userId);
  res.json({ ok: true, rows });
});

/* ---------------- ADMIN: Settings ---------------- */
app.get("/api/admin/settings", requireAuth, requireAdmin, (req, res) => {
  const db = req._db;
  res.json({ ok: true, settings: db.settings || {} });
});

app.post("/api/admin/settings", requireAuth, requireAdmin, wrap(async (req, res) => {
  const db = req._db;

  const usd_to_points = Number(req.body.usd_to_points);
  const min_deposit_usd = Number(req.body.min_deposit_usd);
  const min_withdraw_usd = Number(req.body.min_withdraw_usd);
  const whatsapp = String(req.body.whatsapp || "").trim();
  const telegram = String(req.body.telegram || "").trim();

  if (!Number.isFinite(usd_to_points) || usd_to_points < 1) {
    return res.status(400).json({ ok: false, message: "usd_to_points غير صالح" });
  }

  db.settings = db.settings || {};
  db.settings.usd_to_points = Math.floor(usd_to_points);
  db.settings.min_deposit_usd = Number.isFinite(min_deposit_usd) ? Math.max(0, min_deposit_usd) : 0;
  db.settings.min_withdraw_usd = Number.isFinite(min_withdraw_usd) ? Math.max(0, min_withdraw_usd) : 0;
  db.settings.manager_contact = db.settings.manager_contact || {};
  db.settings.manager_contact.whatsapp = whatsapp;
  db.settings.manager_contact.telegram = telegram;

  writeDb(db);
  res.json({ ok: true, settings: db.settings });
}));

/* ---------------- ADMIN: Requests ---------------- */
app.get("/api/admin/requests", requireAuth, requireAdmin, (req, res) => {
  const db = req._db;
  const rows = (db.requests || []).filter(r => String(r.status || "").toLowerCase() === "pending");
  res.json({ ok: true, rows });
});

app.post("/api/admin/requests/:id/approve", requireAuth, requireAdmin, wrap(async (req, res) => {
  const db = req._db;
  const id = Number(req.params.id);
  const r = (db.requests || []).find(x => x.id === id);
  if (!r) return res.status(404).json({ ok: false, message: "Request not found" });
  if (String(r.status).toLowerCase() !== "pending") return res.json({ ok: true });

  const u = getUserById(db, Number(r.user_id));
  if (!u) return res.status(404).json({ ok: false, message: "User not found" });

  // apply points change
  const delta = Number(r.points_delta) || 0;
  u.points_balance = Number(u.points_balance || 0) + delta;

  r.status = "approved";
  r.approved_at = nowISO();

  writeDb(db);
  res.json({ ok: true });
}));

app.post("/api/admin/requests/:id/reject", requireAuth, requireAdmin, wrap(async (req, res) => {
  const db = req._db;
  const id = Number(req.params.id);
  const r = (db.requests || []).find(x => x.id === id);
  if (!r) return res.status(404).json({ ok: false, message: "Request not found" });
  if (String(r.status).toLowerCase() !== "pending") return res.json({ ok: true });

  r.status = "rejected";
  r.rejected_at = nowISO();

  writeDb(db);
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

  db.tasks = db.tasks || [];

  const maxOrder = db.tasks.length ? Math.max(...db.tasks.map(t => t.order_index)) : 0;
  const newId = db.tasks.length ? (Math.max(...db.tasks.map(t => t.id)) + 1) : 1;

  const task = {
    id: newId,
    title,
    order_index: maxOrder + 1,
    reward_points: Math.floor(reward_points),
    wait_seconds: Math.floor(wait_seconds),
    is_active: true
  };

  db.tasks.push(task);

  // sync for users
  for (const u of db.users || []) {
    if (!u.is_admin) {
      ensureUserTasks(db, u.id);
      syncLocks(db, u.id);
    }
  }

  writeDb(db);
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

  for (const u of db.users || []) {
    if (!u.is_admin) {
      ensureUserTasks(db, u.id);
      syncLocks(db, u.id);
    }
  }

  writeDb(db);
  res.json({ ok: true });
}));

/* ---------------- ADMIN: Users list ---------------- */
app.get("/api/admin/users", requireAuth, requireAdmin, (req, res) => {
  const db = req._db;
  const rows = (db.users || [])
    .filter(u => !u.is_admin)
    .map(u => ({
      id: u.id,
      full_name: u.full_name,
      email: u.email,
      phone: u.phone,
      points_balance: u.points_balance,
      tasks_enabled: u.tasks_enabled !== false,
      tasks_limit: (u.tasks_limit === undefined) ? null : u.tasks_limit
    }))
    .sort((a, b) => a.id - b.id);

  res.json({ ok: true, rows });
});

/* ---------------- ADMIN: points ---------------- */
app.post("/api/admin/users/:id/points", requireAuth, requireAdmin, wrap(async (req, res) => {
  const db = req._db;
  const userId = Number(req.params.id);
  const points = Number(req.body.points);

  if (!Number.isFinite(points)) return res.status(400).json({ ok: false, message: "points غير صالح" });

  const u = getUserById(db, userId);
  if (!u || u.is_admin) return res.status(404).json({ ok: false, message: "المستخدم غير موجود" });

  u.points_balance = Math.floor(points);

  writeDb(db);
  res.json({ ok: true });
}));

/* ---------------- ADMIN: password ---------------- */
app.post("/api/admin/users/:id/password", requireAuth, requireAdmin, wrap(async (req, res) => {
  const db = req._db;
  const userId = Number(req.params.id);
  const new_password = String(req.body.new_password || "").trim();

  if (!new_password || new_password.length < 6) {
    return res.status(400).json({ ok: false, message: "كلمة السر ضعيفة" });
  }

  const u = getUserById(db, userId);
  if (!u || u.is_admin) return res.status(404).json({ ok: false, message: "المستخدم غير موجود" });

  u.password_hash = bcrypt.hashSync(new_password, 10);

  writeDb(db);
  res.json({ ok: true });
}));

/* ---------------- ADMIN: tasks-enabled toggle ---------------- */
app.post("/api/admin/users/:id/tasks-enabled", requireAuth, requireAdmin, wrap(async (req, res) => {
  const db = req._db;
  const userId = Number(req.params.id);
  const enabled = !!req.body.enabled;

  const u = getUserById(db, userId);
  if (!u || u.is_admin) return res.status(404).json({ ok: false, message: "المستخدم غير موجود" });

  u.tasks_enabled = enabled;
  syncLocks(db, userId);

  writeDb(db);
  res.json({ ok: true, tasks_enabled: u.tasks_enabled });
}));

/* ---------------- ADMIN: tasks-limit (0..5 or null=unlimited) ---------------- */
app.post("/api/admin/users/:id/tasks-limit", requireAuth, requireAdmin, wrap(async (req, res) => {
  const db = req._db;
  const userId = Number(req.params.id);

  let limit = req.body.limit;

  // accept null, "null", undefined => null (unlimited)
  if (limit === null || limit === undefined || limit === "" || limit === "null") {
    limit = null;
  } else {
    const n = Number(limit);
    if (!Number.isFinite(n)) return res.status(400).json({ ok: false, message: "limit غير صالح" });
    const k = Math.floor(n);
    if (k < 0 || k > 5) return res.status(400).json({ ok: false, message: "limit يجب 0..5" });
    limit = k;
  }

  const u = getUserById(db, userId);
  if (!u || u.is_admin) return res.status(404).json({ ok: false, message: "المستخدم غير موجود" });

  u.tasks_limit = limit; // null or 0..5
  syncLocks(db, userId);

  writeDb(db);
  res.json({ ok: true, tasks_limit: u.tasks_limit });
}));

/* ---------------- ADMIN: reset tasks ---------------- */
app.post("/api/admin/users/:id/reset-tasks", requireAuth, requireAdmin, wrap(async (req, res) => {
  const db = req._db;
  const userId = Number(req.params.id);

  const u = getUserById(db, userId);
  if (!u || u.is_admin) return res.status(404).json({ ok: false, message: "المستخدم غير موجود" });

  resetUserProgress(db, userId);
  syncLocks(db, userId);

  writeDb(db);
  res.json({ ok: true });
}));

/* ---------------- ADMIN: create user ---------------- */
app.post("/api/admin/users/create", requireAuth, requireAdmin, wrap(async (req, res) => {
  const db = req._db;

  const full_name = String(req.body.full_name || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "").trim();

  if (!full_name || !email || password.length < 6) {
    return res.status(400).json({ ok: false, message: "المعطيات غير صحيحة" });
  }

  const exists = (db.users || []).find(u => (u.email || "").toLowerCase() === email);
  if (exists) return res.status(400).json({ ok: false, message: "البريد مستعمل" });

  const newId = db.meta?.next_user_id || ((db.users || []).length + 1);
  db.meta = db.meta || {};
  db.meta.next_user_id = newId + 1;

  const user = {
    id: newId,
    full_name,
    email,
    phone: null,
    password_hash: bcrypt.hashSync(password, 10),
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

  ensureUserTasks(db, user.id);
  resetUserProgress(db, user.id);
  syncLocks(db, user.id);

  writeDb(db);
  res.json({ ok: true, user_id: user.id });
}));

/* ---------------- ADMIN: delete user ---------------- */
app.post("/api/admin/users/:id/delete", requireAuth, requireAdmin, wrap(async (req, res) => {
  const db = req._db;
  const userId = Number(req.params.id);

  const index = (db.users || []).findIndex(u => u.id === userId && !u.is_admin);
  if (index === -1) return res.status(404).json({ ok: false, message: "المستخدم غير موجود" });

  db.users.splice(index, 1);

  db.user_tasks = (db.user_tasks || []).filter(x => x.user_id !== userId);
  db.task_runs = (db.task_runs || []).filter(x => x.user_id !== userId);
  db.wallet_transactions = (db.wallet_transactions || []).filter(x => x.user_id !== userId);
  db.requests = (db.requests || []).filter(x => x.user_id !== userId);

  writeDb(db);
  res.json({ ok: true });
}));

/* ---------------- Debug ---------------- */
app.get("/test", (req, res) => res.send("SERVER UPDATED ✅"));

/* ---------------- Error Handler ---------------- */
app.use((err, req, res, next) => {
  console.error("❌ Error:", err);
  if (res.headersSent) return next(err);
  res.status(500).json({ ok: false, message: "Server error", error: String(err?.message || err) });
});

/* ---------------- Start with timeouts ---------------- */
(function start() {
  ensureDbFile();

  const server = http.createServer(app);

  // Important to avoid hanging connections
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;
  server.requestTimeout = 60_000;

  server.listen(PORT, () => {
    console.log("✅ MRP Logistic running on port", PORT);
    console.log("✅ Storage: db.json");
  });
})();