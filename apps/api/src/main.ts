import { createCoreContext } from '@communitypass/core';
import { createApp } from './app';

async function main() {
  const core = createCoreContext({ name: 'api' });
  const app = await createApp(core);
  const port = Number(process.env.API_PORT ?? 4000);
  await app.listen(port, '0.0.0.0');
  core.logger.info({ port, appMode: core.config.appMode }, 'CommunityPass API listening');
  if (core.config.appMode === 'demo') {
    core.logger.warn('DEMO MODE: mock payment and messaging providers — no real payments or messages.');
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('API failed to start:', e instanceof Error ? e.message : e);
  process.exit(1);
});
