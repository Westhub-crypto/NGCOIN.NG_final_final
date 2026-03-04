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

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET || "SUPER_SECRET_CHANGE_THIS";

// ================= DATABASE =================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ================= RATE LIMIT =================
app.use("/api/", rateLimit({
  windowMs: 60 * 1000,
  max: 200
}));

// ================= WEBSOCKET =================
const adminClients = new Set();

wss.on("connection", (ws) => {
  ws.on("message", (msg) => {
    try {
      const data = JSON.parse(msg);

      if (data.admin === true) {
        adminClients.add(ws);
      }
    } catch {}
  });

  ws.on("close", () => {
    adminClients.delete(ws);
  });
});

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
      vip BOOLEAN DEFAULT false,
      banned BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW()
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
      amount FLOAT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  console.log("✅ Database Ready");
}
initDB();

// ================= USER AUTH =================
app.post("/api/user/auth", async (req, res) => {
  const { telegram_id, username } = req.body;

  let user = await pool.query(
    "SELECT * FROM users WHERE telegram_id=$1",
    [telegram_id]
  );

  if (!user.rows.length) {
    await pool.query(
      "INSERT INTO users(telegram_id, username) VALUES($1,$2)",
      [telegram_id, username]
    );

    user = await pool.query(
      "SELECT * FROM users WHERE telegram_id=$1",
      [telegram_id]
    );
  }

  res.json(user.rows[0]);
});

// ================= TAP =================
app.post("/api/user/mine", async (req, res) => {

  const { telegram_id } = req.body;

  const userRes = await pool.query(
    "SELECT * FROM users WHERE telegram_id=$1",
    [telegram_id]
  );

  const user = userRes.rows[0];
  if (!user) return res.json({ error: "User not found" });

  if (user.energy <= 0)
    return res.json({ error: "No energy" });

  const earned = user.mining_level * 10;

  await pool.query(`
    UPDATE users
    SET coins = coins + $1,
        energy = energy - 10
    WHERE telegram_id=$2
  `, [earned, telegram_id]);

  const updated = await pool.query(
    "SELECT coins, energy FROM users WHERE telegram_id=$1",
    [telegram_id]
  );

  res.json(updated.rows[0]);
});

// ================= LEADERBOARD =================
app.get("/api/leaderboard", async (req, res) => {
  const top = await pool.query(`
    SELECT username, coins
    FROM users
    ORDER BY coins DESC
    LIMIT 10
  `);
  res.json(top.rows);
});

// ================= ADMIN ANALYTICS =================
async function broadcastAdminStats() {
  try {

    const totalUsers = await pool.query("SELECT COUNT(*) FROM users");
    const activeUsers = await pool.query("SELECT COUNT(*) FROM users WHERE energy > 0");
    const bannedUsers = await pool.query("SELECT COUNT(*) FROM users WHERE banned = true");
    const totalCoins = await pool.query("SELECT COALESCE(SUM(coins),0) FROM users");
    const vipUsers = await pool.query("SELECT COUNT(*) FROM users WHERE vip = true");
    const avgMiningLevel = await pool.query("SELECT COALESCE(AVG(mining_level),0) FROM users");
    const pendingWithdrawals = await pool.query("SELECT COUNT(*) FROM withdrawals WHERE status='pending'");
    const processedWithdrawals = await pool.query("SELECT COUNT(*) FROM withdrawals WHERE status='processed'");
    const totalProfit = await pool.query("SELECT COALESCE(SUM(amount),0) FROM revenue");

    const payload = {
      totalUsers: parseInt(totalUsers.rows[0].count),
      activeUsers: parseInt(activeUsers.rows[0].count),
      bannedUsers: parseInt(bannedUsers.rows[0].count),
      totalCoins: parseInt(totalCoins.rows[0].coalesce),
      totalTokens: 0,
      totalAirdrops: 0,
      totalPresaleTokens: 0,
      vipUsers: parseInt(vipUsers.rows[0].count),
      avgMiningLevel: parseFloat(avgMiningLevel.rows[0].coalesce).toFixed(2),
      pendingWithdrawals: parseInt(pendingWithdrawals.rows[0].count),
      processedWithdrawals: parseInt(processedWithdrawals.rows[0].count),
      totalProfit: parseFloat(totalProfit.rows[0].coalesce)
    };

    adminClients.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
      }
    });

  } catch (err) {
    console.error("Admin broadcast error:", err.message);
  }
}

setInterval(broadcastAdminStats, 5000);

// ================= START =================
server.listen(PORT, () =>
  console.log("🚀 NGCoin Server Running On", PORT)
);
