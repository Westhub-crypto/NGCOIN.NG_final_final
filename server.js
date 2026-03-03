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
const BOT_TOKEN = process.env.BOT_TOKEN || "your_bot_token_here";
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
app.use(express.static("public"));
app.use(rateLimit({ windowMs: 1000, max: 15 }));

// ===================== UPLOADS FOLDER =====================
if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => cb(null, Date.now() + "-" + Math.round(Math.random() * 1e9) + path.extname(file.originalname))
});
const upload = multer({ storage });

// ===================== DATABASE =====================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || undefined,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// ===================== INIT TABLES =====================
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users(
        id SERIAL PRIMARY KEY,
        telegram_id TEXT UNIQUE,
        email TEXT UNIQUE,
        password TEXT,
        username TEXT UNIQUE,
        name TEXT,
        country TEXT,
        phone TEXT,
        device_hash TEXT,
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
        referral_code TEXT,
        referred_by TEXT,
        referrer_id TEXT,
        referral_count INT DEFAULT 0
      );
    `);
    console.log("Tables initialized successfully.");
  } catch (err) {
    console.error("Error initializing tables:", err);
  }
})();

// ===================== VIP SETTINGS =====================
const VIP_LIMITS = { NORMAL: 100, VIP1: 1000, VIP2: 2000, VIP3: 3000, VIP4: 5000 };
const VIP_POWER = { NORMAL: 1, VIP1: 2, VIP2: 3, VIP3: 4, VIP4: 5 };

// ===================== TAP SYSTEM =====================
function fraudEngine(user, now) {
  let fraud = user.fraud_score;
  const diff = now - user.last_tap;
  if (diff < 120) fraud += 5;
  if (user.hourly_taps > VIP_LIMITS[user.vip]) fraud += 10;
  if (user.tap_count > 500000) fraud += 2;
  return fraud;
}

app.post("/api/tap", async (req, res) => {
  const { telegram_id, adWatched } = req.body;
  const result = await pool.query("SELECT * FROM users WHERE telegram_id=$1", [telegram_id]);
  if (!result.rows.length) return res.json({ error: "User not found" });
  let user = result.rows[0];
  if (user.banned) return res.json({ error: "Account banned" });

  const now = Date.now();
  if (now - user.last_tap < MINING_COOLDOWN)
    return res.json({ error: `Wait ${Math.ceil((MINING_COOLDOWN - (now - user.last_tap))/1000)}s before next tap` });
  if (now - user.hour_timestamp > 3600000) { user.hourly_taps = 0; user.hour_timestamp = now; }
  if (user.hourly_taps >= VIP_LIMITS[user.vip]) return res.json({ error: "Hourly tap limit reached" });

  let dailyBonusGiven = false;
  if (!user.last_daily_bonus || now - user.last_daily_bonus >= 86400000) {
    user.coins += DAILY_BONUS;
    dailyBonusGiven = true;
  }

  const newFraudScore = fraudEngine(user, now);
  if (newFraudScore > 80) { 
    await pool.query("UPDATE users SET banned=true WHERE telegram_id=$1", [telegram_id]); 
    return res.json({ error: "Fraud detected. Account banned." }); 
  }

  const power = VIP_POWER[user.vip];
  let adBonus = 0;
  if(adWatched) adBonus = 10 * power;

  const newCoins = user.coins + power + adBonus;
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
    newFraudScore,
    user.hourly_taps + 1,
    user.hour_timestamp,
    dailyBonusGiven ? now : user.last_daily_bonus,
    telegram_id
  ]);

  res.json({
    success: true,
    coins: newCoins,
    balance: newBalance,
    dailyBonusGiven,
    coinsPerTap: power,
    adBonus
  });
});

// ===================== FRONTEND =====================
app.get("/", (req, res) => res.sendFile(__dirname + "/frontend.html"));

// ===================== START SERVER =====================
app.listen(PORT, () => console.log(`NGCoin Mini App running on port ${PORT}`));
