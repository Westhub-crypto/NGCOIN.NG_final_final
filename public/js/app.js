// Connect to WebSocket
const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
const ws = new WebSocket(`${protocol}://${location.host}`);

// Dashboard card IDs
const cardIds = [
  "totalUsers", "activeUsers", "bannedUsers", "totalCoins", "totalTokens",
  "totalAirdrops", "totalPresaleTokens", "vipUsers", "avgMiningLevel",
  "pendingWithdrawals", "processedWithdrawals", "totalProfit"
];

// Chart.js datasets
let timeLabels = []; // timestamps
let coinsData = [];
let tokensData = [];
let miningData = [];

const maxPoints = 20; // max points on chart

// Initialize charts
const coinsChart = new Chart(document.getElementById("coinsChart"), {
  type: "line",
  data: {
    labels: timeLabels,
    datasets: [{
      label: "Coins",
      data: coinsData,
      borderColor: "#4cafee",
      backgroundColor: "rgba(76, 175, 238, 0.2)",
      tension: 0.3,
      fill: true
    }]
  },
  options: {
    responsive: true,
    plugins: { legend: { labels: { color: "#fff" } } },
    scales: {
      x: { ticks: { color: "#fff" }, grid: { color: "#333" } },
      y: { ticks: { color: "#fff" }, grid: { color: "#333" } }
    }
  }
});

const tokensChart = new Chart(document.getElementById("tokensChart"), {
  type: "line",
  data: {
    labels: timeLabels,
    datasets: [{
      label: "Tokens",
      data: tokensData,
      borderColor: "#ff9800",
      backgroundColor: "rgba(255, 152, 0, 0.2)",
      tension: 0.3,
      fill: true
    }]
  },
  options: coinsChart.options
});

const miningChart = new Chart(document.getElementById("miningChart"), {
  type: "line",
  data: {
    labels: timeLabels,
    datasets: [{
      label: "Avg Mining Level",
      data: miningData,
      borderColor: "#4caf50",
      backgroundColor: "rgba(76, 175, 80, 0.2)",
      tension: 0.3,
      fill: true
    }]
  },
  options: coinsChart.options
});

// WebSocket events
ws.onopen = () => console.log("✅ WebSocket connected");
ws.onclose = () => console.log("⚠️ WebSocket disconnected");

ws.onmessage = (msg) => {
  try {
    const data = JSON.parse(msg.data);

    // Update dashboard cards
    cardIds.forEach(key => {
      const el = document.getElementById(key);
      if (el && data[key] !== undefined) el.textContent = data[key];
    });

    // Update charts
    const now = new Date().toLocaleTimeString();
    if (timeLabels.length >= maxPoints) {
      timeLabels.shift();
      coinsData.shift();
      tokensData.shift();
      miningData.shift();
    }
    timeLabels.push(now);
    coinsData.push(data.totalCoins || 0);
    tokensData.push(data.totalTokens || 0);
    miningData.push(data.avgMiningLevel || 0);

    coinsChart.update();
    tokensChart.update();
    miningChart.update();

  } catch (e) {
    console.warn("WebSocket message parse error:", e.message);
  }
};
