'use strict';
const config = require('./config');
const prisma = require('./db');
const { createApp } = require('./app');

const app = createApp();
const server = app.listen(config.PORT, () => {
  console.log(`handovers-server listening on :${config.PORT} (${config.NODE_ENV})  API: /api/v1`);
});

async function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
