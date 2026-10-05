const { readFileSync, writeFileSync, copyFileSync, symlinkSync } = require('node:fs');
const { resolve, join } = require('node:path');
const root = resolve(__dirname, '..');
const baseline = resolve(process.argv[2]);
const mainPath = join(baseline, 'desktop/main.cjs');
let main = readFileSync(mainPath, 'utf8');
const replacements = [
  ["const smoke = process.argv.includes('--smoke');", "const smoke = process.argv.includes('--smoke');\nconst performanceCheck = smoke && process.argv.includes('--smoke-performance');"],
  ["if (smoke && !smokeVisible) app.commandLine.appendSwitch('disable-gpu');", "if (smoke && !smokeVisible && !performanceCheck) app.commandLine.appendSwitch('disable-gpu');\nif (performanceCheck) require('./performance.cjs').prepare(join(fixtureDirectory, 'home'));"],
  ['fixture: smoke\n', 'fixture: smoke && !performanceCheck\n'],
  ['async function runSmoke() {', "async function runSmoke() {\n  if (performanceCheck) return require('./performance.cjs').measure(app, window, request, smokeDirectory);"]
];
for (const [before, after] of replacements) {
  if (!main.includes(before)) throw new Error('Baseline does not match measurement harness');
  main = main.replace(before, after);
}
writeFileSync(mainPath, main);
copyFileSync(join(root, 'desktop/performance.cjs'), join(baseline, 'desktop/performance.cjs'));
symlinkSync(join(root, 'node_modules'), join(baseline, 'node_modules'), 'junction');
