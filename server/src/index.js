import { loadConfig } from './config/index.js';
import { createApp } from './api/app.js';
import { createDatabaseService } from './db/service.js';

const config = loadConfig();
const database = createDatabaseService(config).open();
const log = (o) => console.log(JSON.stringify({ level: 'info', ...o }));
if (database.status !== 'ok') console.error(JSON.stringify({ level: 'error', msg: 'database_not_ready', status: database.status, code: database.errorCode }));
if (database.previousCrashedRuns) console.warn(JSON.stringify({ level: 'warn', msg: 'previous_unclean_shutdown', runs: database.previousCrashedRuns }));

const server = createApp(config, { database });
server.listen(config.server.port, config.server.host, () => log({ msg: 'server_started', host: config.server.host, port: config.server.port, env: config.env, database: database.status }));

let closing = false;
function shutdown(signal) {
  if (closing) return; closing = true;
  log({ msg: 'shutdown', signal });
  server.close(() => { database.close(); process.exit(0); });
  setTimeout(() => { database.close(); process.exit(0); }, 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
