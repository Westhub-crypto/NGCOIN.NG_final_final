// ========================================================
// NGCoin + Telegram Mini App Unified Server.js (Advanced + Monetag)
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
const BOT_TOKEN = process.env.BOT_TOKEN || "your_bot_token_here";
const CHANNEL_USERNAME = "@CrsWc0cl-wY4YzE0";
const ADMIN_USERNAME = "ngcointap";
const ADMIN_USERNAME_BROWSER = "westpablo01";
const ADMIN_PASSWORD_BROWSER = "@Westpablo1";
const LAUNCH_DATE = new Date("2026-12-01T00:00:00");
const REFERRAL_BONUS = 500;
const TOTAL_POOL = 10000000;
const DAILY_BONUS = 100;           // Coins per daily bonus
const MINING_COOLDOWN = 2000;      // 2 seconds cooldown per tap

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

    await pool.query(`
      CREATE TABLE IF NOT EXISTS task_submissions(
        id SERIAL PRIMARY KEY,
        task_id INT,
        telegram_id TEXT,
        proof TEXT,
        approved BOOLEAN DEFAULT false
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS payments(
        id SERIAL PRIMARY KEY,
        user_id INT REFERENCES users(id),
        amount NUMERIC,
        proof TEXT,
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_telegram ON users(telegram_id);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);`);

    console.log("All tables initialized successfully.");
  } catch (err) {
    console.error("Error initializing tables:", err);
  }
})();

// ===================== VIP LIMITS =====================
const VIP_LIMITS = { NORMAL: 100, VIP1: 1000, VIP2: 2000, VIP3: 3000, VIP4: 5000 };
const VIP_POWER = { NORMAL: 1, VIP1: 2, VIP2: 3, VIP3: 4, VIP4: 5 };

// ===================== TELEGRAM VERIFICATION =====================
function verifyTelegram(data) {
  if (!BOT_TOKEN || !data) return false;
  const secret = crypto.createHash("sha256").update(BOT_TOKEN).digest();
  const checkString = Object.keys(data)
    .filter((key) => key !== "hash")
    .sort()
    .map((key) => `${key}=${data[key]}`)
    .join("\n");
  const hmac = crypto.createHmac("sha256", secret).update(checkString).digest("hex");
  return hmac === data.hash;
}

// ===================== DEVICE HASH =====================
function generateDeviceHash(req) {
  return crypto.createHash("sha256").update(req.headers["user-agent"] + req.ip).digest("hex");
}

// ===================== CHANNEL VERIFICATION =====================
async function verifyChannel(telegram_id) {
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember`;
    const response = await axios.post(url, { chat_id: CHANNEL_USERNAME, user_id: telegram_id });
    const status = response.data.result.status;
    return status === "member" || status === "administrator" || status === "creator";
  } catch (err) {
    return false;
  }
}

// ===================== FRAUD ENGINE =====================
function fraudEngine(user, now) {
  let fraud = user.fraud_score;
  const diff = now - user.last_tap;
  if (diff < 120) fraud += 5;
  if (user.hourly_taps > VIP_LIMITS[user.vip]) fraud += 10;
  if (user.tap_count > 500000) fraud += 2;
  return fraud;
}

// ===================== HEALTH CHECK =====================
app.get("/api", (req, res) => res.json({ status: "Server running" }));

// ===================== USER REGISTRATION =====================
app.post("/api/register", async (req, res) => {
  try {
    const { telegramData, email, password, username, referral_code, name, country, phone, ref } = req.body;
    let deviceHash = generateDeviceHash(req);

    if (telegramData) {
      if (!verifyTelegram(telegramData)) return res.json({ error: "Telegram verification failed" });
      const existingDevice = await pool.query("SELECT * FROM users WHERE device_hash=$1", [deviceHash]);
      if (existingDevice.rows.length) return res.json({ error: "One device per user allowed" });

      await pool.query(
        `INSERT INTO users 
        (telegram_id, username, name, country, phone, device_hash, referrer_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [telegramData.id, telegramData.username, name, country, phone, deviceHash, ref || null]
      );

      if (ref) await pool.query(`UPDATE users SET coins = coins + $1, referral_count = referral_count + 1 WHERE telegram_id = $2`, [REFERRAL_BONUS, ref]);

      return res.json({ success: true });
    }

    if (email && password && username) {
      const hashedPassword = await bcrypt.hash(password, 10);
      const result = await pool.query(
        "INSERT INTO users (telegram_id, email, password, username, referred_by) VALUES ($1,$2,$3,$4,$5) RETURNING *",
        [null, email, hashedPassword, username, referral_code || null]
      );
      return res.json({ success: true, user: result.rows[0] });
    }

    res.json({ error: "Invalid registration data" });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ===================== USER LOGIN =====================
app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const userRes = await pool.query("SELECT * FROM users WHERE email=$1", [email]);
    if (!userRes.rows.length) return res.status(404).json({ success: false, message: "User not found" });
    const user = userRes.rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ success: false, message: "Incorrect password" });
    res.json({ success: true, user });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

// ===================== TAP SYSTEM =====================
app.post("/api/tap", async (req, res) => {
  const { telegram_id } = req.body;
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
  if (!user.last_daily_bonus || now - user.last_daily_bonus >= 86400000) { user.coins += DAILY_BONUS; dailyBonusGiven = true; }

  const newFraudScore = fraudEngine(user, now);
  if (newFraudScore > 80) { await pool.query("UPDATE users SET banned=true WHERE telegram_id=$1", [telegram_id]); return res.json({ error: "Fraud detected. Account banned." }); }

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
    newFraudScore,
    user.hourly_taps + 1,
    user.hour_timestamp,
    dailyBonusGiven ? now : user.last_daily_bonus,
    telegram_id
  ]);

  const coinsPerHour = VIP_POWER[user.vip] * Math.min(user.hourly_taps + 1, VIP_LIMITS[user.vip]);
  const projectedDaily = coinsPerHour * 24;
  const projectedWeekly = projectedDaily * 7;

  res.json({
    success: true,
    coins: newCoins,
    balance: newBalance,
    dailyBonusGiven,
    coinsPerTap: power,
    projection: { daily: projectedDaily, weekly: projectedWeekly }
  });
});

// ===================== TASKS =====================
app.get("/api/tasks", async (req, res) => {
  const { vip } = req.query;
  let query = "SELECT * FROM tasks WHERE active=true";
  if (vip === "true") query += " AND is_vip=true";
  const tasks = await pool.query(query);
  res.json(tasks.rows);
});

app.post("/api/tasks/submit", async (req, res) => {
  const { telegram_id, task_id, proof } = req.body;
  await pool.query("INSERT INTO task_submissions(task_id, telegram_id, proof) VALUES($1,$2,$3)", [task_id, telegram_id, proof]);
  res.json({ success: true });
});

// ===================== PAYMENTS =====================
app.post("/api/payment", upload.single("proof"), async (req, res) => {
  const { user_id, amount } = req.body;
  const proof = req.file ? req.file.filename : null;
  const result = await pool.query("INSERT INTO payments(user_id, amount, proof) VALUES($1,$2,$3) RETURNING *", [user_id, amount, proof]);
  res.json({ success: true, payment: result.rows[0] });
});

app.post("/api/withdraw", async (req, res) => {
  const { telegram_id } = req.body;
  const now = new Date();
  if (now < LAUNCH_DATE) return res.json({ error: "NGCoin launches December 1, 2026" });
  res.json({ message: "Withdrawal fee ₦10,000 required. Contact @" + ADMIN_USERNAME });
});

// ===================== ADMIN BROWSER =====================
app.post("/api/admin/activate-vip", async (req, res) => {
  const { username, level, password } = req.body;
  if (username !== ADMIN_USERNAME_BROWSER || password !== ADMIN_PASSWORD_BROWSER) return res.json({ error: "Not authorized" });
  await pool.query("UPDATE users SET vip=$1 WHERE username=$2", [level, username]);
  res.json({ success: true });
});

app.post("/api/admin/ban", async (req, res) => {
  const { username, password } = req.body;
  if (username !== ADMIN_USERNAME_BROWSER || password !== ADMIN_PASSWORD_BROWSER) return res.json({ error: "Not authorized" });
  await pool.query("UPDATE users SET banned=true WHERE username=$1", [username]);
  res.json({ success: true });
});

// ===================== LEADERBOARD =====================
app.get("/api/leaderboard", async (req, res) => {
  const result = await pool.query("SELECT username, coins FROM users ORDER BY coins DESC LIMIT 20");
  res.json(result.rows);
});

// ===================== COUNTDOWN =====================
app.get("/api/countdown", (req, res) => {
  const now = new Date();
  const diff = LAUNCH_DATE - now;
  if (diff <= 0) return res.json({ launched: true });
  res.json({ launched: false, time: diff });
});

// ===================== FRONTEND WITH MONETAG SDK =====================
app.get("/", (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>NGCoin Mini App</title>
  <!-- Monetag SDK -->
  <script src='//libtl.com/sdk.js' data-zone='10677338' data-sdk='show_10677338'></script>
</head>
<body>
  <h1>Welcome to NGCoin Mini App</h1>

  <button onclick="showRewarded()">Watch Rewarded Ad</button>
  <button onclick="showPopup()">Rewarded Popup</button>
  <button onclick="showInApp()">In-App Interstitial</button>

  <script>
    function showRewarded() {
      show_10677338().then(() => {
        alert('You have seen an ad!');
      });
    }

    function showPopup() {
      show_10677338('pop').then(() => {
        alert('Popup ad completed!');
      }).catch(e => {});
    }

    function showInApp() {
      show_10677338({
        type: 'inApp',
        inAppSettings: {
          frequency: 2,
          capping: 0.1,
          interval: 30,
          timeout: 5,
          everyPage: false
        }
      });
    }
  </script>
</body>
</html>
  `);
});

// ===================== START SERVER =====================
app.listen(PORT, () => console.log(`NGCoin Mini App running on port ${PORT}`));
