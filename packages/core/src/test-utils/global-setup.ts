import { execSync } from 'node:child_process';
import path from 'node:path';

export default function setup() {
  const url =
    process.env.TEST_DATABASE_URL ??
    'postgresql://communitypass:communitypass@localhost:5432/communitypass_test';
  execSync('npx prisma migrate deploy', {
    cwd: path.resolve(__dirname, '../..'),
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
}
