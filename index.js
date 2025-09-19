import express from "express";
import cors from "cors";
import helmet from "helmet";
import yahooFinance from "yahoo-finance2";
import NodeCache from "node-cache";

const app = express();
const PORT = process.env.PORT || 3000;

// Cache data for 1 minute to avoid rate limits
const cache = new NodeCache({ stdTTL: 60 });

app.use(cors());
app.use(
  helmet({
    crossOriginResourcePolicy: false, // allows frontend access
  })
);
app.use(express.json());

// Default symbol list (expandable)
const defaultSymbols = [
  // Crypto
  "BTC-USD",
  "ETH-USD",
  "SOL-USD",
  "DOGE-USD",
  "ADA-USD",
  // Stocks
  "AAPL",
  "TSLA",
  "MSFT",
  "GOOGL",
  "AMZN",
  "NVDA",
  // Forex
  "EURUSD=X",
  "GBPUSD=X",
  "USDJPY=X",
];

/**
 * Fetches asset data from Yahoo Finance in chunks to avoid rate-limit issues.
 * Supports caching and dynamic symbol input.
 */
async function fetchAssetData(symbols = defaultSymbols) {
  // Return cached data if available
  const cached = cache.get("assets");
  if (cached) return cached;

  const chunkSize = 50; // break large symbol arrays into batches
  const results = [];

  for (let i = 0; i < symbols.length; i += chunkSize) {
    const chunk = symbols.slice(i, i + chunkSize);
    try {
      const data = await yahooFinance.quote(chunk);
      // yahooFinance.quote returns array for multiple symbols, object for single
      results.push(...(Array.isArray(data) ? data : [data]));
    } catch (err) {
      console.error("❌ Error fetching chunk:", chunk, err.message);
    }
  }

  // Normalize data
  const assets = results.map((item) => ({
    symbol: item.symbol,
    name: item.shortName || item.symbol,
    price: item.regularMarketPrice,
    change: item.regularMarketChange,
    changePercent: item.regularMarketChangePercent,
    type: detectAssetType(item.symbol),
  }));

  cache.set("assets", assets);
  return assets;
}

/**
 * Simple helper to detect asset type based on symbol pattern.
 */
function detectAssetType(symbol) {
  if (symbol.includes("-USD")) return "crypto";
  if (symbol.includes("=X")) return "forex";
  return "stock";
}

// Root route
app.get("/", (req, res) => {
  res.json({
    status: "running",
    message: "📊 Asset Tracker API is live",
    available_routes: [
      "/api/assets",
      "/api/assets?category=gainers",
      "/api/assets?symbols=BTC-USD,TSLA,EURUSD=X",
      "/api/top-gainers",
      "/api/top-losers",
    ],
  });
});

/**
 * GET /api/assets
 * Fetches all assets, supports filtering by category and custom symbols.
 */
app.get("/api/assets", async (req, res) => {
  const { category, symbols } = req.query;

  const symbolList = symbols ? symbols.split(",") : defaultSymbols;
  const assets = await fetchAssetData(symbolList);

  if (!assets.length) {
    return res.status(200).json({
      status: "partial",
      message: "⚠️ Could not fetch data from Yahoo Finance.",
      items: [],
    });
  }

  let filtered = assets;
  if (category === "gainers") {
    filtered = assets.filter((a) => a.changePercent > 0);
  } else if (category === "losers") {
    filtered = assets.filter((a) => a.changePercent < 0);
  } else if (category === "stable") {
    filtered = assets.filter((a) => Math.abs(a.changePercent) < 0.1);
  }

  res.json({
    status: "success",
    fetched_at: new Date().toISOString(),
    category: category || "all",
    total_fetched: filtered.length,
    items: filtered,
  });
});

/**
 * GET /api/top-gainers
 * Returns top 5 assets with highest % change
 */
app.get("/api/top-gainers", async (req, res) => {
  const assets = await fetchAssetData();
  const sorted = [...assets]
    .filter((a) => a.changePercent > 0)
    .sort((a, b) => b.changePercent - a.changePercent)
    .slice(0, 5);

  res.json({
    status: "success",
    fetched_at: new Date().toISOString(),
    total_fetched: sorted.length,
    items: sorted,
  });
});

/**
 * GET /api/top-losers
 * Returns top 5 assets with lowest % change
 */
app.get("/api/top-losers", async (req, res) => {
  const assets = await fetchAssetData();
  const sorted = [...assets]
    .filter((a) => a.changePercent < 0)
    .sort((a, b) => a.changePercent - b.changePercent)
    .slice(0, 5);

  res.json({
    status: "success",
    fetched_at: new Date().toISOString(),
    total_fetched: sorted.length,
    items: sorted,
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`✅ Asset Tracker API running on port ${PORT}`);
});