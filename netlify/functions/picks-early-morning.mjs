import { schedule } from '@netlify/functions';
import { runPicks } from './picks-core.mjs';

// 5:33 AM MDT (UTC-6) = 11:33 UTC | 5:33 AM MST (UTC-7) = 12:33 UTC
// Using MDT (summer). Update hour to 12 in November for MST.
export const handler = schedule('33 11 * * 1-5', async () => {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const massiveKey   = process.env.MASSIVE_API_KEY;
  if (!anthropicKey) { console.error('Missing ANTHROPIC_API_KEY'); return { statusCode: 500 }; }
  try {
    await runPicks({ sessionLabel: 'early-morning', anthropicKey, massiveKey, now: new Date(), isEvening: false });
    return { statusCode: 200 };
  } catch(e) {
    console.error('early-morning picks failed:', e);
    return { statusCode: 500 };
  }
});
