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

// ================= INIT =================
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "CHANGE_THIS_NOW";

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

// ================= REDIS =================
let redis;
if (process.env.REDIS_URL) {
  redis = Redis.createClient({ url: process.env.REDIS_URL });
  redis.connect().catch(() => {});
}

// ================= WEBSOCKET =================
const userSockets = new Map();
const adminSockets = new Set();

wss.on("connection", (ws) => {
  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === "user") userSockets.set(data.telegram_id, ws);
      if (data.type === "admin") adminSockets.add(ws);
    } catch {}
  });

  ws.on("close", () => {
    userSockets.forEach((value, key) => {
      if (value === ws) userSockets.delete(key);
    });
    adminSockets.delete(ws);
  });
});

function sendUserUpdate(id, payload) {
  const ws = userSockets.get(id);
  if (ws && ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify(payload));
}

// ================= DATABASE INIT =================
async function initDB() {

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT UNIQUE NOT NULL,
      username TEXT,
      coins BIGINT DEFAULT 0,
      energy INT DEFAULT 1000,
      mining_level INT DEFAULT 1,
      last_mine TIMESTAMP DEFAULT NOW(),
      referral_code TEXT UNIQUE,
      referred_by TEXT,
      vip BOOLEAN DEFAULT false,
      banned BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS upgrades (
      id SERIAL PRIMARY KEY,
      level INT,
      cost BIGINT,
      power INT
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS withdrawals (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT,
      amount FLOAT,
      wallet TEXT,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS revenue (
      id SERIAL PRIMARY KEY,
      source TEXT,
      amount FLOAT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admins (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE,
      password TEXT,
      role TEXT DEFAULT 'superadmin'
    );
  `);

  // Default upgrade levels
  const checkUpgrade = await pool.query("SELECT * FROM upgrades");
  if (!checkUpgrade.rows.length) {
    for (let i = 1; i <= 10; i++) {
      await pool.query(
        "INSERT INTO upgrades(level,cost,power) VALUES($1,$2,$3)",
        [i, i * 500, i * 10]
      );
    }
  }

  console.log("✅ DB READY");
}
initDB();

// ================= ENERGY AUTO REGEN =================
setInterval(async () => {
  await pool.query(`
    UPDATE users
    SET energy = LEAST(energy + 5, 1000)
  `);
}, 60000);

// ================= ANTI-CHEAT =================
async function canMine(user) {
  const now = Date.now();
  const lastMine = new Date(user.last_mine).getTime();
  if (now - lastMine < 1000) return false; // 1 sec cooldown
  return true;
}

// ================= USER AUTH =================
app.post("/api/user/auth", async (req, res) => {
  const { telegram_id, username, referral } = req.body;

  let user = await pool.query(
    "SELECT * FROM users WHERE telegram_id=$1",
    [telegram_id]
  );

  if (!user.rows.length) {

    const referralCode = "REF" + telegram_id;

    await pool.query(`
      INSERT INTO users(telegram_id,username,referral_code,referred_by)
      VALUES($1,$2,$3,$4)
    `, [telegram_id, username, referralCode, referral || null]);

    // Referral reward
    if (referral) {
      await pool.query(`
        UPDATE users SET coins = coins + 200
        WHERE referral_code=$1
      `, [referral]);
    }

    user = await pool.query(
      "SELECT * FROM users WHERE telegram_id=$1",
      [telegram_id]
    );
  }

  res.json(user.rows[0]);
});

// ================= TAP TO EARN =================
app.post("/api/user/mine", async (req, res) => {

  const { telegram_id } = req.body;

  const userRes = await pool.query(
    "SELECT * FROM users WHERE telegram_id=$1",
    [telegram_id]
  );

  const user = userRes.rows[0];
  if (!user) return res.json({ error: "User not found" });
  if (user.energy <= 0) return res.json({ error: "No energy" });

  const allowed = await canMine(user);
  if (!allowed) return res.json({ error: "Too fast (anti-cheat)" });

  const power = user.mining_level * 10;
  const earned = power;

  await pool.query(`
    UPDATE users
    SET coins=coins+$1,
        energy=energy-10,
        last_mine=NOW()
    WHERE telegram_id=$2
  `, [earned, telegram_id]);

  sendUserUpdate(telegram_id, { earned });

  res.json({ success: true, earned });
});

// ================= UPGRADE SHOP =================
app.post("/api/user/upgrade", async (req, res) => {
  const { telegram_id } = req.body;

  const userRes = await pool.query(
    "SELECT * FROM users WHERE telegram_id=$1",
    [telegram_id]
  );
  const user = userRes.rows[0];

  const nextLevel = user.mining_level + 1;

  const upgrade = await pool.query(
    "SELECT * FROM upgrades WHERE level=$1",
    [nextLevel]
  );

  if (!upgrade.rows.length)
    return res.json({ error: "Max level reached" });

  const cost = upgrade.rows[0].cost;

  if (user.coins < cost)
    return res.json({ error: "Not enough coins" });

  await pool.query(`
    UPDATE users
    SET coins=coins-$1,
        mining_level=mining_level+1
    WHERE telegram_id=$2
  `, [cost, telegram_id]);

  res.json({ success: true });
});

// ================= WITHDRAW =================
app.post("/api/user/withdraw", async (req, res) => {
  const { telegram_id, amount, wallet } = req.body;

  await pool.query(`
    INSERT INTO withdrawals(telegram_id,amount,wallet)
    VALUES($1,$2,$3)
  `, [telegram_id, amount, wallet]);

  res.json({ success: true });
});

// ================= ADMIN AUTH =================
function verifyAdmin(req, res, next) {
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    req.admin = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

// ================= ADMIN APPROVE WITHDRAW =================
app.post("/admin/withdraw/:id/approve", verifyAdmin, async (req, res) => {

  const id = req.params.id;

  await pool.query(`
    UPDATE withdrawals
    SET status='processed'
    WHERE id=$1
  `, [id]);

  res.json({ success: true });
});

// ================= REVENUE GRAPH =================
app.get("/admin/revenue-graph", verifyAdmin, async (req, res) => {

  const daily = await pool.query(`
    SELECT DATE(created_at) as day,
           SUM(amount) as total
    FROM revenue
    GROUP BY day
    ORDER BY day DESC
    LIMIT 7
  `);

  const weekly = await pool.query(`
    SELECT DATE_TRUNC('week', created_at) as week,
           SUM(amount) as total
    FROM revenue
    GROUP BY week
    ORDER BY week DESC
    LIMIT 4
  `);

  res.json({
    daily: daily.rows,
    weekly: weekly.rows
  });
});

// ================= START =================
server.listen(PORT, () =>
  console.log("🚀 NOTCOIN-STYLE GAME SERVER RUNNING ON", PORT)
);
