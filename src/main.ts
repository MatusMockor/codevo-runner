import type { Server } from 'node:http';
import { readConfig } from './config.js';
import { loadIdentity } from './identity.js';
import { loadAuthorization } from './auth.js';
import { createRunnerApplication } from './server.js';

async function main() {
  const config = readConfig(process.env);
  const authorized = await loadAuthorization(config.tokenFile);
  const runnerId = await loadIdentity(config.dataDir);
  const app = await createRunnerApplication({ protocolVersion: 1, runnerId, name: config.name,
    capabilities: { taskExecution: false, eventReplay: false } }, authorized);
  const server: Server = app.getHttpServer();
  server.on('error', () => { console.error('Runner listener failed'); process.exitCode = 1; });
  await app.listen(config.port, config.host);
  console.log(`Codevo runner listening on ${config.host}:${config.port}`);
  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => server.closeAllConnections(), 5_000);
    deadline.unref();
    try {
      await app.close();
    } catch {
      console.error('Runner shutdown failed');
      process.exitCode = 1;
    } finally {
      clearTimeout(deadline);
    }
  }
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch(() => {
  console.error('Runner startup failed. Check configuration, token file and data directory.');
  process.exitCode = 1;
});
