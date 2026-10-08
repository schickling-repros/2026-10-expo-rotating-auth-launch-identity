// Minimal expo-updates protocol v1 server (JSON manifest, unsigned) on loopback.
// Records every manifest/asset Authorization header and every app evidence event.
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const port = 18765;
const origin = `http://127.0.0.1:${port}`;
mkdirSync('.evidence', { recursive: true });
const evidence = '.evidence/events.jsonl';
const log = entry => {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  appendFileSync(evidence, `${line}\n`);
  console.log(line);
};

const metadata = JSON.parse(readFileSync('dist/metadata.json', 'utf8'));
const bundlePath = `dist/${metadata.fileMetadata.ios.bundle}`;
const bundle = readFileSync(bundlePath);
const updateId = randomUUID();
const manifest = {
  id: updateId,
  createdAt: new Date().toISOString(),
  runtimeVersion: 'auth-repro-1',
  launchAsset: {
    hash: createHash('sha256').update(bundle).digest('base64url'),
    key: createHash('md5').update(bundle).digest('hex'),
    contentType: 'application/javascript',
    fileExtension: '.bundle',
    url: `${origin}/bundle`,
  },
  assets: [],
  metadata: {},
  extra: {},
};
let scenario = process.env.SCENARIO ?? 'idle';

createServer((req, res) => {
  const url = new URL(req.url, origin);
  if (url.pathname === '/manifest') {
    log({ kind: 'request', path: '/manifest', authorization: req.headers.authorization ?? null, servedUpdateId: updateId });
    res.writeHead(200, { 'content-type': 'application/json', 'expo-protocol-version': '1', 'expo-sfv-version': '0', 'cache-control': 'private, max-age=0' });
    res.end(JSON.stringify(manifest));
  } else if (url.pathname === '/bundle') {
    log({ kind: 'request', path: '/bundle', authorization: req.headers.authorization ?? null });
    res.writeHead(200, { 'content-type': 'application/javascript' });
    res.end(bundle);
  } else if (url.pathname === '/scenario') {
    // Scenarios are one-shot so a reload does not repeat the action.
    const set = url.searchParams.get('set');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ scenario: set ?? scenario }));
    if (set) scenario = set;
    else { log({ kind: 'scenario-served', scenario }); scenario = 'idle'; }
  } else if (url.pathname === '/evidence' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      log({ kind: 'app', ...JSON.parse(body) });
      res.writeHead(204);
      res.end();
    });
  } else {
    res.writeHead(404);
    res.end();
  }
}).listen(port, '127.0.0.1', () => log({ kind: 'server-ready', servedUpdateId: updateId, scenario }));
