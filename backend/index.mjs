import express from 'express';
import { request } from 'node:http';
import { request as secureRequest } from 'node:https';
import { pathToFileURL } from 'node:url';

const app = express();
app.disable('x-powered-by');
const hopHeaders = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host'
]);

// Bindings are consumed by functions at request time, never at build time.
app.use((req, res) => {
  const base = process.env.SERVER_INTERNAL_URL;
  if (!base) return res.status(503).json({ success: false, message: 'SERVER_INTERNAL_URL binding is missing' });
  const target = new URL(req.originalUrl, base);
  const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => !hopHeaders.has(name)));
  headers['x-forwarded-host'] = req.headers['x-forwarded-host'] || req.headers.host;
  headers['x-forwarded-proto'] = req.headers['x-forwarded-proto'] || req.protocol;
  const upstream = (target.protocol === 'https:' ? secureRequest : request)(target, {
    method: req.method, headers
  }, (response) => {
    res.status(response.statusCode || 502);
    for (const [name, value] of Object.entries(response.headers)) {
      if (value !== undefined && !hopHeaders.has(name)) res.setHeader(name, value);
    }
    response.on('error', () => res.destroy());
    response.pipe(res);
  });
  upstream.on('error', () => {
    if (res.headersSent) res.destroy();
    else res.status(502).json({ success: false, message: 'Application service unavailable' });
  });
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
});

// An ESM default export enables streaming in Vercel's Node adapter.
export default app;
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  app.listen(process.env.PORT || 3001);
}
