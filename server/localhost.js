// Localhost-only HTTP, shared by the paper server (server/app.js) and the hub (server/hub.js):
// the Host check, the cross-site refusal and the loopback listeners. Both servers can act on
// the author's files (the hub can even start a server on any folder), so they get exactly the
// same guards. Don't loosen any of this (CLAUDE.md).
import http from 'node:http';

// Host header values (and Origin values, minus the scheme) a request may carry.
export function loopbackHosts(port) {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
}

// Guard against DNS rebinding: only answer requests addressed to localhost.
export function hostGuard(allowedHosts) {
  return (req, res, next) => (allowedHosts.has(req.headers.host) ? next() : res.status(403).send('Forbidden host'));
}

// Guard against cross-site requests (CSRF). The Host check does not stop a page on another site
// from making the browser send a "simple" POST to 127.0.0.1 without a preflight, which would let
// any web page compile, pull, or worse. Browsers label such requests with Origin (every
// cross-origin fetch, and every POST) and Sec-Fetch-Site; refuse anything not from this server's
// own page. Claude Code's MCP client and the prompt hook send neither, so they are unaffected.
// A page on another port of 127.0.0.1 (another paper, the hub) is another origin and is refused.
// Plain GET navigations are not checked on Sec-Fetch-Site, so a link to Margin still opens it,
// unless `guardReads(req)` says that GET must come from this server's own page too.
export function crossSiteGuard(allowedHosts, { guardReads = () => false } = {}) {
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedHosts.has(origin.replace(/^http:\/\//, ''))) return res.status(403).json({ error: 'Cross-site request refused' });
    const site = req.headers['sec-fetch-site'];
    const safe = req.method === 'GET' || req.method === 'HEAD';
    if ((!safe || guardReads(req)) && site && site !== 'same-origin' && site !== 'none') return res.status(403).json({ error: 'Cross-site request refused' });
    next();
  };
}

// Same checks for a WebSocket upgrade (browsers send Origin on every WebSocket handshake).
export function upgradeAllowed(req, allowedHosts) {
  if (!allowedHosts.has(req.headers.host)) return false;
  const origin = req.headers.origin;
  return origin === undefined || allowedHosts.has(origin.replace(/^http:\/\//, ''));
}

// Listens on 127.0.0.1 (an error such as EADDRINUSE rejects) and, best effort, on ::1: on macOS
// "localhost" often resolves to the IPv6 address first. Machines without IPv6 keep the IPv4 listener.
export async function listenLoopback(app, port, { onUpgrade } = {}) {
  const server = http.createServer(app);
  if (onUpgrade) server.on('upgrade', onUpgrade);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const server6 = http.createServer(app);
  if (onUpgrade) server6.on('upgrade', onUpgrade);
  await new Promise((resolve) => { server6.once('error', () => resolve()); server6.listen(port, '::1', resolve); });
  return { server, server6 };
}
