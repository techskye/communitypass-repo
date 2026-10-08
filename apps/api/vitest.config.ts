import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    globalSetup: ['../../packages/core/src/test-utils/global-setup.ts'],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    testTimeout: 60000,
    hookTimeout: 60000,
    env: {
      NODE_ENV: 'test',
      QUEUE_DISABLED: 'true',
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        'postgresql://communitypass:communitypass@localhost:5432/communitypass_test',
    },
  },
});
