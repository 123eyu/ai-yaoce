import { parentPort, workerData } from 'node:worker_threads';
import { createDesktopBackend } from '../node/desktop-backend.mjs';

const backend = await createDesktopBackend({
  ...workerData,
  onUpdate: (snapshot) => parentPort.postMessage({ type: 'update', snapshot })
});
parentPort.on('message', async ({ id, method, value }) => {
  try {
    let result;
    switch (method) {
      case 'snapshot': result = await backend.snapshot(); break;
      case 'refresh': result = await backend.refresh(); break;
      case 'getPricing': result = await backend.getPricing(); break;
      case 'savePricing': result = await backend.savePricing(value); break;
      case 'close': await backend.close(); parentPort.close(); return;
      default: throw new Error('Unknown backend operation');
    }
    parentPort.postMessage({ id, result });
  } catch (error) {
    parentPort.postMessage({ id, error: error.message || '本地采集失败' });
  }
});
parentPort.postMessage({ type: 'ready' });
