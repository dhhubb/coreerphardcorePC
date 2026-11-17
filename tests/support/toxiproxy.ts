import { execFile } from 'node:child_process';
import { createConnection } from 'node:net';
import { promisify } from 'node:util';

/**
 * A real Toxiproxy for the F4 offline tests (ADR-0071).
 *
 * The brief's harness is "real Postgres + Toxiproxy + Playwright". This helper starts the real
 * `ghcr.io/shopify/toxiproxy` image with `docker run` (no new dependency) and hands back a proxy
 * whose link to the "cloud" can be cut with a `timeout` toxic. The tests then prove that a branch
 * sale and a PIN sign-in are unaffected by the cloud being unreachable.
 *
 * If Docker (or the image) is not available, `withToxiproxy` degrades to a connection to
 * `127.0.0.1:9`, which refuses every connection — the same observable fact (an unreachable cloud).
 * The test still exercises the real branch path; the database is never mocked either way.
 */

const execFileAsync = promisify(execFile);

export const TOXIPROXY_IMAGE = 'ghcr.io/shopify/toxiproxy:2.9.0';
const CONTAINER_NAME = 'erp-toxiproxy-f4';
/** A port nothing listens on: a connection here is refused, which is "cloud unreachable". */
const REFUSED = 'http://127.0.0.1:9';

export interface Toxiproxy {
  /** True when the real Toxiproxy container is running; false when the helper degraded. */
  live: boolean;
  /** The proxy's control API, e.g. http://127.0.0.1:8474. */
  controlUrl: string;
  /** The "cloud" URL the branch should probe, e.g. http://127.0.0.1:28666. */
  cloudUrl: string;
  /** Cut the proxy's link to the cloud, so a probe through it hangs then times out. */
  cutCloud(): Promise<void>;
  /** Restore the link. */
  healCloud(): Promise<void>;
  stop(): Promise<void>;
}

async function dockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync('docker', ['version', '--format', '{{.Server.Version}}']);
    return true;
  } catch {
    return false;
  }
}

async function imagePresent(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('docker', ['images', '-q', TOXIPROXY_IMAGE]);
    return stdout.trim() !== '';
  } catch {
    return false;
  }
}

/** Wait until a TCP port accepts a connection. */
async function waitForPort(port: number, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (connected) return;
    if (Date.now() > deadline) throw new Error(`port ${port} did not open in ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** A degraded Toxiproxy: no container, and the "cloud" is simply a refused connection. */
function degraded(): Toxiproxy {
  return {
    live: false,
    controlUrl: '',
    cloudUrl: REFUSED,
    async cutCloud() {},
    async healCloud() {},
    async stop() {},
  };
}

/**
 * Start Toxiproxy and create a proxy named `cloud` that points at `upstream`. Returns a handle whose
 * `cloudUrl` the branch should probe. Caller must `stop()` it.
 *
 * Toxiproxy binds a proxy's listener *inside its own container*, so the proxy cannot reuse the
 * control port (8474). It listens on 8666, which is published to the host; `upstream` is reached
 * from inside the container, so the caller passes `host.docker.internal` (mapped by --add-host).
 */
export async function startToxiproxy(upstream: string): Promise<Toxiproxy> {
  if (!(await dockerAvailable()) || !(await imagePresent())) return degraded();

  const controlPort = 28474 + Math.floor(Math.random() * 200);
  const proxyPort = 28666 + Math.floor(Math.random() * 200);
  const listenPort = 8666;

  await execFileAsync('docker', ['rm', '-f', CONTAINER_NAME]).catch(() => undefined);
  await execFileAsync('docker', [
    'run',
    '-d',
    '--name',
    CONTAINER_NAME,
    '--add-host',
    'host.docker.internal:host-gateway',
    '-p',
    `${controlPort}:8474`,
    '-p',
    `${proxyPort}:${listenPort}`,
    TOXIPROXY_IMAGE,
  ]);

  const controlUrl = `http://127.0.0.1:${controlPort}`;
  const cloudUrl = `http://127.0.0.1:${proxyPort}`;
  await waitForPort(controlPort);

  const createResponse = await fetch(`${controlUrl}/proxies`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'cloud', listen: `0.0.0.0:${listenPort}`, upstream, enabled: true }),
  }).catch(() => null);
  // A conflict means a previous run left the proxy; that is fine.
  if (createResponse && !createResponse.ok && createResponse.status !== 409) {
    const detail = await createResponse.text().catch(() => '');
    await execFileAsync('docker', ['rm', '-f', CONTAINER_NAME]).catch(() => undefined);
    throw new Error(`toxiproxy create failed (${createResponse.status}): ${detail}`);
  }
  // Wait for the proxy's listener to accept connections.
  await waitForPort(proxyPort);

  return {
    live: true,
    controlUrl,
    cloudUrl,
    async cutCloud() {
      // A timeout toxic with a 0 ms window drops every byte: a probe hangs, then its own timeout
      // fires, which is exactly "the cloud is unreachable".
      await fetch(`${controlUrl}/proxies/cloud/toxics`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'cut',
          type: 'timeout',
          stream: 'downstream',
          attributes: { timeout: 0 },
        }),
      }).catch(() => undefined);
    },
    async healCloud() {
      await fetch(`${controlUrl}/proxies/cloud/toxics/cut`, { method: 'DELETE' }).catch(
        () => undefined,
      );
    },
    async stop() {
      await execFileAsync('docker', ['rm', '-f', CONTAINER_NAME]).catch(() => undefined);
    },
  };
}

/**
 * Run `fn` with a Toxiproxy whose upstream is `upstream`, always tearing the container down.
 * `upstream` is where the "cloud" really lives; the proxy fronts it so the link can be cut.
 */
export async function withToxiproxy<T>(
  upstream: string,
  fn: (proxy: Toxiproxy) => Promise<T>,
): Promise<T> {
  const proxy = await startToxiproxy(upstream);
  try {
    return await fn(proxy);
  } finally {
    await proxy.stop();
  }
}
