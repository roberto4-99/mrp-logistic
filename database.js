const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const db = new sqlite3.Database(
  path.join(__dirname, "mrp.db"),
  (err) => {
    if (err) {
      console.error("❌ DB error:", err.message);
    } else {
      console.log("✅ SQLite connected");
    }
  }
);

// USERS TABLE
db.run(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  full_name TEXT,
  email TEXT UNIQUE,
  phone TEXT UNIQUE,
  password_hash TEXT,
  points_balance INTEGER DEFAULT 0,
  is_admin INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active',
  created_at TEXT,
  last_login_at TEXT
)
`);

module.exports = db;