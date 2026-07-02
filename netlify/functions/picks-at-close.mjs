import { schedule } from '@netlify/functions';
import { runPicks } from './picks-core.mjs';

// 2:15 PM MDT (UTC-6) = 20:15 UTC | 2:15 PM MST (UTC-7) = 21:15 UTC
export const handler = schedule('15 20 * * 1-5', async () => {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const massiveKey   = process.env.MASSIVE_API_KEY;
  if (!anthropicKey) { console.error('Missing ANTHROPIC_API_KEY'); return { statusCode: 500 }; }
  try {
    await runPicks({ sessionLabel: 'at-close', anthropicKey, massiveKey, now: new Date(), isEvening: false });
    return { statusCode: 200 };
  } catch(e) {
    console.error('at-close picks failed:', e);
    return { statusCode: 500 };
  }
});
