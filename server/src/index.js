import { loadConfig } from './config/index.js';
import { createApp } from './api/app.js';
import { createDatabaseService } from './db/service.js';
import { createAgentOS } from './agents/os.js';

const config = loadConfig();
const database = createDatabaseService(config).open();
const log = (o) => console.log(JSON.stringify({ level: 'info', ...o }));
if (database.status !== 'ok') console.error(JSON.stringify({ level: 'error', msg: 'database_not_ready', status: database.status, code: database.errorCode }));
if (database.previousCrashedRuns) console.warn(JSON.stringify({ level: 'warn', msg: 'previous_unclean_shutdown', runs: database.previousCrashedRuns }));

// Agent OS: one shared runtime on top of the database. Repair state left by a dead process, then start agents.
let agentOS = null;
if (database.status === 'ok') {
  agentOS = createAgentOS({ db: database.db, repos: database.repos, config: config.agentOs });
  const rec = agentOS.reconcileAfterRestart();
  if (rec.releasedTasks.length || rec.stoppedAgents.length) console.warn(JSON.stringify({ level: 'warn', msg: 'agent_os_reconciled', ...rec }));
  await agentOS.startAll();
  if (config.agentOs?.autoStart !== false) agentOS.startLoop();
}
const server = createApp(config, { database, agentOS });
server.listen(config.server.port, config.server.host, () => log({ msg: 'server_started', host: config.server.host, port: config.server.port, env: config.env, database: database.status }));

let closing = false;
async function shutdown(signal) {
  if (closing) return; closing = true;
  log({ msg: 'shutdown', signal });
  setTimeout(() => { database.close(); process.exit(1); }, 8000).unref();
  server.close();
  try { await agentOS?.shutdown(); } catch (e) { console.error(JSON.stringify({ level: 'error', msg: 'agent_shutdown_error', error: String(e.message) })); }
  database.close(); process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
