import seed from '../web/results.json' with { type: 'json' };
import { validateResults } from '../web/results-model.js';

// This public reader needs no write credential. The host is pinned at setup.
export const RESULTS_URL = 'https://pszke17tmuehgeyb.public.blob.vercel-storage.com/results/current.json';
export function resultsHandler({ fetchResults = fetch, url = RESULTS_URL } = {}) {
  return async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (!['GET', 'HEAD'].includes(request.method)) { response.statusCode = 405; response.end(); return; }
    try {
      const result = await fetchResults(url, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
      if (!result.ok && result.status !== 404) throw new Error('Results unavailable');
      const data = validateResults(result.status === 404 ? seed : await result.json());
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.statusCode = 200; response.end(request.method === 'HEAD' ? undefined : JSON.stringify(data));
    } catch { response.statusCode = 503; response.end('{"error":"Results temporarily unavailable"}'); }
  };
}
export default resultsHandler();
