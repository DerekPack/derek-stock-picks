import { schedule } from '@netlify/functions';
import { getStore } from '@netlify/blobs';

// Runs at 6:30 AM MT (12:30 UTC) and 5:00 PM MT (23:00 UTC), Mon-Fri
export const handler = schedule('30 12 * * 1-5, 0 23 * * 1-5', async () => {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const massiveKey   = process.env.MASSIVE_API_KEY;

  if (!anthropicKey) {
    console.error('Missing ANTHROPIC_API_KEY env var');
    return { statusCode: 500 };
  }

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Denver' });
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Denver' });
  const isEvening = now.getUTCHours() >= 20; // 5pm MT or later

  // ── Fetch live gate data from Massive ──────────────────────
  let gateCtx = '';
  if (massiveKey) {
    try {
      const tickers = ['QQQ','SPY','IWM','SMH','XLK','XLF','XLE','XLV','XBI','XLI','XLY','XLP','XLRE','XLU','XLC','XLB','GLD','TLT','UVXY'];
      const url = `https://api.massive.com/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${tickers.join(',')}&apiKey=${massiveKey}`;
      const r = await fetch(url);
      if (r.ok) {
        const d = await r.json();
        const snap = {};
        (d.tickers || []).forEach(t => { if (t.ticker) snap[t.ticker] = t; });

        const fmt = (ticker) => {
          const t = snap[ticker];
          if (!t) return `${ticker}: N/A`;
          const chg = t.todaysChangePerc?.toFixed(2) ?? '?';
          return `${ticker}: ${chg}%`;
        };

        gateCtx = `\n\nLIVE MARKET DATA (as of ${timeStr} MT):\n` +
          [['SPY','QQQ','IWM'],['XLK','SMH','XLF','XLE'],['XLV','XBI','XLI','XLY'],['XLP','XLRE','XLU','XLC','XLB'],['GLD','TLT','UVXY']]
          .map(g => g.map(fmt).join('  '))
          .join('\n');
      }
    } catch (e) {
      console.warn('Massive fetch failed:', e.message);
    }
  }

  // ── Build prompt ───────────────────────────────────────────
  const sessionType = isEvening
    ? 'EVENING PRE-ANALYSIS (after market close — focus on tomorrow)'
    : 'PRE-MARKET ANALYSIS (before open — focus on today)';

  const systemPrompt = `You are a professional stock analyst. Identify 4-5 high-quality US stock picks for the NEXT trading session using current market data, sector momentum, technicals, and FinTwit sentiment.

CONSTRAINTS:
- US stocks only (NASDAQ/NYSE), no penny stocks (min $10 price, min $500M market cap)
- Focus on stocks with active FinTwit discussion or unusual options activity
- Use current sector momentum — favor sectors showing relative strength
- Bias toward clear catalysts (earnings beat, FDA catalyst, analyst upgrade, sector rotation)
- No more than 2 picks per sector

CRITICAL — MOMENTUM FILTER:
- DO NOT pick a stock that has closed down 2 or more consecutive days UNLESS it has a confirmed reversal catalyst
- DO NOT pick a stock more than 8% below its 5-day high without a strong catalyst

PRICE ACCURACY — CRITICAL:
- The "price" field must be the stock's CURRENT price as of the most recent trading session
- Search for "[TICKER] stock price today" to verify — do NOT use stale prices

SESSION TYPE: ${sessionType}
TODAY'S DATE: ${dateStr}
SCHEDULED RUN TIME: ${timeStr} MT

MARKET EVENTS — Include in market_events array:
Search for today's and tomorrow's scheduled: CPI, PPI, PCE, NFP, FOMC, Fed speeches, major S&P 500 earnings
Set impact: "high" for Fed/macro data and major earnings, "medium" for secondary data, "low" for minor

Return ONLY valid JSON:
{
  "date": "${dateStr}",
  "session": "${isEvening ? 'evening' : 'morning'}",
  "generated_at": "${timeStr} MT",
  "macro_bias": "<Bull|Bear|Neutral>",
  "macro_score": <0-100>,
  "macro_note": "<1 sentence>",
  "market_events": [
    {"time":"8:30 AM","desc":"Nonfarm Payrolls","impact":"high","estimate":"180K"}
  ],
  "trending_sectors": [
    {"name":"AI / Semiconductors","bias":"bull","reason":"SMH +2.3%"}
  ],
  "picks": [{
    "rank":1,"ticker":"NVDA","name":"NVIDIA Corporation","sector":"AI / Semiconductors",
    "price":135.40,"signal":"Buy at VWAP","timeframe":"Swing 1-3d","confidence":"high",
    "entry":134.00,"target":142.00,"stop":130.00,
    "chg_1d":1.2,"chg_3d":3.5,
    "catalyst":"Analyst upgraded to $160 PT",
    "technical":"Broke 50d MA on volume, RSI 58",
    "thesis":"2-3 sentences on why this stock and setup",
    "entry_strategy":["Watch gap above $134","Buy VWAP pullback ~$135","Scale out at $139-142"],
    "fintwit_sentiment":[
      {"handle":"@alphatrends","tone":"bull","note":"flagged breakout on weekly"}
    ]
  }]
}`;

  // ── Call Anthropic ─────────────────────────────────────────
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        system: systemPrompt,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: `Generate ${isEvening ? 'evening pre-analysis' : 'pre-market'} stock picks. Search for current data and return JSON.${gateCtx}` }],
      }),
    });

    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      console.error('Anthropic error:', err);
      return { statusCode: 500 };
    }

    const data = await r.json();
    const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('');

    // Extract JSON
    let json = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    const si = json.indexOf('{'), ei = json.lastIndexOf('}');
    if (si >= 0 && ei > si) json = json.slice(si, ei + 1);
    const parsed = JSON.parse(json);
    parsed.cached = true;
    parsed.cached_at = now.toISOString();

    // ── Store in Netlify Blobs ────────────────────────────────
    const store = getStore('stock-picks');
    await store.setJSON('latest', parsed);
    console.log(`✓ Picks cached at ${timeStr} MT — ${parsed.picks?.length ?? 0} picks`);

    return { statusCode: 200 };
  } catch (e) {
    console.error('Scheduled picks failed:', e);
    return { statusCode: 500 };
  }
});
