import { spawn } from 'node:child_process';

const children = [
  spawn(process.execPath, ['--import', 'tsx', '--watch', 'src/server.ts'], { stdio: 'inherit', env: process.env }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--config', 'vite.config.ts'], { stdio: 'inherit', env: process.env }),
];
let stopping = false;
let exitCode = 0;
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true; exitCode = code;
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
}
for (const child of children) {
  child.on('error', error => { console.error('Could not start development service:', error.message); shutdown(1); });
  child.on('exit', code => { if (!stopping) shutdown(code || 1); });
}
process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
process.on('exit', () => { process.exitCode = exitCode; });
