import { schedule } from '@netlify/functions';
import { runPicks } from './picks-core.mjs';

// 5:00 PM MDT (UTC-6) = 23:00 UTC | 5:00 PM MST (UTC-7) = 00:00 UTC next day
export const handler = schedule('0 23 * * 1-5', async () => {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const massiveKey   = process.env.MASSIVE_API_KEY;
  if (!anthropicKey) { console.error('Missing ANTHROPIC_API_KEY'); return { statusCode: 500 }; }
  try {
    await runPicks({ sessionLabel: 'evening', anthropicKey, massiveKey, now: new Date(), isEvening: true });
    return { statusCode: 200 };
  } catch(e) {
    console.error('evening picks failed:', e);
    return { statusCode: 500 };
  }
});
