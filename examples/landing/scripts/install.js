import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.argv.slice(2).includes('--help')) {
  console.log('Usage: npm run setup\nInstall locked dependencies with npm ci.');
} else if (process.argv.length > 2) {
  console.error('Unexpected arguments. Use --help for usage.');
  process.exitCode = 1;
} else {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const npmCli = process.env.npm_execpath;
  let command;
  let args;

  if (npmCli && /(?:^|[\\/])npm-cli\.js$/i.test(npmCli)) {
    command = process.execPath;
    args = [npmCli, 'ci'];
  } else if (process.platform === 'win32') {
    command = process.env.ComSpec || 'cmd.exe';
    args = ['/d', '/s', '/c', 'npm ci'];
  } else {
    command = 'npm';
    args = ['ci'];
  }

  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) console.error(`Could not start npm ci: ${result.error.message}`);
  if (result.signal) console.error(`npm ci stopped by signal ${result.signal}.`);
  process.exitCode = result.status ?? 1;
}
