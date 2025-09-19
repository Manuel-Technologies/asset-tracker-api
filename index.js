import express from "express";
import cors from "cors";
import helmet from "helmet";
import axios from "axios";
import yahooFinance from "yahoo-finance2";
import NodeCache from "node-cache";

// Initialize
const app = express();
const PORT = process.env.PORT || 3000;
const cache = new NodeCache({ stdTTL: 60 }); // Cache for 1 min

app.use(cors());
app.use(
  helmet({
    crossOriginResourcePolicy: false,
  })
);
app.use(express.json());

// Default tracked symbols
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

// Detect asset type from symbol
function detectAssetType(symbol) {
  if (symbol.endsWith("-USD")) return "crypto";
  if (symbol.includes("=X")) return "forex";
  return "stock";
}

// Fetch Crypto from Binance (USDT pairs only)
async function fetchBinance(symbol) {
  const binanceSymbol = symbol.replace("-USD", "USDT");
  try {
    const resp = await axios.get(
      `https://api.binance.com/api/v3/ticker/price?symbol=${binanceSymbol}`
    );
    return {
      symbol,
      name: symbol,
      price: parseFloat(resp.data.price),
      type: "crypto",
      source: "binance",
    };
  } catch (_) {
    return null;
  }
}

// Fetch Crypto from Bitget (fallback if not on Binance)
async function fetchBitget(symbol) {
  const bitgetSymbol = symbol.replace("-USD", "USDT_SPBL");
  try {
    const resp = await axios.get(
      `https://api.bitget.com/api/spot/v1/market/ticker?symbol=${bitgetSymbol}`
    );
    if (
      resp.data &&
      resp.data.code === "00000" &&
      resp.data.data &&
      resp.data.data.close
    ) {
      return {
        symbol,
        name: symbol,
        price: parseFloat(resp.data.data.close),
        type: "crypto",
        source: "bitget",
      };
    }
    return null;
  } catch (_) {
    return null;
  }
}

// Fetch Stock/Forex from Yahoo Finance
async function fetchYahoo(symbol) {
  try {
    const data = await yahooFinance.quote(symbol);
    return {
      symbol: data.symbol,
      name: data.shortName || data.symbol,
      price: data.regularMarketPrice,
      change: data.regularMarketChange,
      changePercent: data.regularMarketChangePercent,
      type: detectAssetType(symbol),
      source: "yahoo",
    };
  } catch (_) {
    return null;
  }
}

// Main asset fetcher: chooses API per asset type
async function fetchAssetData(symbols = defaultSymbols) {
  // Return cached if available and same symbols
  const cacheKey = `assets_${symbols.join(",")}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const results = [];
  for (const symbol of symbols) {
    const type = detectAssetType(symbol);
    let asset = null;
    if (type === "crypto") {
      asset = await fetchBinance(symbol);
      if (!asset) asset = await fetchBitget(symbol);
      if (asset) {
        // Add dummy change/changePercent for API compatibility
        asset.change = null;
        asset.changePercent = null;
      }
    } else {
      asset = await fetchYahoo(symbol);
    }
    if (asset) results.push(asset);
  }
  cache.set(cacheKey, results);
  return results;
}

// Root info
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
 * Optional query:
 *   - category: gainers, losers, stable
 *   - symbols: comma-separated list
 */
app.get("/api/assets", async (req, res) => {
  try {
    const { category, symbols } = req.query;
    const symbolList = symbols
      ? symbols.split(",").map((s) => s.trim().toUpperCase())
      : defaultSymbols;
    let assets = await fetchAssetData(symbolList);

    // Filter by category
    if (category === "gainers") {
      assets = assets.filter((a) => a.changePercent > 0);
    } else if (category === "losers") {
      assets = assets.filter((a) => a.changePercent < 0);
    } else if (category === "stable") {
      assets = assets.filter(
        (a) =>
          typeof a.changePercent === "number" &&
          Math.abs(a.changePercent) < 0.1
      );
    }

    res.json({
      status: "success",
      fetched_at: new Date().toISOString(),
      category: category || "all",
      total_fetched: assets.length,
      items: assets,
    });
  } catch (err) {
    res.status(500).json({
      status: "error",
      message: "Internal server error.",
    });
  }
});

/**
 * GET /api/top-gainers
 * Top 5 assets with highest % change
 */
app.get("/api/top-gainers", async (req, res) => {
  try {
    let assets = await fetchAssetData();
    assets = assets
      .filter((a) => typeof a.changePercent === "number" && a.changePercent > 0)
      .sort((a, b) => b.changePercent - a.changePercent)
      .slice(0, 5);
    res.json({
      status: "success",
      fetched_at: new Date().toISOString(),
      total_fetched: assets.length,
      items: assets,
    });
  } catch (err) {
    res.status(500).json({
      status: "error",
      message: "Internal server error.",
    });
  }
});

/**
 * GET /api/top-losers
 * Top 5 assets with lowest % change
 */
app.get("/api/top-losers", async (req, res) => {
  try {
    let assets = await fetchAssetData();
    assets = assets
      .filter((a) => typeof a.changePercent === "number" && a.changePercent < 0)
      .sort((a, b) => a.changePercent - b.changePercent)
      .slice(0, 5);
    res.json({
      status: "success",
      fetched_at: new Date().toISOString(),
      total_fetched: assets.length,
      items: assets,
    });
  } catch (err) {
    res.status(500).json({
      status: "error",
      message: "Internal server error.",
    });
  }
});

// Fallback route
app.use((req, res) => {
  res.status(404).json({ status: "error", message: "Route not found." });
});

// Start server
app.listen(PORT, () => {
  console.log(`✅ Asset Tracker API running on port ${PORT}`);
});