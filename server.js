// ========================================================
// NGCoin Production System - FULL server.js
// ========================================================

const express = require("express");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const axios = require("axios");
const rateLimit = require("express-rate-limit");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_USERNAME = "@CrsWc0cl-wY4YzE0"; // channel username
const ADMIN_USERNAME = "ngcointap";
const LAUNCH_DATE = new Date("2026-12-01T00:00:00");
const REFERRAL_BONUS = 500;
const TOTAL_POOL = 10000000;

app.use(bodyParser.json());
app.use(rateLimit({ windowMs: 1000, max: 15 }));

// ================= DATABASE =================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ================= INIT TABLES =================
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users(
        id SERIAL PRIMARY KEY,
        telegram_id TEXT UNIQUE,
        username TEXT UNIQUE,
        name TEXT,
        country TEXT,
        phone TEXT,
        device_hash TEXT,
        vip TEXT DEFAULT 'NORMAL',
        coins BIGINT DEFAULT 0,
        banned BOOLEAN DEFAULT false,
        fraud_score INT DEFAULT 0,
        tap_count INT DEFAULT 0,
        last_tap BIGINT DEFAULT 0,
        hourly_taps INT DEFAULT 0,
        hour_timestamp BIGINT DEFAULT 0,
        referrer_id TEXT,
        referral_count INT DEFAULT 0
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS tasks(
        id SERIAL PRIMARY KEY,
        title TEXT,
        reward INT,
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

    console.log("All tables initialized successfully.");
  } catch (err) {
    console.error("Error initializing tables:", err);
  }
})();

// ================= VIP LIMITS =================
const VIP_LIMITS = {
  NORMAL: 100,
  VIP1: 1000,
  VIP2: 2000,
  VIP3: 3000,
  VIP4: 5000,
};

const VIP_POWER = {
  NORMAL: 1,
  VIP1: 2,
  VIP2: 3,
  VIP3: 4,
  VIP4: 5,
};

// ================= TELEGRAM VERIFICATION =================
function verifyTelegram(data) {
  const secret = crypto.createHash("sha256").update(BOT_TOKEN).digest();
  const checkString = Object.keys(data)
    .filter((key) => key !== "hash")
    .sort()
    .map((key) => `${key}=${data[key]}`)
    .join("\n");
  const hmac = crypto.createHmac("sha256", secret).update(checkString).digest("hex");
  return hmac === data.hash;
}

// ================= DEVICE FINGERPRINT =================
function generateDeviceHash(req) {
  return crypto.createHash("sha256").update(req.headers["user-agent"] + req.ip).digest("hex");
}

// ================= CHANNEL VERIFICATION =================
async function verifyChannel(telegram_id) {
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember`;
    const response = await axios.post(url, {
      chat_id: CHANNEL_USERNAME,
      user_id: telegram_id,
    });
    const status = response.data.result.status;
    return status === "member" || status === "administrator" || status === "creator";
  } catch (err) {
    return false;
  }
}

// ================= FRAUD AI ENGINE =================
function fraudEngine(user, now) {
  let fraud = user.fraud_score;
  const diff = now - user.last_tap;
  if (diff < 120) fraud += 5; // too fast
  if (user.hourly_taps > VIP_LIMITS[user.vip]) fraud += 10;
  if (user.tap_count > 500000) fraud += 2;
  return fraud;
}

// ================= REGISTER =================
app.post("/api/register", async (req, res) => {
  const { telegramData, name, country, phone, ref } = req.body;

  if (!verifyTelegram(telegramData)) return res.json({ error: "Telegram verification failed" });

  const deviceHash = generateDeviceHash(req);

  const existingDevice = await pool.query("SELECT * FROM users WHERE device_hash=$1", [deviceHash]);
  if (existingDevice.rows.length) return res.json({ error: "One device per user allowed" });

  await pool.query(
    `INSERT INTO users 
       (telegram_id, username, name, country, phone, device_hash, referrer_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [telegramData.id, telegramData.username, name, country, phone, deviceHash, ref || null]
  );

  if (ref) {
    await pool.query(
      `UPDATE users 
       SET coins = coins + $1, referral_count = referral_count + 1
       WHERE telegram_id = $2`,
      [REFERRAL_BONUS, ref]
    );
  }

  res.json({ success: true });
});

// ================= TAP =================
app.post("/api/tap", async (req, res) => {
  const { telegram_id } = req.body;
  const result = await pool.query("SELECT * FROM users WHERE telegram_id=$1", [telegram_id]);
  if (!result.rows.length) return res.json({ error: "User not found" });

  let user = result.rows[0];
  if (user.banned) return res.json({ error: "Account banned" });

  const joined = await verifyChannel(telegram_id);
  if (!joined) return res.json({ error: "Join channel first" });

  const now = Date.now();
  if (now - user.hour_timestamp > 3600000) {
    user.hourly_taps = 0;
    user.hour_timestamp = now;
  }
  if (user.hourly_taps >= VIP_LIMITS[user.vip]) return res.json({ error: "Hourly tap limit reached" });

  const newFraudScore = fraudEngine(user, now);
  if (newFraudScore > 80) {
    await pool.query("UPDATE users SET banned=true WHERE telegram_id=$1", [telegram_id]);
    return res.json({ error: "Fraud detected. Account banned." });
  }

  const power = VIP_POWER[user.vip];
  await pool.query(
    `UPDATE users SET
       coins = coins + $1,
       tap_count = tap_count + 1,
       last_tap = $2,
       fraud_score = $3,
       hourly_taps = $4,
       hour_timestamp = $5
       WHERE telegram_id = $6`,
    [power, now, newFraudScore, user.hourly_taps + 1, user.hour_timestamp, telegram_id]
  );

  const updated = await pool.query("SELECT coins FROM users WHERE telegram_id=$1", [telegram_id]);
  const coins = updated.rows[0].coins;
  const naira = (coins / 100000000) * TOTAL_POOL;

  res.json({ coins, naira });
});

// ================= COUNTDOWN =================
app.get("/api/countdown", (req, res) => {
  const now = new Date();
  const diff = LAUNCH_DATE - now;
  if (diff <= 0) return res.json({ launched: true });
  res.json({ launched: false, time: diff });
});

// ================= ADMIN DASHBOARD =================
app.post("/api/admin/login", async (req, res) => {
  const { telegramData } = req.body;
  if (!verifyTelegram(telegramData)) return res.json({ error: "Telegram verification failed" });
  if (telegramData.username !== ADMIN_USERNAME) return res.json({ error: "Not authorized" });
  res.json({ success: true });
});

app.post("/api/admin/activate-vip", async (req, res) => {
  const { username, level } = req.body;
  if (!VIP_LIMITS[level]) return res.json({ error: "Invalid VIP level" });
  await pool.query("UPDATE users SET vip=$1 WHERE username=$2", [level, username]);
  res.json({ success: true });
});

app.post("/api/admin/ban", async (req, res) => {
  const { username } = req.body;
  await pool.query("UPDATE users SET banned=true WHERE username=$1", [username]);
  res.json({ success: true });
});

// ================= TASK SYSTEM =================
app.post("/api/admin/add-task", async (req, res) => {
  const { title, reward } = req.body;
  await pool.query("INSERT INTO tasks(title, reward) VALUES($1,$2)", [title, reward]);
  res.json({ success: true });
});

app.get("/api/tasks", async (req, res) => {
  const result = await pool.query("SELECT * FROM tasks WHERE active=true");
  res.json(result.rows);
});

app.post("/api/tasks/submit", async (req, res) => {
  const { telegram_id, task_id, proof } = req.body;
  await pool.query(
    `INSERT INTO task_submissions(task_id, telegram_id, proof)
       VALUES($1,$2,$3)`,
    [task_id, telegram_id, proof]
  );
  res.json({ success: true });
});

app.post("/api/admin/approve-task", async (req, res) => {
  const { submission_id } = req.body;
  const submission = await pool.query("SELECT * FROM task_submissions WHERE id=$1", [submission_id]);
  if (!submission.rows.length) return res.json({ error: "Submission not found" });

  const task = await pool.query("SELECT reward FROM tasks WHERE id=$1", [submission.rows[0].task_id]);
  const reward = task.rows[0].reward;

  await pool.query("UPDATE users SET coins=coins+$1 WHERE telegram_id=$2", [
    reward,
    submission.rows[0].telegram_id,
  ]);

  await pool.query("UPDATE task_submissions SET approved=true WHERE id=$1", [submission_id]);
  res.json({ success: true });
});

// ================= WITHDRAW SYSTEM =================
app.post("/api/withdraw", async (req, res) => {
  const { telegram_id } = req.body;
  const now = new Date();
  if (now < LAUNCH_DATE)
    return res.json({ error: "NGCoin launches December 1, 2026" });

  const result = await pool.query("SELECT coins FROM users WHERE telegram_id=$1", [telegram_id]);
  if (!result.rows.length) return res.json({ error: "User not found" });

  res.json({ message: "Withdrawal fee ₦10,000 required. Contact @" + ADMIN_USERNAME });
});

// ================= LEADERBOARD =================
app.get("/api/leaderboard", async (req, res) => {
  const result = await pool.query("SELECT username, coins FROM users ORDER BY coins DESC LIMIT 20");
  res.json(result.rows);
});

// ================= FRONTEND =================
app.get("/", async (req, res) => {
  res.sendFile(__dirname + "/frontend.html"); // You can separate HTML if needed
});

app.listen(PORT, () => console.log(`NGCoin Mini App running on port ${PORT}`));
