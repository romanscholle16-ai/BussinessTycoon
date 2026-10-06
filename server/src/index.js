import { loadConfig } from './config/index.js';
import { createApp } from './api/app.js';

const config = loadConfig();
createApp(config).listen(config.server.port, config.server.host, () => {
  console.log(JSON.stringify({ level: 'info', msg: 'server_started', host: config.server.host, port: config.server.port, env: config.env }));
});
