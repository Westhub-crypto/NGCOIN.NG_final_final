// ========================================================
// NGCoin Telegram Mini App - Production Server.js
// ========================================================

const express = require("express");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const axios = require("axios");
const rateLimit = require("express-rate-limit");
const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_USERNAME = "@CrsWc0cl-wY4YzE0";
const ADMIN_USERNAME_BROWSER = "westpablo01";
const ADMIN_PASSWORD_BROWSER = "@Westpablo1";
const LAUNCH_DATE = new Date("2026-12-01T00:00:00");

const REFERRAL_BONUS = 500;
const TOTAL_POOL = 10000000;
const DAILY_BONUS = 100;
const MINING_COOLDOWN = 2000;

// ===================== MIDDLEWARE =====================
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cors());
app.use(rateLimit({ windowMs: 1000, max: 20 }));

// Serve static files from public folder
app.use(express.static(path.join(__dirname, "public")));

// ===================== UPLOADS =====================
if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) =>
    cb(null, Date.now() + "-" + Math.round(Math.random() * 1e9) + path.extname(file.originalname))
});
const upload = multer({ storage });

// ===================== DATABASE =====================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// ===================== INIT TABLES =====================
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users(
        id SERIAL PRIMARY KEY,
        telegram_id TEXT UNIQUE,
        username TEXT UNIQUE,
        email TEXT UNIQUE,
        password TEXT,
        vip TEXT DEFAULT 'NORMAL',
        coins BIGINT DEFAULT 0,
        balance NUMERIC DEFAULT 0,
        banned BOOLEAN DEFAULT false,
        fraud_score INT DEFAULT 0,
        tap_count INT DEFAULT 0,
        last_tap BIGINT DEFAULT 0,
        hourly_taps INT DEFAULT 0,
        hour_timestamp BIGINT DEFAULT 0,
        last_daily_bonus BIGINT DEFAULT 0,
        referral_count INT DEFAULT 0
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS tasks(
        id SERIAL PRIMARY KEY,
        title TEXT,
        description TEXT,
        reward NUMERIC,
        is_vip BOOLEAN DEFAULT false,
        active BOOLEAN DEFAULT true
      );
    `);

    console.log("Database initialized successfully.");
  } catch (err) {
    console.error("Database error:", err);
  }
})();

// ===================== VIP CONFIG =====================
const VIP_LIMITS = { NORMAL: 100, VIP1: 1000, VIP2: 2000, VIP3: 3000, VIP4: 5000 };
const VIP_POWER = { NORMAL: 1, VIP1: 2, VIP2: 3, VIP3: 4, VIP4: 5 };

// ===================== HEALTH =====================
app.get("/api", (req, res) => {
  res.json({ status: "NGCoin server running" });
});

// ===================== REGISTER =====================
app.post("/api/register", async (req, res) => {
  try {
    const { telegram_id, username } = req.body;

    const exists = await pool.query("SELECT * FROM users WHERE telegram_id=$1", [telegram_id]);
    if (exists.rows.length) return res.json({ success: true });

    await pool.query(
      "INSERT INTO users (telegram_id, username) VALUES ($1,$2)",
      [telegram_id, username || null]
    );

    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ===================== TAP SYSTEM =====================
function fraudEngine(user, now) {
  let fraud = user.fraud_score;
  if (now - user.last_tap < 120) fraud += 5;
  if (user.hourly_taps > VIP_LIMITS[user.vip]) fraud += 10;
  return fraud;
}

app.post("/api/tap", async (req, res) => {
  const { telegram_id } = req.body;

  const result = await pool.query("SELECT * FROM users WHERE telegram_id=$1", [telegram_id]);
  if (!result.rows.length) return res.json({ error: "User not found" });

  let user = result.rows[0];
  if (user.banned) return res.json({ error: "Account banned" });

  const now = Date.now();

  if (now - user.last_tap < MINING_COOLDOWN)
    return res.json({ error: "Wait before tapping again" });

  if (now - user.hour_timestamp > 3600000) {
    user.hourly_taps = 0;
    user.hour_timestamp = now;
  }

  if (user.hourly_taps >= VIP_LIMITS[user.vip])
    return res.json({ error: "Hourly tap limit reached" });

  let dailyBonusGiven = false;
  if (!user.last_daily_bonus || now - user.last_daily_bonus >= 86400000) {
    user.coins += DAILY_BONUS;
    dailyBonusGiven = true;
  }

  const fraud = fraudEngine(user, now);
  if (fraud > 80) {
    await pool.query("UPDATE users SET banned=true WHERE telegram_id=$1", [telegram_id]);
    return res.json({ error: "Fraud detected" });
  }

  const power = VIP_POWER[user.vip];
  const newCoins = user.coins + power;
  const newBalance = (newCoins / 100000000) * TOTAL_POOL;

  await pool.query(`
    UPDATE users SET
      coins=$1,
      balance=$2,
      tap_count=tap_count+1,
      last_tap=$3,
      fraud_score=$4,
      hourly_taps=$5,
      hour_timestamp=$6,
      last_daily_bonus=$7
    WHERE telegram_id=$8
  `, [
    newCoins,
    newBalance,
    now,
    fraud,
    user.hourly_taps + 1,
    user.hour_timestamp,
    dailyBonusGiven ? now : user.last_daily_bonus,
    telegram_id
  ]);

  res.json({
    success: true,
    coins: newCoins,
    balance: newBalance,
    coinsPerTap: power,
    dailyBonusGiven
  });
});

// ===================== TASKS =====================
app.get("/api/tasks", async (req, res) => {
  const tasks = await pool.query("SELECT * FROM tasks WHERE active=true");
  res.json(tasks.rows);
});

// ===================== LEADERBOARD =====================
app.get("/api/leaderboard", async (req, res) => {
  const top = await pool.query("SELECT username, coins FROM users ORDER BY coins DESC LIMIT 20");
  res.json(top.rows);
});

// ===================== WITHDRAW =====================
app.post("/api/withdraw", async (req, res) => {
  const now = new Date();
  if (now < LAUNCH_DATE)
    return res.json({ error: "Launch date not reached" });

  res.json({ message: "Contact admin for withdrawal" });
});

// ===================== ROOT SERVE FRONTEND =====================
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "frontend.html"));
});

// ===================== START =====================
app.listen(PORT, () => {
  console.log("NGCoin Mini App running on port " + PORT);
});
