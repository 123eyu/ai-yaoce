import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

let redirected = 0;
const server = createServer((request, response) => {
  if (request.url === '/redirect') { response.writeHead(302, { location: '/capture' }); response.end(); }
  else if (request.url === '/capture') { redirected++; response.end('{}'); }
  else if (request.url === '/large') response.end('x'.repeat(1048577));
  else if (request.url === '/wait') { request.on('close', () => response.destroy()); }
  else { response.setHeader('content-type', 'application/json'); response.end('{"content":[{"type":"text","text":"1"}]}'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const child = spawn('build/verify-model-health', [`--network-port=${server.address().port}`], { stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  assert.equal(code, 0); assert.equal(redirected, 0, 'Redirect received credentials');
  console.log('Swift transport verified against isolated local HTTP mock; no redirect followed');
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
