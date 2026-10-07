import { loadConfig, loadDotEnv } from './config/index.js';
import { createApp } from './api/app.js';
import { createDatabaseService } from './db/service.js';
import { createAgentOS } from './agents/os.js';
import { Supervisor } from './supervisor/supervisor.js';
import { createObservability } from './observability/index.js';
import { createAiService } from './ai/service.js';
import { registerAiHandlers } from './ai/handlers.js';
import { createLogger } from './observability/logger.js';
import { createResearchService, registerResearchHandlers, researchConfigFromEnv, RESEARCH_AGENT } from './research/service.js';

loadDotEnv(); // .env (git-ignored) fills variables that are not already set; credentials are read from the environment only
const config = loadConfig();
const database = createDatabaseService(config).open();
const logger = createLogger('server', { level: config.logging?.level });
const log = (o) => { const { msg, ...rest } = o; logger.info(msg, rest); };
if (database.status !== 'ok') logger.error('database_not_ready', { status: database.status, errorCode: database.errorCode });
if (database.previousCrashedRuns) logger.warn('previous_unclean_shutdown', { runs: database.previousCrashedRuns });

// AI service: provider-neutral; with no configuration AI is simply disabled and nothing else is affected.
const ai = createAiService({ config: config.ai, env: process.env, repos: database.status === 'ok' ? database.repos : null, allowMock: config.env !== 'production' });
for (const p of ai.problems) logger.warn('ai_config_problem', { detail: p });
// Agent OS: one shared runtime on top of the database. Repair state left by a dead process, then start agents.
let agentOS = null, supervisor = null, research = null;
if (database.status === 'ok') {
  agentOS = createAgentOS({ db: database.db, repos: database.repos, config: config.agentOs });
  registerAiHandlers(agentOS.handlers, ai);
  research = createResearchService({ db: database.db, repos: database.repos, agentOS, ai, config: researchConfigFromEnv(process.env, config.research ?? {}) });
  for (const p of research.problems) logger.warn('research_config_problem', { detail: p });
  registerResearchHandlers(agentOS.handlers, research);
  if (!agentOS.registry.get(RESEARCH_AGENT.id)) agentOS.registerAgent(RESEARCH_AGENT, { dataMode: research.dataMode });
  const rec = agentOS.reconcileAfterRestart();
  research.reconcile();
  if (rec.releasedTasks.length || rec.stoppedAgents.length) logger.warn('agent_os_reconciled', { releasedTasks: rec.releasedTasks.length, stoppedAgents: rec.stoppedAgents.length });
  await agentOS.startAll();
  agentOS.startHeartbeats();
  if (config.supervisor?.enabled !== false) {
    // The Supervisor is the control brain: it dispatches through the Agent OS, so the Agent OS self-dispatch loop stays off.
    try { supervisor = new Supervisor({ os: agentOS, config: config.supervisor, processRunId: database.runId }); await supervisor.start({ loop: config.supervisor?.autoStart !== false }); }
    catch (e) { logger.error('supervisor_not_started', { errorCode: e.code ?? 'error' }); supervisor = null; }
  } else if (config.agentOs?.autoStart !== false) agentOS.startLoop();
}
const observability = createObservability({ database, agentOS, supervisor, config });
const server = createApp(config, { database, agentOS, supervisor, observability, ai, research });
server.listen(config.server.port, config.server.host, () => log({ msg: 'server_started', host: config.server.host, port: config.server.port, env: config.env, database: database.status }));

let closing = false;
async function shutdown(signal) {
  if (closing) return; closing = true;
  log({ msg: 'shutdown', signal });
  setTimeout(() => { database.close(); process.exit(1); }, 8000).unref();
  server.close();
  try { ai.close(); await supervisor?.stop(); await agentOS?.shutdown(); } catch (e) { logger.error('agent_shutdown_error', { error: e }); }
  database.close(); process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
