import { getStore } from '@netlify/blobs';

export default async () => {
  try {
    const store = getStore('stock-picks');
    const data = await store.get('latest', { type: 'json' });
    if (!data) {
      return new Response(JSON.stringify({ cached: false }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ cached: false, error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
};

export const config = { path: '/api/picks' };
