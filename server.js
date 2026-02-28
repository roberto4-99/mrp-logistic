const express = require("express");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = process.env.PORT || 3000;

const DB_FILE = path.join(__dirname, "db.json");

// ---------- Helpers ----------
function nowISO() { return new Date().toISOString(); }
function readDb() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({
      settings: {
        app_name: "MRP Logistic",
        usd_to_points: 10,
        min_deposit_usd: 5,
        min_withdraw_usd: 10,
        manager_contact: { title: "تواصل مع المدير لإتمام العملية", whatsapp: "+212619692685", telegram: "@MRP_Manager" }
      },
      users: [],
      wallet_transactions: [],
      tasks: [],
      user_tasks: [],
      task_runs: []
    }, null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}
function writeDb(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf8"); }

function parseUsd(v) {
  const x = Number(String(v ?? "").replace(",", ".").trim());
  return (Number.isFinite(x) && x > 0) ? x : 0;
}
function usdToPoints(db, usd) {
  const rate = Number(db.settings?.usd_to_points ?? 10);
  return Math.floor(usd * rate);
}

function ensureAdmin(db) {
  if (db.users.find(u => u.is_admin)) return;
  db.users.push({
    id: uuidv4(),
    full_name: "Admin",
    email: "admin@mrp.local",
    phone: null,
    password_hash: bcrypt.hashSync("admin12345", 10),
    points_balance: 0,
    is_admin: true,
    status: "active",
    created_at: nowISO(),
    last_login_at: null
  });
}

function ensureUserTasks(db, userId) {
  const tasks = (db.tasks || []).filter(t => t.is_active).sort((a, b) => a.order_index - b.order_index);

  db.user_tasks = db.user_tasks || [];
  for (const t of tasks) {
    const exists = db.user_tasks.find(x => x.user_id === userId && x.task_id === t.id);
    if (!exists) {
      db.user_tasks.push({
        id: uuidv4(),
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

function syncLocks(db, userId) {
  ensureUserTasks(db, userId);
  const tasks = (db.tasks || []).filter(t => t.is_active).sort((a, b) => a.order_index - b.order_index);

  const uts = tasks.map(t => ({
    t,
    ut: db.user_tasks.find(x => x.user_id === userId && x.task_id === t.id)
  }));

  const anyAvailable = uts.some(x => x.ut?.status === "available");
  const allCompleted = uts.every(x => x.ut?.status === "completed");

  if (!anyAvailable && !allCompleted) {
    const firstNot = uts.find(x => x.ut && x.ut.status !== "completed");
    if (firstNot?.ut) firstNot.ut.status = "available";
  }

  let seenAvailable = false;
  for (const x of uts) {
    if (!x.ut) continue;
    if (x.ut.status === "completed") continue;

    if (x.ut.status === "available") {
      if (!seenAvailable) seenAvailable = true;
      else x.ut.status = "locked";
      continue;
    }
    if (!seenAvailable) x.ut.status = "locked";
  }
}

function resetUserProgress(db, userId) {
  ensureUserTasks(db, userId);
  const tasks = (db.tasks || []).filter(t => t.is_active).sort((a, b) => a.order_index - b.order_index);

  for (const t of tasks) {
    const ut = db.user_tasks.find(x => x.user_id === userId && x.task_id === t.id);
    if (!ut) continue;
    ut.status = (t.order_index === 1) ? "available" : "locked";
    ut.started_at = null;
    ut.completed_at = null;
    ut.earned_points = 0;
  }

  // expire running
  db.task_runs = db.task_runs || [];
  for (const r of db.task_runs) {
    if (r.user_id === userId && r.status === "running") {
      r.status = "expired";
      r.finished_at = nowISO();
    }
  }
}

// ---------- Init ----------
(function init() {
  const db = readDb();
  db.settings = db.settings || {};
  db.settings.app_name = db.settings.app_name || "MRP Logistic";
  db.settings.usd_to_points = Number(db.settings.usd_to_points ?? 10);
  db.settings.min_deposit_usd = Number(db.settings.min_deposit_usd ?? 5);
  db.settings.min_withdraw_usd = Number(db.settings.min_withdraw_usd ?? 10);
  db.settings.manager_contact = db.settings.manager_contact || {
    title: "تواصل مع المدير لإتمام العملية", whatsapp: "+212600000000", telegram: "@MRP_Manager"
  };

  db.tasks = db.tasks || [];
  ensureAdmin(db);

  for (const u of db.users) {
    if (!u.is_admin) {
      ensureUserTasks(db, u.id);
      syncLocks(db, u.id);
    }
  }
  writeDb(db);

  console.log("✅ Admin created (if not existed): admin@mrp.local / admin12345");
})();

// ---------- Middleware ----------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || "mrp_secret_change_me",
  resave: false,
  saveUninitialized: false
}));

app.use("/public", express.static(path.join(__dirname, "public")));

// ---------- Auth Guards ----------
function requireAuth(req, res, next) {
  const db = readDb();
  const user = db.users.find(u => u.id === req.session.userId);
  if (!user || user.status !== "active") return res.redirect("/login");
  req._db = db;
  req.user = user;
  next();
}
function requireAdmin(req, res, next) {
  if (!req.user?.is_admin) return res.status(403).send("Forbidden");
  next();
}

// ---------- Pages ----------
app.get("/", (req, res) => res.redirect("/home"));
app.get("/login", (req, res) => res.sendFile(path.join(__dirname, "views/login.html")));
app.get("/register", (req, res) => res.sendFile(path.join(__dirname, "views/register.html")));
app.get("/home", requireAuth, (req, res) => res.sendFile(path.join(__dirname, "views/home.html")));
app.get("/tasks", requireAuth, (req, res) => res.sendFile(path.join(__dirname, "views/tasks.html")));
app.get("/profile", requireAuth, (req, res) =>
  res.sendFile(path.join(__dirname, "views/profile.html"))
);
app.get("/admin", requireAuth, requireAdmin, (req, res) =>
  res.sendFile(path.join(__dirname, "views/admin.html"))
);
app.post("/logout", (req, res) =>
  req.session.destroy(() => res.redirect("/login"))
);

// ---------- Auth APIs ----------
app.post("/api/register", (req, res) => {
  const db = readDb();
  const { full_name, email, phone, password } = req.body;

  const pw = String(password || "").trim();
  if (pw.length < 6) return res.status(400).json({ ok: false, message: "كلمة المرور 6 أحرف على الأقل." });
  if (!email && !phone) return res.status(400).json({ ok: false, message: "أدخل البريد أو الهاتف." });

  const keyEmail = email ? String(email).trim() : null;
  const keyPhone = phone ? String(phone).trim() : null;

  const exists = db.users.find(u =>
    (keyEmail && u.email === keyEmail) || (keyPhone && u.phone === keyPhone)
  );
  if (exists) return res.status(400).json({ ok: false, message: "الحساب موجود." });

  const user = {
    id: uuidv4(),
    full_name: (full_name || "").trim() || null,
    email: keyEmail,
    phone: keyPhone,
    password_hash: bcrypt.hashSync(pw, 10),
    points_balance: 0,
    is_admin: false,
    status: "active",
    created_at: nowISO(),
    last_login_at: null
  };
  db.users.push(user);

  ensureUserTasks(db, user.id);
  resetUserProgress(db, user.id);
  writeDb(db);

  res.json({ ok: true });
});

/**
 * ✅ FIXED LOGIN
 * - case-insensitive email matching
 * - supports multiple possible field names from frontend
 * - keeps phone matching exact
 */
app.post("/api/login", (req, res) => {
  const db = readDb();

  // دعم أكثر من اسم للـ field (باش ما نطيحوش فمشكل front)
  const emailOrPhone =
    req.body.emailOrPhone ??
    req.body.emailOrPhoneInput ??
    req.body.identifier ??
    req.body.email ??
    req.body.phone;

  const password = req.body.password;

  const keyRaw = String(emailOrPhone || "").trim();
  const pw = String(password || "");

  if (!keyRaw || !pw) {
    return res.status(400).json({ ok: false, message: "أدخل البريد/الهاتف وكلمة المرور." });
  }

  const keyLower = keyRaw.toLowerCase();

  const u = db.users.find(x =>
    (x.email && String(x.email).trim().toLowerCase() === keyLower) ||
    (x.phone && String(x.phone).trim() === keyRaw)
  );

  if (!u) return res.status(400).json({ ok: false, message: "بيانات غير صحيحة." });

  if (u.status !== "active") {
    return res.status(403).json({ ok: false, message: "الحساب غير نشط." });
  }

  const ok = bcrypt.compareSync(pw, u.password_hash);
  if (!ok) return res.status(400).json({ ok: false, message: "بيانات غير صحيحة." });

  u.last_login_at = nowISO();
  writeDb(db);

  req.session.userId = u.id;
  res.json({ ok: true, is_admin: !!u.is_admin });
});

// ---------- Me ----------
app.get("/api/me", requireAuth, (req, res) => {
  const db = req._db;

  if (!req.user.is_admin) {
    ensureUserTasks(db, req.user.id);
    syncLocks(db, req.user.id);
    writeDb(db);
  }

  const activeTasks = (db.tasks || []).filter(t => t.is_active).sort((a, b) => a.order_index - b.order_index);
  const done = (db.user_tasks || []).filter(x => x.user_id === req.user.id && x.status === "completed").length;

  res.json({
    ok: true,
    app: { name: db.settings.app_name },
    user: {
      id: req.user.id,
      full_name: req.user.full_name,
      points_balance: req.user.points_balance,
      is_admin: !!req.user.is_admin
    },
    settings: db.settings,
    tasks: { total: activeTasks.length, done }
  });
});

// ---------- Wallet: request deposit/withdraw (pending) ----------
app.post("/api/wallet/request", requireAuth, (req, res) => {
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
    id: uuidv4(),
    user_id: req.user.id,
    type,
    amount_usd: usd,
    rate_usd_to_points: Number(db.settings.usd_to_points ?? 10),
    points_delta: type === "deposit" ? points : -points,
    status: "pending",
    created_at: nowISO(),
    processed_at: null
  });

  writeDb(db);
  res.json({ ok: true, message: "تم إرسال الطلب. تواصل مع المدير لإتمام العملية.", manager: db.settings.manager_contact });
});

app.get("/api/wallet/my", requireAuth, (req, res) => {
  const db = req._db;
  const rows = (db.wallet_transactions || [])
    .filter(x => x.user_id === req.user.id)
    .slice(-30)
    .reverse();
  res.json({ ok: true, rows });
});

// ---------- Tasks (User) ----------
app.get("/api/tasks", requireAuth, (req, res) => {
  const db = req._db;
  ensureUserTasks(db, req.user.id);
  syncLocks(db, req.user.id);

  const rows = (db.tasks || [])
    .filter(t => t.is_active)
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

  writeDb(db);
  res.json({ ok: true, rows });
});

app.post("/api/tasks/start", requireAuth, (req, res) => {
  const db = req._db;
  ensureUserTasks(db, req.user.id);
  syncLocks(db, req.user.id);

  const available = (db.user_tasks || [])
    .filter(x => x.user_id === req.user.id && x.status === "available")
    .map(x => ({ ut: x, t: (db.tasks || []).find(tt => tt.id === x.task_id) }))
    .filter(x => x.t && x.t.is_active)
    .sort((a, b) => a.t.order_index - b.t.order_index);

  const pick = available[0];
  if (!pick) return res.status(400).json({ ok: false, message: "لا توجد مهمة جاهزة." });

  db.task_runs = db.task_runs || [];
  const running = db.task_runs.find(r => r.user_id === req.user.id && r.status === "running");
  if (running) return res.status(400).json({ ok: false, message: "هناك مهمة قيد التنفيذ." });

  const token = uuidv4();
  const expected = Date.now() + (pick.t.wait_seconds * 1000);

  db.task_runs.push({
    id: uuidv4(),
    user_id: req.user.id,
    task_id: pick.t.id,
    run_token: token,
    started_at: nowISO(),
    expected_finish_ms: expected,
    finished_at: null,
    status: "running"
  });

  writeDb(db);
  res.json({ ok: true, run_token: token, wait_seconds: pick.t.wait_seconds });
});

app.post("/api/tasks/finish", requireAuth, (req, res) => {
  const db = req._db;
  ensureUserTasks(db, req.user.id);

  const { run_token } = req.body;
  const run = (db.task_runs || []).find(r => r.run_token === run_token && r.user_id === req.user.id && r.status === "running");
  if (!run) return res.status(400).json({ ok: false, message: "جلسة غير صالحة." });

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

  const next = (db.tasks || []).find(t => t.is_active && t.order_index === task.order_index + 1);
  if (next) {
    const nextUT = (db.user_tasks || []).find(x => x.user_id === req.user.id && x.task_id === next.id);
    if (nextUT && nextUT.status === "locked") nextUT.status = "available";
  }

  req.user.points_balance += task.reward_points;

  run.status = "completed";
  run.finished_at = nowISO();

  writeDb(db);
  res.json({ ok: true, message: "لقد اكتملت المهمة ✅ وتمت إضافة المكافأة." });
});

// ---------- ADMIN: Pending Requests ----------
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

app.post("/api/admin/requests/:id/approve", requireAuth, requireAdmin, (req, res) => {
  const db = req._db;
  const id = req.params.id;

  const row = (db.wallet_transactions || []).find(x => x.id === id && x.status === "pending");
  if (!row) return res.status(400).json({ ok: false, message: "طلب غير صالح." });

  const u = db.users.find(uu => uu.id === row.user_id);
  if (!u) return res.status(400).json({ ok: false, message: "مستخدم غير موجود." });

  u.points_balance += row.points_delta;
  row.status = "approved";
  row.processed_at = nowISO();

  writeDb(db);
  res.json({ ok: true });
});

app.post("/api/admin/requests/:id/reject", requireAuth, requireAdmin, (req, res) => {
  const db = req._db;
  const id = req.params.id;

  const row = (db.wallet_transactions || []).find(x => x.id === id && x.status === "pending");
  if (!row) return res.status(400).json({ ok: false, message: "طلب غير صالح." });

  row.status = "rejected";
  row.processed_at = nowISO();

  writeDb(db);
  res.json({ ok: true });
});

// ---------- ADMIN: Users ----------
app.get("/api/admin/users", requireAuth, requireAdmin, (req, res) => {
  const db = req._db;
  const rows = db.users.filter(u => !u.is_admin).slice(-300).reverse();
  res.json({ ok: true, rows });
});

app.post("/api/admin/users/:id/points", requireAuth, requireAdmin, (req, res) => {
  const db = req._db;
  const userId = req.params.id;
  const points = Number(req.body.points);

  if (!Number.isFinite(points) || points < 0) return res.status(400).json({ ok: false, message: "نقاط غير صالحة." });

  const u = db.users.find(x => x.id === userId && !x.is_admin);
  if (!u) return res.status(400).json({ ok: false, message: "مستخدم غير موجود." });

  u.points_balance = Math.floor(points);
  writeDb(db);
  res.json({ ok: true });
});

// ✅ NEW: Reset password for ONE user
app.post("/api/admin/users/:id/password", requireAuth, requireAdmin, (req, res) => {
  const db = req._db;
  const userId = req.params.id;

  const new_password = String(req.body.new_password || "").trim();
  if (new_password.length < 6) {
    return res.status(400).json({ ok: false, message: "كلمة المرور 6 أحرف على الأقل." });
  }

  const u = db.users.find(x => x.id === userId && !x.is_admin);
  if (!u) return res.status(400).json({ ok: false, message: "مستخدم غير موجود." });

  u.password_hash = bcrypt.hashSync(new_password, 10);
  writeDb(db);

  return res.json({ ok: true });
});

// Reset tasks for ONE user (send 5 tasks again from the start)
app.post("/api/admin/users/:id/reset-tasks", requireAuth, requireAdmin, (req, res) => {
  const db = req._db;
  const userId = req.params.id;

  const u = db.users.find(x => x.id === userId && !x.is_admin);
  if (!u) return res.status(404).json({ ok: false, message: "مستخدم غير موجود." });

  resetUserProgress(db, userId);

  writeDb(db);
  res.json({ ok: true });
});

// ---------- ADMIN: Settings ----------
app.get("/api/admin/settings", requireAuth, requireAdmin, (req, res) => {
  const db = req._db;
  res.json({ ok: true, settings: db.settings });
});

app.post("/api/admin/settings", requireAuth, requireAdmin, (req, res) => {
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

  if (req.body.whatsapp) db.settings.manager_contact.whatsapp = String(req.body.whatsapp);
  if (req.body.telegram) db.settings.manager_contact.telegram = String(req.body.telegram);

  writeDb(db);
  res.json({ ok: true });
});

// ---------- ADMIN: Tasks ----------
app.get("/api/admin/tasks", requireAuth, requireAdmin, (req, res) => {
  const db = req._db;
  const rows = (db.tasks || []).sort((a, b) => a.order_index - b.order_index);
  res.json({ ok: true, rows });
});

app.post("/api/admin/tasks/create", requireAuth, requireAdmin, (req, res) => {
  const db = req._db;

  const title = String(req.body.title || "").trim();
  const reward_points = Number(req.body.reward_points);
  const wait_seconds = Number(req.body.wait_seconds);

  if (!title) return res.status(400).json({ ok: false, message: "العنوان مطلوب" });
  if (!Number.isFinite(reward_points) || reward_points < 0) return res.status(400).json({ ok: false, message: "reward غير صالح" });
  if (!Number.isFinite(wait_seconds) || wait_seconds < 1) return res.status(400).json({ ok: false, message: "wait غير صالح" });

  const maxOrder = (db.tasks || []).length ? Math.max(...db.tasks.map(t => t.order_index)) : 0;
  const task = {
    id: (db.tasks || []).length ? (Math.max(...db.tasks.map(t => t.id)) + 1) : 1,
    title,
    order_index: maxOrder + 1,
    reward_points: Math.floor(reward_points),
    wait_seconds: Math.floor(wait_seconds),
    is_active: true
  };

  db.tasks.push(task);

  // Add to users
  for (const u of db.users) {
    if (!u.is_admin) {
      ensureUserTasks(db, u.id);
      syncLocks(db, u.id);
    }
  }

  writeDb(db);
  res.json({ ok: true, task });
});

app.post("/api/admin/tasks/:id/update", requireAuth, requireAdmin, (req, res) => {
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

  // Sync users
  for (const u of db.users) {
    if (!u.is_admin) {
      ensureUserTasks(db, u.id);
      syncLocks(db, u.id);
    }
  }

  writeDb(db);
  res.json({ ok: true });
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`✅ MRP Logistic running on: http://localhost:${PORT}`);
});