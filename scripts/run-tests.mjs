import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const runTmp = mkdtempSync(path.join(os.tmpdir(), 'pipelane-test-run-'));
const child = spawn(
  process.execPath,
  ['--test', '--test-force-exit', ...process.argv.slice(2), 'test/pipelane.test.mjs'],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      TMPDIR: runTmp,
      TMP: runTmp,
      TEMP: runTmp,
      PIPELANE_TEST_TMPDIR: runTmp,
    },
  },
);

child.on('exit', (code, signal) => {
  if (code === 0 && signal === null) {
    rmSync(runTmp, { recursive: true, force: true });
  } else {
    console.error(`[pipelane-test] preserved temp dir: ${runTmp}`);
  }

  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});
