const { app, BrowserWindow, ipcMain, protocol, net, Menu, Tray, nativeImage, dialog, safeStorage } = require('electron');
const { Worker } = require('node:worker_threads');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, renameSync } = require('node:fs');
const { tmpdir } = require('node:os');

const smoke = process.argv.includes('--smoke');
const performanceCheck = smoke && process.argv.includes('--smoke-performance');
const smokeVisible = smoke && process.argv.includes('--smoke-visible');
const smokeArgument = process.argv.indexOf('--smoke-dir');
const smokeDirectory = resolve(smokeArgument >= 0 ? process.argv[smokeArgument + 1] : 'build/desktop-smoke');
const fixtureDirectory = smoke ? mkdtempSync(join(tmpdir(), 'ai-yaoce-smoke-')) : null;
if (smoke && !smokeVisible && !performanceCheck) app.commandLine.appendSwitch('disable-gpu');
if (performanceCheck) require('./performance.cjs').prepare(join(fixtureDirectory, 'home'));
app.setName('AI 遥测');
app.setPath('userData', smoke ? join(fixtureDirectory, 'profile') : join(app.getPath('appData'), 'ai-yaoce'));
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

let window;
let tray;
let backend;
let health;
let healthStorageError;
let sequence = 0;
let backendFailure;
let quitting = false;
let latestSnapshot;
const pending = new Map();
const userData = app.getPath('userData');
const preferences = { alwaysOnTop: false };

function failBackend(error) {
  backendFailure = error;
  for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(error); }
  pending.clear();
}

function request(method, value) {
  if (backendFailure) return Promise.reject(backendFailure);
  return new Promise((resolveRequest, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('后台响应超时，请重试')); }, 120_000);
    pending.set(id, { resolve: resolveRequest, reject, timer });
    backend.postMessage({ id, method, value });
  });
}

async function startBackend() {
  const base = app.isPackaged ? app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked') : app.getAppPath();
  backend = new Worker(join(base, 'desktop', 'backend-worker.mjs'), {
    workerData: {
      ...(smoke ? { home: join(fixtureDirectory, 'home') } : {}),
      configPath: join(smoke ? fixtureDirectory : userData, 'pricing-rules.json'),
      fixture: smoke && !performanceCheck
    }
  });
  backend.on('error', failBackend);
  backend.on('exit', (code) => { if (!quitting) failBackend(new Error(`采集进程已停止 (${code})，请重新打开应用`)); });
  backend.on('message', (message) => {
    if (message.type === 'update') {
      latestSnapshot = message.snapshot;
      if (window && !window.isDestroyed() && window.isVisible() && !window.isMinimized()) window.webContents.send('monitor:update', message.snapshot);
      return;
    }
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id); clearTimeout(task.timer);
    if (message.error) task.reject(new Error(message.error)); else task.resolve(message.result);
  });
  await new Promise((resolveReady, reject) => {
    const timeout = setTimeout(() => reject(new Error('采集进程启动超时')), 30_000);
    backend.once('error', (error) => { clearTimeout(timeout); reject(error); });
    const ready = (message) => {
      if (message.type === 'ready') { clearTimeout(timeout); backend.off('message', ready); resolveReady(); }
    };
    backend.on('message', ready);
  });
}

function validateSender(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
      || event.senderFrame.url !== 'app://monitor/ui.html') throw new Error('禁止来自非应用页面的调用');
}

function registerIPC() {
  const handle = (name, handler) => ipcMain.handle(`monitor:${name}`, (event, value) => { validateSender(event); return handler(value); });
  handle('snapshot', () => request('snapshot'));
  handle('health', () => ({ ...health.snapshot(), storageError: healthStorageError }));
  handle('save-health', async (value) => {
    if (healthStorageError) throw new Error(healthStorageError);
    try { return await health.save(value); }
    catch { throw new Error('保存失败：请检查检测参数、重复模型和系统加密存储权限'); }
  });
  handle('check-health', (id) => health.check(id));
  handle('pricing', () => request('getPricing'));
  handle('refresh', () => request('refresh'));
  handle('save-pricing', (value) => {
    if (!value || JSON.stringify(value).length > 1_048_576) throw new Error('价格配置过大或无效');
    return request('savePricing', value);
  });
  handle('pin', (enabled) => {
    if (typeof enabled !== 'boolean') throw new Error('无效窗口设置');
    preferences.alwaysOnTop = enabled;
    window.setAlwaysOnTop(enabled); return enabled;
  });
  handle('minimize', () => window.minimize());
  handle('close', () => app.quit());
}

function createTray() {
  const bitmap = Buffer.alloc(24 * 24 * 4);
  for (let row = 0; row < 24; row++) {
    for (let column = 0; column < 24; column++) {
      const distance = Math.hypot(row - 11.5, column - 11.5);
      if ((distance >= 7 && distance <= 11) || distance <= 3) {
        const offset = (row * 24 + column) * 4;
        bitmap[offset] = 235; bitmap[offset + 1] = 148; bitmap[offset + 2] = 80; bitmap[offset + 3] = 255;
      }
    }
  }
  const icon = nativeImage.createFromBitmap(bitmap, { width: 24, height: 24 });
  if (icon.isEmpty()) return;
  tray = new Tray(icon);
  tray.setToolTip('AI 遥测');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示面板', click: () => { window.show(); window.focus(); } },
    { label: '刷新', click: () => { request('refresh').catch(() => {}); } },
    { type: 'separator' }, { label: '退出', click: () => app.quit() }
  ]));
  tray.on('click', () => { window.show(); window.focus(); });
}

async function startWindow() {
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    if (url.host !== 'monitor' || !['/ui.html', '/ui.js', '/health-ui.js', '/style.css'].includes(url.pathname)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(join(__dirname, url.pathname.slice(1))).href);
  });
  window = new BrowserWindow({
    width: 360, height: 740, minWidth: 352, maxWidth: 520, minHeight: 430,
    title: 'AI 遥测', show: !smoke || smokeVisible, frame: false, autoHideMenuBar: true,
    backgroundColor: '#22252b', alwaysOnTop: preferences.alwaysOnTop,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true,
      nodeIntegration: false, webviewTag: false, backgroundThrottling: true }
  });
  const publishLatest = () => { if (latestSnapshot) window.webContents.send('monitor:update', latestSnapshot); };
  window.on('show', publishLatest);
  window.on('restore', publishLatest);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== 'app://monitor/ui.html') event.preventDefault(); });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }));
  await window.loadURL('app://monitor/ui.html');
  if (!smoke || smokeVisible) createTray();
}

async function runSmoke() {
  if (performanceCheck) return require('./performance.cjs').measure(app, window, request, smokeDirectory);
  mkdirSync(smokeDirectory, { recursive: true });
  const { runDesktopSmoke } = require('./smoke.cjs');
  const report = await runDesktopSmoke(window, smokeDirectory);
  report.platform = process.platform; report.arch = process.arch;
  report.version = app.getVersion(); report.packaged = app.isPackaged;
  report.visibleStartup = smokeVisible;
  if (process.platform === 'win32') {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows加密存储不可用');
    const fixture = 'model-health-encryption-fixture';
    const encrypted = safeStorage.encryptString(fixture);
    if (encrypted.includes(Buffer.from(fixture)) || safeStorage.decryptString(encrypted) !== fixture) throw new Error('Windows加密往返验证失败');
    report.checks.push('Windows safeStorage encrypt/decrypt fixture without plaintext');
    report.count = report.checks.length;
  }
  if (smokeVisible) {
    if (!window.isVisible() || !tray || tray.isDestroyed()) throw new Error('正常窗口或托盘未成功创建');
    report.checks.push('Visible window and system tray created with normal GPU settings');
    report.count = report.checks.length;
  }
  writeFileSync(join(smokeDirectory, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { window.restore(); window.show(); window.focus(); } });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { quitting = true; health?.close(); backend?.terminate(); tray?.destroy(); });
  app.whenReady().then(async () => {
    const { ModelHealth, defaultHealthConfig } = await import(pathToFileURL(join(app.getAppPath(), 'node/model-health.mjs')).href);
    const healthPath = join(userData, 'model-health.enc');
    let healthConfig = defaultHealthConfig();
    if (!smoke && existsSync(healthPath)) {
      try { healthConfig = JSON.parse(safeStorage.decryptString(readFileSync(healthPath))); }
      catch { healthStorageError = '检测配置解密失败，已停用检测；原文件未覆盖，请检查系统密钥库后重启'; }
    }
    const persist = async (value) => {
      if (smoke) return;
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密存储不可用');
      const encrypted = safeStorage.encryptString(JSON.stringify(value));
      mkdirSync(userData, { recursive: true });
      writeFileSync(`${healthPath}.tmp`, encrypted, { mode: 0o600 });
      renameSync(`${healthPath}.tmp`, healthPath);
    };
    try { health = new ModelHealth({ config: healthConfig, persist, automatic: false }); }
    catch {
      healthStorageError = '检测配置无效，已停用检测；原文件未覆盖';
      health = new ModelHealth({ automatic: false });
    }
    await startBackend(); registerIPC(); await startWindow();
    if (smoke) { await runSmoke(); app.quit(); }
  }).catch((error) => {
    if (smoke) {
      mkdirSync(smokeDirectory, { recursive: true });
      writeFileSync(join(smokeDirectory, 'failure.txt'), error.stack || error.message);
      console.error(error); app.exit(1);
    } else { dialog.showErrorBox('AI 遥测启动失败', error.message); app.quit(); }
  });
}
