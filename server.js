require("dotenv").config();
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const path = require("path");
const http = require("http");
const WebSocket = require("ws");
const Redis = require("redis");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ================= CONFIG =================
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "SUPER_SECRET_KEY_CHANGE_THIS";

// ================= RATE LIMIT =================
app.use("/api/", rateLimit({
  windowMs: 60 * 1000,
  max: 200
}));

// ================= DATABASE =================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ================= REDIS (Safe Initialization) =================
let redis;
if (process.env.REDIS_URL) {
  redis = Redis.createClient({ url: process.env.REDIS_URL });
  redis.on("error", (err) => console.warn("Redis error:", err.message));
  redis.connect()
    .then(() => console.log("✅ Redis connected"))
    .catch((err) => console.warn("Redis failed to connect:", err.message));
} else {
  console.log("⚠️ No REDIS_URL provided. Skipping Redis connection");
}

async function setRedis(key, value, expireSeconds = 60) {
  if (!redis) return;
  try {
    if (expireSeconds) await redis.set(key, value, { EX: expireSeconds });
    else await redis.set(key, value);
  } catch (err) {
    console.warn("Redis set failed:", err.message);
  }
}

async function getRedis(key) {
  if (!redis) return null;
  try { return await redis.get(key); }
  catch (err) { console.warn("Redis get failed:", err.message); return null; }
}

// ================= WEBSOCKET =================
const clients = new Map();
const adminClients = new Set();

wss.on("connection", (ws) => {
  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.telegram_id) clients.set(data.telegram_id, ws);
      if (data.admin === true) adminClients.add(ws);
    } catch (e) { console.warn("WS parse error:", e.message); }
  });

  ws.on("close", () => {
    clients.forEach((value, key) => { if (value === ws) clients.delete(key); });
    adminClients.delete(ws);
  });
});

function sendLiveUpdate(telegram_id, payload) {
  const ws = clients.get(telegram_id);
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

async function broadcastAdminUpdate() {
  try {
    // safe queries
    const [
      totalUsersRes, activeUsersRes, bannedUsersRes, totalCoinsRes, totalTokensRes,
      airdropsRes, presaleRes, vipRes, avgMiningRes,
      pendingWithdrawalsRes, processedWithdrawalsRes
    ] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM users'),
      pool.query('SELECT COUNT(*) FROM users WHERE "energy">0'),
      pool.query('SELECT COUNT(*) FROM users WHERE banned=true'),
      pool.query('SELECT SUM(coins) FROM users'),
      pool.query('SELECT SUM("cryptoBalance") FROM users'),
      pool.query('SELECT COUNT(*) FROM airdrops'),
      pool.query('SELECT SUM(tokens) FROM presales'),
      pool.query('SELECT COUNT(*) FROM users WHERE vip=true'),
      pool.query('SELECT AVG(mining_level) FROM users'),
      pool.query("SELECT COUNT(*) FROM withdrawals WHERE status='pending'"),
      pool.query("SELECT COUNT(*) FROM withdrawals WHERE status='processed'")
    ]);

    const totalProfit = (parseInt(totalCoinsRes.rows[0].sum||0)/1000) + parseFloat(totalTokensRes.rows[0].sum||0);

    const payload = {
      totalUsers: parseInt(totalUsersRes.rows[0].count),
      activeUsers: parseInt(activeUsersRes.rows[0].count),
      bannedUsers: parseInt(bannedUsersRes.rows[0].count),
      totalCoins: parseInt(totalCoinsRes.rows[0].sum || 0),
      totalTokens: parseFloat(totalTokensRes.rows[0].sum || 0),
      totalAirdrops: parseInt(airdropsRes.rows[0].count || 0),
      totalPresaleTokens: parseFloat(presaleRes.rows[0].sum || 0),
      vipUsers: parseInt(vipRes.rows[0].count || 0),
      avgMiningLevel: parseFloat(avgMiningRes.rows[0].avg || 0),
      pendingWithdrawals: parseInt(pendingWithdrawalsRes.rows[0].count || 0),
      processedWithdrawals: parseInt(processedWithdrawalsRes.rows[0].count || 0),
      totalProfit
    };

    adminClients.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
    });

  } catch(err) {
    console.error("Admin broadcast error:", err.message);
  }
}
setInterval(broadcastAdminUpdate, 10000);

// ================= INIT TABLES =================
async function initDB() {
  // users table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT UNIQUE NOT NULL,
      username TEXT,
      coins BIGINT DEFAULT 0,
      "cryptoBalance" FLOAT DEFAULT 0,
      "energy" INT DEFAULT 1000,
      mining_level INT DEFAULT 1,
      vip BOOLEAN DEFAULT false,
      referral_code TEXT UNIQUE,
      referred_by TEXT,
      banned BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // alter existing table if missing columns
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS "energy" INT DEFAULT 1000;`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS "cryptoBalance" FLOAT DEFAULT 0;`);

  // other tables
  await pool.query(`
    CREATE TABLE IF NOT EXISTS withdrawals (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT,
      amount BIGINT,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS airdrops (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT,
      amount FLOAT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS presales (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT,
      tokens FLOAT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admins (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE,
      password TEXT
    );
  `);

  const adminCheck = await pool.query("SELECT * FROM admins WHERE username=$1", ["westpablo01"]);
  if (!adminCheck.rows.length) {
    const hashed = await bcrypt.hash("@Westpablo1", 10);
    await pool.query("INSERT INTO admins (username,password) VALUES ($1,$2)", ["westpablo01", hashed]);
  }
}
initDB();

// ===================== ADMIN AUTH =====================
function verifyAdmin(req,res,next){
  const token = req.headers.authorization;
  if(!token) return res.status(401).json({error:"Unauthorized"});
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.admin = decoded;
    next();
  } catch {
    res.status(401).json({error:"Invalid token"});
  }
}

app.post("/admin/login", async (req,res)=>{
  const { username,password } = req.body;
  const admin = await pool.query("SELECT * FROM admins WHERE username=$1", [username]);
  if(!admin.rows.length) return res.json({error:"Admin not found"});
  const valid = await bcrypt.compare(password, admin.rows[0].password);
  if(!valid) return res.json({error:"Wrong password"});
  const token = jwt.sign({id:admin.rows[0].id}, JWT_SECRET, {expiresIn:"7d"});
  res.json({success:true, token});
});

// ===================== ADMIN PROFIT ANALYTICS =====================
app.get("/admin/profit", verifyAdmin, async (req,res)=>{
  try{
    const [
      totalUsersRes, activeUsersRes, bannedUsersRes, totalCoinsRes, totalTokensRes,
      airdropsRes, presaleRes, vipRes, avgMiningRes,
      pendingWithdrawalsRes, processedWithdrawalsRes
    ] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM users'),
      pool.query('SELECT COUNT(*) FROM users WHERE "energy">0'),
      pool.query('SELECT COUNT(*) FROM users WHERE banned=true'),
      pool.query('SELECT SUM(coins) FROM users'),
      pool.query('SELECT SUM("cryptoBalance") FROM users'),
      pool.query('SELECT COUNT(*) FROM airdrops'),
      pool.query('SELECT SUM(tokens) FROM presales'),
      pool.query('SELECT COUNT(*) FROM users WHERE vip=true'),
      pool.query('SELECT AVG(mining_level) FROM users'),
      pool.query("SELECT COUNT(*) FROM withdrawals WHERE status='pending'"),
      pool.query("SELECT COUNT(*) FROM withdrawals WHERE status='processed'")
    ]);

    const totalProfit = (parseInt(totalCoinsRes.rows[0].sum||0)/1000) + parseFloat(totalTokensRes.rows[0].sum||0);

    res.json({
      totalUsers: parseInt(totalUsersRes.rows[0].count),
      activeUsers: parseInt(activeUsersRes.rows[0].count),
      bannedUsers: parseInt(bannedUsersRes.rows[0].count),
      totalCoins: parseInt(totalCoinsRes.rows[0].sum || 0),
      totalTokens: parseFloat(totalTokensRes.rows[0].sum || 0),
      totalAirdrops: parseInt(airdropsRes.rows[0].count || 0),
      totalPresaleTokens: parseFloat(presaleRes.rows[0].sum || 0),
      vipUsers: parseInt(vipRes.rows[0].count || 0),
      avgMiningLevel: parseFloat(avgMiningRes.rows[0].avg || 0),
      pendingWithdrawals: parseInt(pendingWithdrawalsRes.rows[0].count || 0),
      processedWithdrawals: parseInt(processedWithdrawalsRes.rows[0].count || 0),
      totalProfit
    });
  }catch(err){
    res.status(500).json({error:err.message});
  }
});

// ================= SERVE INDEX.HTML =================
app.get("/", (req,res)=>{
  const indexPath = path.join(__dirname, "public", "index.html");
  res.sendFile(indexPath, (err)=>{
    if(err){
      console.error("Failed to serve index.html:", err.message);
      res.status(500).send("Server error");
    }
  });
});

// ================= SERVER START =================
server.listen(PORT, ()=>console.log("🚀 ULTRA PRODUCTION SERVER RUNNING ON", PORT));
