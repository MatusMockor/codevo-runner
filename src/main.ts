import { readConfig } from './config.ts';
import { loadIdentity } from './identity.ts';
import { loadAuthorization } from './auth.ts';
import { createRunnerServer } from './server.ts';

async function main() {
  const config = readConfig(process.env);
  const authorized = await loadAuthorization(config.tokenFile);
  const runnerId = await loadIdentity(config.dataDir);
  const server = createRunnerServer({ protocolVersion: 1, runnerId, name: config.name,
    capabilities: { taskExecution: false, eventReplay: false } }, authorized);
  server.on('error', () => { console.error('Runner listener failed'); process.exitCode = 1; });
  server.listen(config.port, config.host, () => {
    console.log(`Codevo runner listening on ${config.host}:${config.port}`);
  });
  let stopping = false;
  function stop() {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => server.closeAllConnections(), 5_000);
    deadline.unref();
    server.close(() => clearTimeout(deadline));
  }
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch(() => {
  console.error('Runner startup failed. Check configuration, token file and data directory.');
  process.exitCode = 1;
});
