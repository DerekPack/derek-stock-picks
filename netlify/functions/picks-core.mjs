import { getStore } from '@netlify/blobs';

const MASSIVE_BASE = 'https://api.massive.com';

// ── Blob helpers ───────────────────────────────────────────
export function getPicksStore() {
  return getStore('stock-picks');
}

export async function saveRun(data) {
  const store = getPicksStore();
  // Save as latest
  await store.setJSON('latest', data);
  // Save in history keyed by ISO date + session
  const key = `history-${data.run_date}-${data.session.replace(/\s+/g,'-')}`;
  await store.setJSON(key, data);
  // Maintain a history index (last 15 runs)
  let index = [];
  try { index = await store.get('history-index', { type: 'json' }) || []; } catch(_) {}
  index.unshift({ key, date: data.run_date, session: data.session, cached_at: data.cached_at });
  if (index.length > 15) index = index.slice(0, 15);
  await store.setJSON('history-index', index);
}

export async function getPriorRun() {
  const store = getPicksStore();
  try { return await store.get('latest', { type: 'json' }); } catch(_) { return null; }
}

export async function getRecentHistory(days = 5) {
  const store = getPicksStore();
  let index = [];
  try { index = await store.get('history-index', { type: 'json' }) || []; } catch(_) {}
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const recent = index.filter(e => new Date(e.cached_at).getTime() > cutoff);
  const runs = [];
  for (const entry of recent.slice(0, 12)) {
    try {
      const d = await store.get(entry.key, { type: 'json' });
      if (d) runs.push(d);
    } catch(_) {}
  }
  return runs;
}

// ── Massive gate fetch ─────────────────────────────────────
export async function fetchGateData(massiveKey) {
  if (!massiveKey) return '';
  const tickers = ['QQQ','SPY','IWM','SMH','XLK','XLF','XLE','XLV','XBI','XLI','XLY','XLP','XLRE','XLU','XLC','XLB','GLD','TLT','UVXY'];
  try {
    const url = `${MASSIVE_BASE}/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${tickers.join(',')}&apiKey=${massiveKey}`;
    const r = await fetch(url);
    if (!r.ok) return '';
    const d = await r.json();
    const snap = {};
    (d.tickers || []).forEach(t => { if (t.ticker) snap[t.ticker] = t; });
    const fmt = ticker => {
      const t = snap[ticker];
      if (!t) return `${ticker}:N/A`;
      const chg = t.todaysChangePerc?.toFixed(2) ?? '?';
      const price = t.day?.c?.toFixed(2) ?? '?';
      return `${ticker} $${price} (${chg}%)`;
    };
    return '\n\nLIVE MARKET DATA:\n' +
      [['SPY','QQQ','IWM'],['XLK','SMH','XLF','XLE'],['XLV','XBI','XLI','XLY'],['XLP','XLRE','XLU','XLC','XLB'],['GLD','TLT','UVXY']]
      .map(g => g.map(fmt).join('  '))
      .join('\n');
  } catch(e) {
    console.warn('Massive fetch failed:', e.message);
    return '';
  }
}

// ── Build delta context for Claude ────────────────────────
export function buildDeltaContext(priorRun, recentHistory) {
  let ctx = '';

  if (priorRun?.picks?.length) {
    const priorTickers = priorRun.picks.map(p => `${p.ticker} (${p.signal}, ${p.confidence} conf)`).join(', ');
    ctx += `\n\nPREVIOUS RUN (${priorRun.session} ${priorRun.generated_at || ''}):\n`;
    ctx += `Macro bias: ${priorRun.macro_bias} (score ${priorRun.macro_score})\n`;
    ctx += `Picks: ${priorTickers}\n`;
    ctx += `Note: ${priorRun.macro_note || ''}`;
  }

  if (recentHistory?.length > 1) {
    // Find tickers appearing across multiple days
    const tickerDays = {};
    recentHistory.forEach(run => {
      const dateKey = run.run_date || run.date;
      (run.picks || []).forEach(p => {
        if (!tickerDays[p.ticker]) tickerDays[p.ticker] = new Set();
        tickerDays[p.ticker].add(dateKey);
      });
    });
    const persistent = Object.entries(tickerDays)
      .filter(([, days]) => days.size >= 2)
      .map(([ticker, days]) => `${ticker} (${days.size} days)`);
    if (persistent.length) {
      ctx += `\n\nPERSISTENT SIGNALS (last ${recentHistory.length} runs): ${persistent.join(', ')}`;
      ctx += `\nIf these setups are still valid and intact, prioritize them. If they've broken down, explain why they're excluded.`;
    }

    // Sector trends
    const sectorBias = {};
    recentHistory.forEach(run => {
      (run.trending_sectors || []).forEach(s => {
        if (!sectorBias[s.name]) sectorBias[s.name] = [];
        sectorBias[s.name].push(s.bias);
      });
    });
    const sectorTrends = Object.entries(sectorBias)
      .filter(([, biases]) => biases.length >= 2 && biases.every(b => b === biases[0]))
      .map(([name, biases]) => `${name}: consistently ${biases[0]} for ${biases.length} runs`);
    if (sectorTrends.length) {
      ctx += `\n\nSECTOR TRENDS (intact across multiple runs): ${sectorTrends.join(' | ')}`;
    }
  }

  return ctx;
}

// ── Core picks runner ──────────────────────────────────────
export async function runPicks({ sessionLabel, anthropicKey, massiveKey, now, isEvening }) {
  const dateStr = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Denver' });
  const runDate = now.toISOString().slice(0, 10);
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Denver' });

  const [priorRun, recentHistory, gateCtx] = await Promise.all([
    getPriorRun(),
    getRecentHistory(5),
    fetchGateData(massiveKey),
  ]);

  const deltaCtx = buildDeltaContext(priorRun, recentHistory);

  const sessionDesc = isEvening
    ? 'EVENING PRE-ANALYSIS (after market close — focus on tomorrow, include after-hours movers)'
    : sessionLabel === 'early-morning'
    ? 'EARLY PRE-MARKET (5:33 AM MT — focus on overnight futures, Asia/Europe close, pre-market movers)'
    : 'PRE-MARKET FINAL (6:30 AM MT — incorporate any new pre-market data since the 5:33 run)';

  const systemPrompt = `You are a professional stock analyst generating scheduled picks for a self-learning trading app.

SESSION: ${sessionDesc}
DATE: ${dateStr} · TIME: ${timeStr} MT

CONSTRAINTS:
- US stocks only (NASDAQ/NYSE), min $10 price, min $500M market cap
- No more than 2 picks per sector
- Bias toward clear catalysts: earnings, FDA, analyst upgrade, sector rotation

MOMENTUM FILTER:
- DO NOT pick a stock down 2+ consecutive days without a confirmed reversal catalyst
- DO NOT pick a stock >8% below its 5-day high without strong catalyst
- Dip buying only valid if: (a) prior uptrend, (b) dip <5%, (c) sector momentum still bullish

PRICE ACCURACY: Search "[TICKER] stock price today" — current price only, not stale data.

MARKET EVENTS: Search for today's scheduled CPI, PPI, PCE, NFP, FOMC, Fed speeches, major S&P 500 earnings.
Include ALL found events in market_events with ET times. Warn in delta_summary if any high-impact event is within 2 hours.

DELTA REPORT: Compare your picks to the previous run context below. In delta_summary write 2-4 sentences covering:
- What changed from the prior run (new picks, dropped picks, signal upgrades/downgrades)
- Any tickers or sectors appearing consistently across multiple runs — note if the trend is still intact or has broken
- Any macro shift (bias change, score movement)
- Any approaching market event that could cause intraday sentiment shift

PERSISTENT SIGNALS: If a ticker has appeared in multiple prior runs and the setup is STILL valid today, include it and note the streak. If it has broken down, explicitly exclude it and briefly say why in delta_summary.

Return ONLY valid JSON — no prose, no markdown:
{
  "date": "${dateStr}",
  "run_date": "${runDate}",
  "session": "${sessionLabel}",
  "generated_at": "${timeStr} MT",
  "macro_bias": "<Bull|Bear|Neutral>",
  "macro_score": <0-100>,
  "macro_note": "<1 sentence>",
  "delta_summary": "<2-4 sentences comparing to prior run, noting persistent trends and upcoming events>",
  "market_events": [
    {"time":"8:30 AM","desc":"Nonfarm Payrolls","impact":"high","estimate":"180K"}
  ],
  "trending_sectors": [
    {"name":"AI / Semiconductors","bias":"bull","reason":"SMH +2.3%","streak_days":3}
  ],
  "picks": [{
    "rank":1,"ticker":"NVDA","name":"NVIDIA Corporation","sector":"AI / Semiconductors",
    "price":135.40,"signal":"Buy at VWAP","timeframe":"Swing 1-3d","confidence":"high",
    "entry":134.00,"target":142.00,"stop":130.00,
    "chg_1d":1.2,"chg_3d":3.5,
    "streak_days": 2,
    "catalyst":"Analyst upgraded to $160 PT",
    "technical":"Broke 50d MA on volume, RSI 58",
    "thesis":"2-3 sentences on why this stock and setup",
    "entry_strategy":["Watch gap above $134","Buy VWAP pullback ~$135","Scale out at $139-142"],
    "fintwit_sentiment":[
      {"handle":"@alphatrends","tone":"bull","note":"flagged breakout on weekly"}
    ]
  }]
}
streak_days: number of consecutive runs this ticker has appeared (1 if new). signal options: "Buy premarket"|"Buy at VWAP"|"Wait for dip"|"Watch only". confidence: "high"|"medium"|"low"`;

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 4500,
      system: systemPrompt,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: `Generate ${sessionDesc} picks. Search for current data and return JSON.${gateCtx}${deltaCtx}` }],
    }),
  });

  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(`Anthropic error ${r.status}: ${err?.error?.message || 'unknown'}`);
  }

  const data = await r.json();
  const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('');
  let json = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const si = json.indexOf('{'), ei = json.lastIndexOf('}');
  if (si >= 0 && ei > si) json = json.slice(si, ei + 1);
  json = json.replace(/,(\s*[}\]])/g, '$1');
  const parsed = JSON.parse(json);

  parsed.cached = true;
  parsed.cached_at = now.toISOString();
  parsed.prior_session = priorRun ? { session: priorRun.session, generated_at: priorRun.generated_at } : null;

  await saveRun(parsed);
  console.log(`✓ [${sessionLabel}] Picks cached at ${timeStr} MT — ${parsed.picks?.length ?? 0} picks, delta: ${parsed.delta_summary?.slice(0,80)}…`);
  return parsed;
}
