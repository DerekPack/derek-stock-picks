import { schedule } from '@netlify/functions';
import { runPicks } from './picks-core.mjs';

// 6:30 AM MDT (UTC-6) = 12:30 UTC | 6:30 AM MST (UTC-7) = 13:30 UTC
export const handler = schedule('30 12 * * 1-5', async () => {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const massiveKey   = process.env.MASSIVE_API_KEY;
  if (!anthropicKey) { console.error('Missing ANTHROPIC_API_KEY'); return { statusCode: 500 }; }
  try {
    await runPicks({ sessionLabel: 'pre-market', anthropicKey, massiveKey, now: new Date(), isEvening: false });
    return { statusCode: 200 };
  } catch(e) {
    console.error('pre-market picks failed:', e);
    return { statusCode: 500 };
  }
});
