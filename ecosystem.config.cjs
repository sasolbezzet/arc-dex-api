module.exports = {
  apps: [
    {
      name: 'arc-dex-api',
      script: 'server.mjs',
      cwd: __dirname,
      interpreter: '/usr/bin/node',
      node_args: '--env-file=.env',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      max_memory_restart: '512M',
      out_file: './logs/api.out.log',
      error_file: './logs/api.err.log',
      merge_logs: true,
      time: true,
    },
  ],
}
