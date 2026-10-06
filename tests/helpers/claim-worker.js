// Child process for the cross-process claim race test: claims tasks until none are left, prints the claimed ids.
import { Db } from '../../server/src/db/database.js';
import { createRepos } from '../../server/src/db/repos.js';
import { AgentRegistry } from '../../server/src/agents/registry.js';
import { TaskQueue } from '../../server/src/agents/queue.js';

const [, , path, agentId] = process.argv;
const db = Db.open(path, { busyTimeoutMs: 10000 }), repos = createRepos(db);
const agent = new AgentRegistry(db, repos).get(agentId), queue = new TaskQueue(db, repos);
const mine = [];
for (;;) { const t = queue.claim(agent); if (!t) break; mine.push(t.id); }
db.close();
console.log(JSON.stringify(mine));
