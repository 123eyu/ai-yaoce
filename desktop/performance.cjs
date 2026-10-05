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
  const sample = async seconds => {
    app.getAppMetrics();
    const values = [];
    for (let count = 0; count < seconds; count++) {
      await pause(1000);
      const processes = app.getAppMetrics();
      values.push({ workingSetKiB: processes.reduce((sum, process) => sum + process.memory.workingSetSize, 0),
      privateKiB: processes.every(process => Number.isFinite(process.memory.privateBytes)) ? processes.reduce((sum, process) => sum + process.memory.privateBytes, 0) : null,
      cpuPercent: processes.reduce((sum, process) => sum + process.cpu.percentCPUUsage, 0) / cpus().length,
      processes: processes.map(process => ({ type: process.type, pid: process.pid, workingSetKiB: process.memory.workingSetSize })) });
    }
    return values;
  };
  const visibleSamples = window.isVisible() ? await sample(30) : [];
  window.hide();
  await pause(2000);
  const priorUpdate = (await request('snapshot')).updatedAt;
  const rendererVisibility = await window.webContents.executeJavaScript('document.visibilityState');
  const samples = await sample(66);
  const finalSnapshot = await request('snapshot');
  const scheduledRefreshObserved = finalSnapshot.updatedAt !== priorUpdate;
  const report = { passed: finalSnapshot.sources.codex.todayTokens === 12000 && scheduledRefreshObserved,
    platform: process.platform, processors: cpus().length, refreshMilliseconds, rendererVisibility, scheduledRefreshObserved,
    averageIdleCpuPercent: samples.reduce((sum, sample) => sum + sample.cpuPercent, 0) / samples.length,
    peakTotalWorkingSetMiB: Math.max(...samples.map(sample => sample.workingSetKiB)) / 1024,
    peakTotalPrivateMiB: samples.every(sample => sample.privateKiB !== null) ? Math.max(...samples.map(sample => sample.privateKiB)) / 1024 : null,
    averageVisibleCpuPercent: visibleSamples.length ? visibleSamples.reduce((sum, sample) => sum + sample.cpuPercent, 0) / visibleSamples.length : null,
    peakVisibleWorkingSetMiB: visibleSamples.length ? Math.max(...visibleSamples.map(sample => sample.workingSetKiB)) / 1024 : null,
    peakVisiblePrivateMiB: visibleSamples.length && visibleSamples.every(sample => sample.privateKiB !== null) ? Math.max(...visibleSamples.map(sample => sample.privateKiB)) / 1024 : null,
    scope: 'Isolated static 12000-event synthetic logs; all Electron app processes, summed working sets may double-count shared pages; visible 30s when enabled, then hidden 66s includes scheduled refresh; CPU normalized by logical cores', samples, visibleSamples };
  writeFileSync(join(output, 'performance.json'), JSON.stringify(report, null, 2));
  if (!report.passed) throw new Error('Performance final count mismatch');
  console.log(JSON.stringify({ ...report, samples: undefined, visibleSamples: undefined }));
}

module.exports = { prepare, measure };
