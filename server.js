const express = require("express");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const { v4: uuidv4 } = require("uuid");
const db = require("./database");
const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, "db.json");

/* ---------- Helpers ---------- */
function nowISO() {
  return new Date().toISOString();
}

function ensureDbFile() {
  if (!fs.existsSync(DB_FILE)) {
    const init = {
      settings: {
        app_name: "MRP Logistic",
        usd_to_points: 10,
        min_deposit_usd: 5,
        min_withdraw_usd: 10,
        manager_contact: {
          title: "تواصل مع المدير لإتمام العملية",
          whatsapp: "+212619692685",
          telegram: "@MRP_Manager",
        },
      },
      users: [],
      wallet_transactions: [],
      tasks: [],
      user_tasks: [],
      task_runs: [],
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(init, null, 2), "utf8");
  }
}

function readDb() {
  ensureDbFile();
  return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}

function writeDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf8");
}

function ensureAdmin(db) {
  const exists = (db.users || []).some((u) => u.is_admin === true);
  if (exists) return;

  db.users = db.users || [];
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
    last_login_at: null,
  });
}

/* ---------- Init ---------- */
(function init() {
  const db = readDb();
  db.settings = db.settings || {};
  db.users = db.users || [];
  db.wallet_transactions = db.wallet_transactions || [];
  db.tasks = db.tasks || [];
  db.user_tasks = db.user_tasks || [];
  db.task_runs = db.task_runs || [];

  ensureAdmin(db);
  writeDb(db);

  console.log("✅ Admin ensured: admin@mrp.local / admin12345");
})();

/* ---------- Middleware ---------- */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "mrp_secret_change_me",
    resave: false,
    saveUninitialized: false,
  })
);

app.use("/public", express.static(path.join(__dirname, "public")));

/* ---------- Guards ---------- */
function requireAuth(req, res, next) {
  const db = readDb();
  const u = (db.users || []).find((x) => x.id === req.session.userId);
  if (!u || u.status !== "active") return res.redirect("/login");
  req.user = u;
  req._db = db;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user?.is_admin) return res.status(403).send("Forbidden");
  next();
}

/* ---------- Pages ---------- */
app.get("/", (req, res) => res.redirect("/login"));

app.get("/login", (req, res) =>
  res.sendFile(path.join(__dirname, "views/login.html"))
);

app.get("/register", (req, res) =>
  res.sendFile(path.join(__dirname, "views/register.html"))
);

app.get("/home", requireAuth, (req, res) =>
  res.sendFile(path.join(__dirname, "views/home.html"))
);

app.get("/tasks", requireAuth, (req, res) =>
  res.sendFile(path.join(__dirname, "views/tasks.html"))
);

app.get("/profile", requireAuth, (req, res) =>
  res.sendFile(path.join(__dirname, "views/profile.html"))
);

app.get("/admin", requireAuth, requireAdmin, (req, res) =>
  res.sendFile(path.join(__dirname, "views/admin.html"))
);

app.post("/logout", (req, res) =>
  req.session.destroy(() => res.redirect("/login"))
);

/* ---------- AUTH APIs ---------- */
app.post("/api/register", (req, res) => {
  const db = readDb();
  const { full_name, email, phone, password } = req.body;

  const pw = String(password || "").trim();
  if (pw.length < 6) {
    return res.status(400).json({ ok: false, message: "كلمة المرور 6 أحرف على الأقل." });
  }

  const keyEmail = email ? String(email).trim() : "";
  const keyPhone = phone ? String(phone).trim() : "";

  if (!keyEmail && !keyPhone) {
    return res.status(400).json({ ok: false, message: "أدخل البريد أو الهاتف." });
  }

  const exists = (db.users || []).find(
    (u) =>
      (keyEmail && u.email && u.email.toLowerCase() === keyEmail.toLowerCase()) ||
      (keyPhone && u.phone === keyPhone)
  );

  if (exists) {
    return res.status(400).json({ ok: false, message: "الحساب موجود." });
  }

  const user = {
    id: uuidv4(),
    full_name: String(full_name || "").trim() || null,
    email: keyEmail || null,
    phone: keyPhone || null,
    password_hash: bcrypt.hashSync(pw, 10),
    points_balance: 0,
    is_admin: false,
    status: "active",
    created_at: nowISO(),
    last_login_at: null,
  };

  db.users.push(user);
  writeDb(db);

  return res.json({ ok: true });
});

app.post("/api/login", (req, res) => {
  const db = readDb();
  const keyRaw = String(req.body.emailOrPhone || "").trim();
  const password = String(req.body.password || "");

  const keyLower = keyRaw.toLowerCase();

  const u = (db.users || []).find((x) => {
    const emailOk = x.email && String(x.email).toLowerCase() === keyLower;
    const phoneOk = x.phone && String(x.phone).trim() === keyRaw; // الهاتف حساس للـ lower
    return emailOk || phoneOk;
  });

  if (!u) return res.status(400).json({ ok: false, message: "بيانات غير صحيحة." });

  const ok = bcrypt.compareSync(password, u.password_hash);
  if (!ok) return res.status(400).json({ ok: false, message: "بيانات غير صحيحة." });

  if (u.status !== "active") {
    return res.status(403).json({ ok: false, message: "الحساب غير نشط." });
  }

  u.last_login_at = nowISO();
  writeDb(db);

  req.session.userId = u.id;
  return res.json({ ok: true, is_admin: !!u.is_admin });
});

app.get("/api/me", requireAuth, (req, res) => {
  const db = req._db;
  res.json({
    ok: true,
    app: { name: db.settings?.app_name || "MRP Logistic" },
    user: {
      id: req.user.id,
      full_name: req.user.full_name,
      points_balance: req.user.points_balance,
      is_admin: !!req.user.is_admin,
    },
  });
});

/* ---------- Debug (اختياري) ---------- */
app.get("/test", (req, res) => res.send("SERVER UPDATED ✅"));

/* ---------- START ---------- */
app.listen(PORT, () => {
  console.log("✅ MRP Logistic running on port", PORT);
});