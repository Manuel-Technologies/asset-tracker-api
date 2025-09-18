import express from "express";
import cors from "cors";
import helmet from "helmet";
import axios from "axios";
import yahooFinance from "yahoo-finance2";
import NodeCache from "node-cache";

const app = express();
const PORT = process.env.PORT || 3000;

// Cache data for 1 minute to avoid rate limits
const cache = new NodeCache({ stdTTL: 60 });

app.use(cors());
app.use(helmet());
app.use(express.json());

// Default root route
app.get("/", (req, res) => {
  res.json({ message: "Asset Tracker API is running" });
});

// Fetch asset data from Yahoo Finance
async function fetchAssetData() {
  // You can expand these lists with more symbols
  const cryptoSymbols = ["BTC-USD", "ETH-USD"];
  const stockSymbols = ["AAPL", "TSLA", "MSFT"];
  const forexSymbols = ["EURUSD=X", "GBPUSD=X"];

  const symbols = [...cryptoSymbols, ...stockSymbols, ...forexSymbols];

  const cached = cache.get("assets");
  if (cached) return cached;

  try {
    const results = await yahooFinance.quote(symbols);

    // Normalize data
    const assets = results.map((item) => ({
      symbol: item.symbol,
      name: item.shortName || item.symbol,
      price: item.regularMarketPrice,
      change: item.regularMarketChange,
      changePercent: item.regularMarketChangePercent,
    }));

    cache.set("assets", assets);
    return assets;
  } catch (err) {
    console.error("Error fetching data:", err);
    return [];
  }
}

// /api/assets endpoint
app.get("/api/assets", async (req, res) => {
  const { category } = req.query;
  const assets = await fetchAssetData();

  if (!assets.length) {
    return res.status(500).json({ error: "Failed to fetch assets" });
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
    category: category || "all",
    total_fetched: filtered.length,
    items: filtered,
  });
});

app.listen(PORT, () => {
  console.log(`✅ Asset Tracker API running on port ${PORT}`);
});