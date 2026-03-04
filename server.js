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
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;

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
const redis = Redis.createClient({
  url: process.env.REDIS_URL
});
redis.connect();

// ================= WEBSOCKET =================
const clients = new Map();

wss.on("connection", (ws) => {
  ws.on("message", (msg) => {
    const data = JSON.parse(msg);
    if (data.telegram_id) {
      clients.set(data.telegram_id, ws);
    }
  });

  ws.on("close", () => {
    clients.forEach((value, key) => {
      if (value === ws) clients.delete(key);
    });
  });
});

function sendLiveUpdate(telegram_id, payload) {
  const ws = clients.get(telegram_id);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

// ================= INIT TABLES =================
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT UNIQUE NOT NULL,
      username TEXT,
      coins BIGINT DEFAULT 0,
      energy INT DEFAULT 1000,
      mining_level INT DEFAULT 1,
      referral_code TEXT UNIQUE,
      referred_by TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS withdrawals (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT,
      amount BIGINT,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
}
initDB();

// ================= REGISTER =================
app.post("/api/register", async (req, res) => {
  const { telegram_id, username, referral } = req.body;

  let user = await pool.query(
    "SELECT * FROM users WHERE telegram_id=$1",
    [telegram_id]
  );

  if (user.rows.length === 0) {
    const referral_code = "REF" + telegram_id;

    await pool.query(
      `INSERT INTO users (telegram_id, username, referral_code, referred_by)
       VALUES ($1,$2,$3,$4)`,
      [telegram_id, username, referral_code, referral || null]
    );

    if (referral) {
      await pool.query(
        "UPDATE users SET coins = coins + 1000 WHERE referral_code=$1",
        [referral]
      );
    }
  }

  const updated = await pool.query(
    "SELECT coins, energy, mining_level FROM users WHERE telegram_id=$1",
    [telegram_id]
  );

  res.json(updated.rows[0]);
});

// ================= TAP (REDIS BOOSTED) =================
app.post("/api/tap", async (req, res) => {
  const { telegram_id } = req.body;

  const user = await pool.query(
    "SELECT coins, energy, mining_level FROM users WHERE telegram_id=$1",
    [telegram_id]
  );
  if (!user.rows.length) return res.json({ error: "User not found" });

  let { coins, energy, mining_level } = user.rows[0];
  if (energy <= 0) return res.json({ error: "No energy" });

  const reward = mining_level;
  coins += reward;
  energy -= 1;

  await pool.query(
    "UPDATE users SET coins=$1, energy=$2 WHERE telegram_id=$3",
    [coins, energy, telegram_id]
  );

  await redis.set(`user:${telegram_id}:coins`, coins);

  sendLiveUpdate(telegram_id, { coins, energy });

  res.json({ coins, energy, reward });
});

// ================= LEADERBOARD =================
app.get("/api/leaderboard", async (req, res) => {
  const cached = await redis.get("leaderboard");
  if (cached) return res.json(JSON.parse(cached));

  const top = await pool.query(
    "SELECT username, coins FROM users ORDER BY coins DESC LIMIT 50"
  );

  await redis.set("leaderboard", JSON.stringify(top.rows), {
    EX: 60
  });

  res.json(top.rows);
});

// ================= MINING UPGRADE =================
app.post("/api/upgrade", async (req, res) => {
  const { telegram_id } = req.body;

  const user = await pool.query(
    "SELECT coins, mining_level FROM users WHERE telegram_id=$1",
    [telegram_id]
  );

  let { coins, mining_level } = user.rows[0];
  const cost = mining_level * 5000;

  if (coins < cost) return res.json({ error: "Not enough coins" });

  mining_level += 1;
  coins -= cost;

  await pool.query(
    "UPDATE users SET coins=$1, mining_level=$2 WHERE telegram_id=$3",
    [coins, mining_level, telegram_id]
  );

  res.json({ coins, mining_level });
});

// ================= WITHDRAW =================
app.post("/api/withdraw", async (req, res) => {
  const { telegram_id, amount } = req.body;

  const user = await pool.query(
    "SELECT coins FROM users WHERE telegram_id=$1",
    [telegram_id]
  );

  if (user.rows[0].coins < amount)
    return res.json({ error: "Insufficient balance" });

  await pool.query(
    "UPDATE users SET coins=coins-$1 WHERE telegram_id=$2",
    [amount, telegram_id]
  );

  await pool.query(
    "INSERT INTO withdrawals (telegram_id, amount) VALUES ($1,$2)",
    [telegram_id, amount]
  );

  res.json({ success: true });
});

// ================= SERVER START =================
server.listen(PORT, () => {
  console.log("🚀 ULTRA PRODUCTION SERVER RUNNING ON", PORT);
});
