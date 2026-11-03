// Local stand-in for `wrangler dev`: serves the Worker handler over HTTP, pointed at the mock NSE/Yahoo server.
// Run: node tests/serve_worker.mjs [port]
import http from 'node:http';
import worker from '../worker/src/index.js';

const port = Number(process.argv[2] || 8787);
const env = { NSE_BASE: process.env.NSE_BASE || 'http://127.0.0.1:8765', YAHOO_BASE: process.env.YAHOO_BASE || 'http://127.0.0.1:8765', ALLOW_ORIGIN: '*', CACHE_TTL: '30' };
http.createServer(async (req, res) => {
  const r = await worker.fetch(new Request('http://localhost:' + port + req.url, { method: req.method }), env, { waitUntil() {} });
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(port, '127.0.0.1', () => console.log('worker on', port));
