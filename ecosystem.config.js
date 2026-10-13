'use strict';

/**
 * Optional PM2 process definition.
 *
 * Wispbyte can run the bot straight from "npm start". If the panel prefers a
 * PM2 ecosystem file, point it at this file. Configuration is still read from
 * the environment (Wispbyte panel variables or a local .env file), never from
 * this file, so no secret is stored here.
 */

module.exports = {
  apps: [
    {
      name: 'moderation-bot',
      script: 'src/index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      // The bot keeps its own state in Cloudflare D1; never run more than one
      // instance against the same token or moderation cases can be duplicated.
      autorestart: true,
      max_memory_restart: '512M',
      // Graceful shutdown: the process handles SIGINT/SIGTERM and closes the
      // Discord connection, the scheduler, and the health endpoint cleanly.
      kill_timeout: 10000,
      wait_ready: false,
      env: {
        NODE_ENV: 'production',
        TZ: 'UTC',
      },
      out_file: 'logs/pm2-out.log',
      error_file: 'logs/pm2-error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
