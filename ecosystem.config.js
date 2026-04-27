module.exports = {
  apps: [{
    name: 'tenebra-wa',
    cwd: '/var/www/tenebra-wa',
    script: 'index.js',
    instances: 1,
    autorestart: true,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
    },
    error_file: '/var/www/tenebra-wa/logs/err.log',
    out_file: '/var/www/tenebra-wa/logs/out.log',
    time: true,
  }]
};
