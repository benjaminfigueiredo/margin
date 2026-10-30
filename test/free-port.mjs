// A port nothing is listening on, chosen by the OS (bind port 0 on 127.0.0.1, read it back, close).
// The tests used to pick random ports from fixed ranges, which collided now and then (EADDRINUSE),
// both within one run and between runs on the same machine.
import net from 'node:net';

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}
