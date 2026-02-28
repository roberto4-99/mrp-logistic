const express = require("express");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, "db.json");

/* ---------- Helpers ---------- */
function nowISO(){ return new Date().toISOString(); }
function readDb(){ return JSON.parse(fs.readFileSync(DB_FILE,"utf8")); }
function writeDb(db){ fs.writeFileSync(DB_FILE, JSON.stringify(db,null,2)); }

/* ---------- Middleware ---------- */
app.use(express.json());
app.use(express.urlencoded({extended:true}));

app.use(session({
  secret: process.env.SESSION_SECRET || "mrp_secret",
  resave:false,
  saveUninitialized:false
}));

app.use("/public", express.static(path.join(__dirname,"public")));

/* ---------- Guards ---------- */
function requireAuth(req,res,next){
  const db = readDb();
  const u = db.users.find(x=>x.id===req.session.userId);
  if(!u) return res.redirect("/login");
  req.user=u; req._db=db;
  next();
}
function requireAdmin(req,res,next){
  if(!req.user.is_admin) return res.status(403).send("Forbidden");
  next();
}

/* ---------- Pages ---------- */
app.get("/login",(req,res)=>res.sendFile(path.join(__dirname,"views/login.html")));
app.get("/home",requireAuth,(req,res)=>res.sendFile(path.join(__dirname,"views/home.html")));
app.get("/admin",requireAuth,requireAdmin,(req,res)=>res.sendFile(path.join(__dirname,"views/admin.html")));
app.post("/logout",(req,res)=>req.session.destroy(()=>res.redirect("/login")));

/* ---------- LOGIN (FIXED) ---------- */
app.post("/api/login",(req,res)=>{
  const db = readDb();
  const key = String(req.body.emailOrPhone||"").trim().toLowerCase();
  const password = String(req.body.password||"");

  console.log("LOGIN TRY:", key);

  const u = db.users.find(x =>
    (x.email && x.email.toLowerCase() === key) ||
    (x.phone && x.phone === key)
  );

  console.log("FOUND USER:", !!u);

  if(!u) return res.status(400).json({ok:false,message:"بيانات غير صحيحة"});

  const ok = bcrypt.compareSync(password, u.password_hash);
  if(!ok) return res.status(400).json({ok:false,message:"بيانات غير صحيحة"});

  if(u.status!=="active")
    return res.status(403).json({ok:false,message:"الحساب غير نشط"});

  u.last_login_at = nowISO();
  writeDb(db);

  req.session.userId = u.id;
  res.json({ok:true,is_admin:!!u.is_admin});
});

/* ---------- START ---------- */
app.listen(PORT,()=>{
  console.log("✅ MRP Logistic running on port",PORT);
});