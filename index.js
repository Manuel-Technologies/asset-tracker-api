const express = require('express');
const yahooFinance = require('yahoo-finance2').default;
const axios = require('axios');
const moment = require('moment');
const app = express();

app.use(express.json());

// Hardcoded symbols (top 10 per type)
const STOCK_SYMBOLS = ['AAPL', 'MSFT', 'GOOGL', 'TSLA', 'AMZN', 'NVDA', 'META', 'BRK-B', 'JPM', 'V'];
const CRYPTO_SYMBOLS = ['bitcoin', 'ethereum', 'binancecoin', 'ripple', 'cardano', 'solana', 'dogecoin', 'tron', 'avalanche-2', 'shiba-inu'];
const FOREX_PAIRS = ['EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'AUDUSD', 'USDCAD', 'NZDUSD', 'USDZAR'];

// Helper: Calculate % change and volatility
function calculateChange(prices) {
  if (prices.length < 2) return 0;
  const first = prices[0];
  const last = prices[prices.length - 1];
  return ((last - first) / first) * 100;
}

function calculateVolatility(prices) {
  if (prices.length < 2) return 0;
  const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
  const variance = prices.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / prices.length;
  return (Math.sqrt(variance) / mean) * 100;
}

// Fetch Data Functions
async function fetchStockPrice(symbol, period = '1d') {
  try {
    let interval, range;
    if (period === '1h') { interval = '1m'; range = '1d'; }
    else if (period === '1d') { interval = '1h'; range = '5d'; }
    else { interval = '1h'; range = '1mo'; } // 1w

    const query = `${symbol}.NS`; // Adjust for your region (e.g., .NS for India, remove for US)
    const result = await yahooFinance.chart(query, { interval, range });
    if (!result || !result.quotes) throw new Error('No data');

    const currentPrice = result.quotes[result.quotes.length - 1].close;
    const candles = result.quotes.map(q => ({
      timestamp: moment.unix(q.date).toISOString(),
      o: q.open,
      h: q.high,
      l: q.low,
      c: q.close,
      v: q.volume || 0
    }));

    return { current_price: currentPrice, candles, error: null };
  } catch (e) {
    return { current_price: null, candles: [], error: e.message };
  }
}

async function fetchCryptoPrice(symbol, period = '1d') {
  try {
    const days = { '1h': 1, '1d': 1, '1w': 7 }[period];
    const response = await axios.get(`https://api.coingecko.com/api/v3/coins/${symbol}/ohlc?vs_currency=usd&days=${days}`);
    if (!response.data || response.data.length === 0) throw new Error('No data');

    const currentPrice = response.data[response.data.length - 1][4];
    const candles = response.data.map(([timestamp, open, high, low, close]) => ({
      timestamp: moment.unix(timestamp / 1000).toISOString(),
      o: open,
      h: high,
      l: low,
      c: close,
      v: 0 // Volume not provided by CoinGecko OHLC
    }));

    return { current_price: currentPrice, candles, error: null };
  } catch (e) {
    return { current_price: null, candles: [], error: e.message };
  }
}

async function fetchForexPrice(pair, period = '1d') {
  try {
    const days = { '1d': 2, '1w': 8 }[period];
    const end = moment();
    const start = moment().subtract(days, 'days');
    const response = await axios.get(`https://api.exchangerate.host/timeseries?start_date=${start.format('YYYY-MM-DD')}&end_date=${end.format('YYYY-MM-DD')}&base=${pair.slice(0, 3)}&symbols=${pair.slice(3)}`, { timeout: 10000 });
    if (!response.data.rates) throw new Error('No rates data');

    const rates = Object.entries(response.data.rates).map(([date, value]) => value[pair.slice(3)]);
    const closes = rates.map(r => r || 0);
    const currentPrice = closes[closes.length - 1];

    const candles = closes.map((close, i) => ({
      timestamp: moment(Object.keys(response.data.rates)[i]).toISOString(),
      o: i === 0 ? close : closes[i - 1] || close,
      h: close,
      l: close,
      c: close,
      v: 0 // No volume data
    }));

    return { current_price: currentPrice, candles, error: null };
  } catch (e) {
    return { current_price: null, candles: [], error: e.message };
  }
}

async function fetchTopAssets(assetType, limit = 10, period = '1d') {
  const symbols = { stocks: STOCK_SYMBOLS, crypto: CRYPTO_SYMBOLS, forex: FOREX_PAIRS }[assetType] || [];
  if (!symbols.length) return [];

  const extraLimit = Math.min(limit * 3, symbols.length);
  const batchSymbols = symbols.slice(0, extraLimit);
  const results = [];

  for (const sym of batchSymbols) {
    try {
      let data;
      if (assetType === 'stocks') data = await fetchStockPrice(sym, period);
      else if (assetType === 'crypto') data = await fetchCryptoPrice(sym, period);
      else if (assetType === 'forex') data = await fetchForexPrice(sym, period);

      if (data.error === null && data.candles.length) {
        const prices = data.candles.map(c => c.c);
        results.push({ symbol: sym, prices, current_price: data.current_price });
      }
    } catch (e) {
      console.error(`Error fetching ${sym}: ${e.message}`);
    }
  }
  return results;
}

// Categorization
function getGainers(data, limit = 10) {
  return data
    .map(d => ({ ...d, pct_change: calculateChange(d.prices) }))
    .sort((a, b) => b.pct_change - a.pct_change)
    .slice(0, limit);
}

function getLosers(data, limit = 10) {
  return data
    .map(d => ({ ...d, pct_change: calculateChange(d.prices) }))
    .sort((a, b) => a.pct_change - b.pct_change)
    .slice(0, limit);
}

function getStable(data, limit = 10, volThreshold = 2.0) {
  return data
    .map(d => ({ ...d, volatility_pct: calculateVolatility(d.prices) }))
    .filter(d => d.volatility_pct < volThreshold)
    .sort((a, b) => a.volatility_pct - b.volatility_pct)
    .slice(0, limit);
}

// Endpoints
app.get('/health', (req, res) => res.json({ status: 'OK', message: 'API is running!' }));

app.get('/api/v1/price/:asset_type/:symbol', async (req, res) => {
  const { asset_type, symbol } = req.params;
  const period = req.query.period || '1d';
  if (!['1h', '1d', '1w'].includes(period)) return res.status(400).json({ error: 'Invalid period. Use 1h, 1d, or 1w.' });

  let result;
  if (asset_type === 'stocks') result = await fetchStockPrice(symbol.toUpperCase(), period);
  else if (asset_type === 'crypto') result = await fetchCryptoPrice(symbol.toLowerCase(), period);
  else if (asset_type === 'forex') result = await fetchForexPrice(symbol.toUpperCase(), period);
  else return res.status(400).json({ error: 'Unsupported asset_type. Use stocks, crypto, or forex.' });

  if (result.error) return res.status(404).json({ error: result.error });
  res.json(result);
});

app.get('/api/v1/gainers/:asset_type', async (req, res) => {
  const { asset_type } = req.params;
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 50);
  const timeframe = req.query.timeframe || '1d';
  if (!['1h', '1d', '1w'].includes(timeframe)) return res.status(400).json({ error: 'Invalid timeframe. Use 1h, 1d, or 1w.' });

  const data = await fetchTopAssets(asset_type, limit * 3, timeframe);
  const items = getGainers(data, limit);
  res.json({ items, total_fetched: data.length });
});

app.get('/api/v1/losers/:asset_type', async (req, res) => {
  const { asset_type } = req.params;
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 50);
  const timeframe = req.query.timeframe || '1d';
  if (!['1h', '1d', '1w'].includes(timeframe)) return res.status(400).json({ error: 'Invalid timeframe. Use 1h, 1d, or 1w.' });

  const data = await fetchTopAssets(asset_type, limit * 3, timeframe);
  const items = getLosers(data, limit);
  res.json({ items, total_fetched: data.length });
});

app.get('/api/v1/stable/:asset_type', async (req, res) => {
  const { asset_type } = req.params;
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 10, 1), 50);
  const vol_threshold = Math.min(Math.max(parseFloat(req.query.vol_threshold) || 2.0, 0), 50);
  const timeframe = req.query.timeframe || '1w';
  if (!['1d', '1w'].includes(timeframe)) return res.status(400).json({ error: 'Invalid timeframe for stable. Use 1d or 1w.' });

  const data = await fetchTopAssets(asset_type, limit * 3, timeframe);
  const items = getStable(data, limit, vol_threshold);
  res.json({ items, total_fetched: data.length });
});

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});