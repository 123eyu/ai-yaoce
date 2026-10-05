const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { cpus } = require('node:os');
const { setTimeout: pause } = require('node:timers/promises');

function prepare(home) {
  const directory = join(home, '.codex', 'sessions');
  mkdirSync(directory, { recursive: true });
  const timestamp = new Date().toISOString();
  for (let file = 0; file < 12; file++) {
    const rows = [JSON.stringify({ type: 'session_meta', payload: { id: `fixture-${file}` } })];
    for (let count = 1; count <= 1000; count++) {
      rows.push(JSON.stringify({ type: 'event_msg', timestamp, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: count } } } }));
      rows.push(JSON.stringify({ type: 'response_item', payload: { text: 'synthetic-body-'.repeat(80) } }));
    }
    writeFileSync(join(directory, `${file}.jsonl`), rows.join('\n') + '\n');
  }
}

async function measure(app, window, request, output) {
  mkdirSync(output, { recursive: true });
  const initial = await request('snapshot');
  if (initial.sources.codex.todayTokens !== 12000) throw new Error('Performance fixture count mismatch');
  const refreshMilliseconds = [];
  for (let count = 0; count < 3; count++) {
    const start = performance.now(); await request('refresh');
    refreshMilliseconds.push(performance.now() - start);
  }
  window.hide();
  await pause(2000);
  app.getAppMetrics();
  const samples = [];
  for (let count = 0; count < 66; count++) {
    await pause(1000);
    const processes = app.getAppMetrics();
    samples.push({ workingSetKiB: processes.reduce((sum, process) => sum + process.memory.workingSetSize, 0),
      cpuPercent: processes.reduce((sum, process) => sum + process.cpu.percentCPUUsage, 0) / cpus().length,
      processes: processes.map(process => ({ type: process.type, pid: process.pid, workingSetKiB: process.memory.workingSetSize })) });
  }
  const report = { passed: (await request('snapshot')).sources.codex.todayTokens === 12000,
    platform: process.platform, processors: cpus().length, refreshMilliseconds,
    averageIdleCpuPercent: samples.reduce((sum, sample) => sum + sample.cpuPercent, 0) / samples.length,
    peakTotalWorkingSetMiB: Math.max(...samples.map(sample => sample.workingSetKiB)) / 1024,
    scope: 'Isolated 12000-event synthetic logs; all Electron app processes, summed working sets may double-count shared pages; hidden window, 66s includes scheduled refresh; CPU normalized by logical cores', samples };
  writeFileSync(join(output, 'performance.json'), JSON.stringify(report, null, 2));
  if (!report.passed) throw new Error('Performance final count mismatch');
  console.log(JSON.stringify({ ...report, samples: undefined }));
}

module.exports = { prepare, measure };
