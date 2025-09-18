// server.js
const express = require('express');
const yahooFinance = require('yahoo-finance2').default;
const axios = require('axios');
const moment = require('moment');
const NodeCache = require('node-cache');
const cors = require('cors');
const helmet = require('helmet');

const app = express();
app.use(express.json());
app.use(cors());
app.use(helmet());

// In-memory cache (ttl in seconds)
const cache = new NodeCache({ stdTTL: parseInt(process.env.CACHE_TTL || '60', 10), checkperiod: 120 });

// Hardcoded assets
const STOCK_SYMBOLS = ['AAPL', 'MSFT', 'GOOGL', 'TSLA', 'AMZN', 'NVDA', 'META', 'BRK-B', 'JPM', 'V'];
const CRYPTO_SYMBOLS = ['bitcoin', 'ethereum', 'binancecoin', 'ripple', 'cardano', 'solana', 'dogecoin', 'tron', 'avalanche-2', 'shiba-inu'];
const FOREX_PAIRS = ['EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'AUDUSD', 'USDCAD', 'NZDUSD', 'USDZAR'];

// Helpers: change & volatility (digit-by-digit arithmetic implied)
function calculateChange(prices) {
  if (!Array.isArray(prices) || prices.length < 2) return 0;
  const first = prices[0];
  const last = prices[prices.length - 1];
  if (!first || first === 0) return 0;
  return ((last - first) / first) * 100;
}

function calculateVolatility(prices) {
  if (!Array.isArray(prices) || prices.length < 2) return 0;
  const n = prices.length;
  const mean = prices.reduce((a, b) => a + b, 0) / n;
  if (mean === 0) return 0;
  const variance = prices.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / n;
  return (Math.sqrt(variance) / mean) * 100;
}

// Yahoo mapping: safer combos that are accepted commonly
function mapPeriodToYahoo(period) {
  // return { range, interval }
  if (period === '1h') return { range: '1d', interval: '5m' }; // intraday
  if (period === '1d') return { range: '5d', interval: '30m' };
  // default / 1w
  return { range: '1mo', interval: '1h' };
}

// Fetch functions with caching & timeouts
async function fetchStockPrice(symbol, period = '1d') {
  const cacheKey = `stock:${symbol}:${period}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const { range, interval } = mapPeriodToYahoo(period);
    // yahooFinance.chart(symbol, { range, interval }) is the correct shape
    const result = await yahooFinance.chart(symbol, { range, interval });

    if (!result || !Array.isArray(result.quotes) || result.quotes.length === 0) {
      const payload = { current_price: null, candles: [], error: 'No stock data' };
      cache.set(cacheKey, payload);
      return payload;
    }

    const candles = result.quotes.map(q => ({
      timestamp: moment(q.date).toISOString(),
      o: q.open,
      h: q.high,
      l: q.low,
      c: q.close,
      v: q.volume || 0
    }));

    const payload = { current_price: candles[candles.length - 1].c, candles, error: null };
    cache.set(cacheKey, payload);
    return payload;
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.error(`fetchStockPrice(${symbol}) failed:`, msg);
    const payload = { current_price: null, candles: [], error: msg };
    cache.set(cacheKey, payload);
    return payload;
  }
}

async function fetchCryptoPrice(symbol, period = '1d') {
  const cacheKey = `crypto:${symbol}:${period}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    // CoinGecko OHLC days param: 1, 7, 30, 90, 365, max
    const daysMap = { '1h': 1, '1d': 1, '1w': 7 };
    const days = daysMap[period] || 1;
    const url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(symbol)}/ohlc?vs_currency=usd&days=${days}`;

    const response = await axios.get(url, { timeout: 10000 });
    const data = response.data;
    if (!Array.isArray(data) || data.length === 0) {
      const payload = { current_price: null, candles: [], error: 'No crypto data' };
      cache.set(cacheKey, payload);
      return payload;
    }

    const candles = data.map(entry => {
      // [timestamp(ms), open, high, low, close]
      const [ts, open, high, low, close] = entry;
      return {
        timestamp: moment(ts).toISOString(),
        o: open,
        h: high,
        l: low,
        c: close,
        v: 0
      };
    });

    const payload = { current_price: candles[candles.length - 1].c, candles, error: null };
    cache.set(cacheKey, payload);
    return payload;
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.error(`fetchCryptoPrice(${symbol}) failed:`, msg);
    const payload = { current_price: null, candles: [], error: msg };
    cache.set(cacheKey, payload);
    return payload;
  }
}

async function fetchForexPrice(pair, period = '1d') {
  const cacheKey = `forex:${pair}:${period}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    // days to request (a little extra to ensure enough points)
    const daysMap = { '1d': 2, '1w': 8 };
    const days = daysMap[period] || 8;
    const end = moment();
    const start = moment().subtract(days, 'days');

    const base = pair.slice(0, 3).toUpperCase();
    const symbol = pair.slice(3).toUpperCase();

    const url = `https://api.exchangerate.host/timeseries?start_date=${start.format('YYYY-MM-DD')}&end_date=${end.format('YYYY-MM-DD')}&base=${base}&symbols=${symbol}`;

    const response = await axios.get(url, { timeout: 10000 });
    const rates = response.data && response.data.rates ? response.data.rates : null;
    if (!rates || Object.keys(rates).length === 0) {
      const payload = { current_price: null, candles: [], error: 'No forex rates' };
      cache.set(cacheKey, payload);
      return payload;
    }

    const dates = Object.keys(rates).sort();
    const closes = dates.map(d => rates[d][symbol] || 0);
    const candles = closes.map((close, i) => ({
      timestamp: moment(dates[i]).toISOString(),
      o: i === 0 ? close : closes[i - 1] || close,
      h: close,
      l: close,
      c: close,
      v: 0
    }));

    const payload = { current_price: closes[closes.length - 1], candles, error: null };
    cache.set(cacheKey, payload);
    return payload;
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.error(`fetchForexPrice(${pair}) failed:`, msg);
    const payload = { current_price: null, candles: [], error: msg };
    cache.set(cacheKey, payload);
    return payload;
  }
}

// Fetch top assets concurrently, robust to partial failures
async function fetchTopAssets(assetType, limit = 10, period = '1d') {
  const mapping = {
    stocks: STOCK_SYMBOLS,
    crypto: CRYPTO_SYMBOLS,
    forex: FOREX_PAIRS
  };
  const symbols = mapping[assetType] || [];
  if (!symbols.length) return [];

  const extraLimit = Math.min(limit * 3, symbols.length);
  const batchSymbols = symbols.slice(0, extraLimit);

  const tasks = batchSymbols.map(sym => {
    if (assetType === 'stocks') return fetchStockPrice(sym, period).then(res => ({ symbol: sym, data: res }));
    if (assetType === 'crypto') return fetchCryptoPrice(sym, period).then(res => ({ symbol: sym, data: res }));
    if (assetType === 'forex') return fetchForexPrice(sym, period).then(res => ({ symbol: sym, data: res }));
    return Promise.resolve({ symbol: sym, data: { current_price: null, candles: [], error: 'Unsupported' } });
  });

  const settled = await Promise.allSettled(tasks);
  const results = settled
    .filter(s => s.status === 'fulfilled' && s.value && s.value.data && s.value.data.error === null && Array.isArray(s.value.data.candles) && s.value.data.candles.length > 0)
    .map(s => {
      const { symbol, data } = s.value;
      return {
        symbol,
        prices: data.candles.map(c => c.c),
        current_price: data.current_price
      };
    });

  // Log failures for debugging
  settled
    .filter(s => s.status === 'fulfilled' && s.value && s.value.data && s.value.data.error)
    .forEach(s => console.warn(`Asset ${s.value.symbol} failed: ${s.value.data.error}`));

  settled
    .filter(s => s.status === 'rejected')
    .forEach(s => console.error('fetchTopAssets task rejected:', s.reason));

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

// Routes
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
  return res.json(result);
});

app.get('/api/v1/gainers/:asset_type', async (req, res) => {
  const { asset_type } = req.params;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);
  const timeframe = req.query.timeframe || '1d';
  if (!['1h', '1d', '1w'].includes(timeframe)) return res.status(400).json({ error: 'Invalid timeframe. Use 1h, 1d, or 1w.' });

  const data = await fetchTopAssets(asset_type, limit, timeframe);
  return res.json({ items: getGainers(data, limit), total_fetched: data.length });
});

app.get('/api/v1/losers/:asset_type', async (req, res) => {
  const { asset_type } = req.params;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);
  const timeframe = req.query.timeframe || '1d';
  if (!['1h', '1d', '1w'].includes(timeframe)) return res.status(400).json({ error: 'Invalid timeframe. Use 1h, 1d, or 1w.' });

  const data = await fetchTopAssets(asset_type, limit, timeframe);
  return res.json({ items: getLosers(data, limit), total_fetched: data.length });
});

app.get('/api/v1/stable/:asset_type', async (req, res) => {
  const { asset_type } = req.params;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);
  const vol_threshold = Math.min(Math.max(parseFloat(req.query.vol_threshold) || 2.0, 0), 50);
  const timeframe = req.query.timeframe || '1w';
  if (!['1d', '1w'].includes(timeframe)) return res.status(400).json({ error: 'Invalid timeframe for stable. Use 1d or 1w.' });

  const data = await fetchTopAssets(asset_type, limit, timeframe);
  return res.json({ items: getStable(data, limit, vol_threshold), total_fetched: data.length });
});

// Optional: expose cache stats for debugging (restrict in prod if needed)
app.get('/_debug/cache', (req, res) => {
  return res.json({ keys: cache.keys(), stats: cache.getStats ? cache.getStats() : {} });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Asset tracker API listening on port ${PORT}`);
});