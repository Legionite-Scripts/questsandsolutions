/**
 * qs-markets — Cloudflare Worker backing the markets reel on questsandsolutions.org
 *
 * Why a Worker at all: Yahoo's chart endpoint sends no CORS headers, so the
 * browser cannot call it directly. This sits in front, normalises the payload,
 * and caches for five minutes so a busy page costs one upstream call, not many.
 *
 * Response shape (consumed by MARKET_INSTRUMENTS in index.html):
 *   {
 *     updated: ISO8601, delayed: true, sources: ["Yahoo"],
 *     quotes: { DJI: { label, price, changePct, source, ok }, ... }
 *   }
 * A symbol that cannot be sourced comes back as ok:false; the page skips it,
 * so an outage shortens the reel rather than showing a stale or invented level.
 *
 * Deploy:  wrangler deploy worker.js --name qs-markets --compatibility-date 2024-11-01
 */

const CACHE_SECONDS = 300;

// Keys here must match MARKET_INSTRUMENTS in index.html.
const SYMBOLS = {
  // ── Indices ──────────────────────────────────────────────
  // NGX ASI has no free public feed at present — Yahoo retired ^NGSEINDX.
  // It stays listed so it reappears automatically if a source returns;
  // until then it resolves ok:false and the page simply omits it.
  NGXASI: { symbol: '^NGSEINDX',  label: 'NGX ASI' },
  DJI:    { symbol: '^DJI',       label: 'Dow Jones' },
  SPX:    { symbol: '^GSPC',      label: 'S&P 500' },
  IXIC:   { symbol: '^IXIC',      label: 'Nasdaq' },
  FTSE:   { symbol: '^FTSE',      label: 'FTSE 100' },
  N225:   { symbol: '^N225',      label: 'Nikkei 225' },
  GDAXI:  { symbol: '^GDAXI',     label: 'DAX' },
  SSEC:   { symbol: '000001.SS',  label: 'Shanghai Composite' },
  N100:   { symbol: '^N100',      label: 'Euronext 100' },
  HSI:    { symbol: '^HSI',       label: 'Hang Seng' },
  FCHI:   { symbol: '^FCHI',      label: 'CAC 40' },

  // ── FX: USD/NGN plus the most-transacted global pairs ────
  // Quoted in market convention, so the Aussie is AUD/USD, not USD/AUD.
  USDNGN: { symbol: 'USDNGN=X',   label: 'USD/NGN' },
  EURUSD: { symbol: 'EURUSD=X',   label: 'EUR/USD' },
  USDJPY: { symbol: 'USDJPY=X',   label: 'USD/JPY' },
  GBPUSD: { symbol: 'GBPUSD=X',   label: 'GBP/USD' },
  USDCNY: { symbol: 'USDCNY=X',   label: 'USD/CNY' },
  USDCAD: { symbol: 'USDCAD=X',   label: 'USD/CAD' },
  AUDUSD: { symbol: 'AUDUSD=X',   label: 'AUD/USD' },
  USDCHF: { symbol: 'USDCHF=X',   label: 'USD/CHF' },
  EURJPY: { symbol: 'EURJPY=X',   label: 'EUR/JPY' },
  GBPJPY: { symbol: 'GBPJPY=X',   label: 'GBP/JPY' },
  EURGBP: { symbol: 'EURGBP=X',   label: 'EUR/GBP' }
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Max-Age': '86400'
};

async function fetchQuote(key, { symbol, label }) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; qs-markets/1.0)' },
      cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true }
    });
    if (!res.ok) throw new Error(`http ${res.status}`);

    const meta = (await res.json())?.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice;
    const prev  = meta?.chartPreviousClose ?? meta?.previousClose;
    if (typeof price !== 'number' || !isFinite(price)) throw new Error('no price');

    const changePct = (typeof prev === 'number' && prev > 0)
      ? ((price - prev) / prev) * 100
      : 0;

    return [key, {
      label,
      price: Math.round(price * 10000) / 10000,
      changePct: Math.round(changePct * 100) / 100,
      source: 'Yahoo',
      ok: true
    }];
  } catch (err) {
    return [key, { label, price: null, changePct: null, source: 'Yahoo', ok: false }];
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'GET') {
      return new Response('Method Not Allowed', { status: 405, headers: CORS });
    }

    // Serve the edge copy while it is fresh; one visitor's miss warms it for all.
    const cache = caches.default;
    const cacheKey = new Request(new URL(request.url).origin + '/', { method: 'GET' });
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    const entries = await Promise.all(
      Object.entries(SYMBOLS).map(([key, spec]) => fetchQuote(key, spec))
    );

    const quotes = Object.fromEntries(entries);
    const sources = [...new Set(entries.filter(([, q]) => q.ok).map(([, q]) => q.source))];

    const body = JSON.stringify({
      updated: new Date().toISOString(),
      delayed: true,
      sources,
      quotes
    });

    const response = new Response(body, {
      headers: {
        ...CORS,
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': `public, max-age=${CACHE_SECONDS}`
      }
    });

    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  }
};
