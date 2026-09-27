import { handleApiRequest, handleHealthRequest } from '../lib/quant-api.mjs';

export async function onRequest({ request, env }) {
  const { pathname } = new URL(request.url);
  if (pathname === '/health') return handleHealthRequest();
  if (pathname.startsWith('/api/')) return handleApiRequest(request);
  return env.ASSETS.fetch(request);
}
