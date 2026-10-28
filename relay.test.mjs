// Test local de la logique du relais avec un faux environnement Cloudflare (sans réseau).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
fs.writeFileSync(path.join(dir, 'cf.mjs'), 'export class DurableObject{constructor(ctx,env){this.ctx=ctx;this.env=env}}');
let src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8').replace('"cloudflare:workers"', '"./cf.mjs"');
fs.writeFileSync(path.join(dir, 'index.mjs'), src);
class FakeWS {
  constructor() { this.readyState = 1; this.att = null; this.inbox = []; this.peer = null; this.closed = null; }
  send(m) { if (this.readyState !== 1) throw new Error('closed'); this.peer.inbox.push(m); }
  close(c, r) { this.readyState = 3; this.closed = c; }
  serializeAttachment(a) { this.att = JSON.parse(JSON.stringify(a)); }
  deserializeAttachment() { return this.att; }
}
globalThis.WebSocketPair = function () { const a = new FakeWS(), b = new FakeWS(); a.peer = b; b.peer = a; return { 0: a, 1: b }; };
globalThis.WebSocketRequestResponsePair = class { constructor(a, b) { this.a = a; this.b = b; } };
const RealResponse = Response;
globalThis.Response = class extends RealResponse { constructor(b, o = {}) { if (o.status === 101) { super(null, { status: 200 }); this.webSocket = o.webSocket; this.status101 = true; } else super(b, o); } };
const { default: worker, Room } = await import(path.join(dir, 'index.mjs'));
const sockets = [];
const ctx = { acceptWebSocket: (w) => sockets.push(w), getWebSockets: () => sockets.filter((w) => w.readyState === 1), setWebSocketAutoResponse() {} };
const room = new Room(ctx, {});
const J = (m) => JSON.parse(m);
async function join() { const r = await room.fetch(); const client = r.webSocket; return { client, server: client.peer }; }
const A = await join(), B = await join(), C = await join();
const msgs = (x) => x.client.inbox.map(J);
// 1. hello + join
assert.equal(msgs(A)[0].t, 'hello'); assert.deepEqual(msgs(A)[0].peers, []);
assert.equal(msgs(B)[0].peers.length, 1); assert.equal(msgs(C)[0].peers.length, 2);
assert.equal(msgs(A).filter((m) => m.t === 'join').length, 2);
const idA = msgs(A)[0].id, idB = msgs(B)[0].id, idC = msgs(C)[0].id;
assert.equal(new Set([idA, idB, idC]).size, 3);
console.log('ok hello/join');
// 2. diffusion (pas à soi-même)
A.client.inbox.length = B.client.inbox.length = C.client.inbox.length = 0;
room.webSocketMessage(A.server, JSON.stringify({ t: 'm', d: { x: 1 } }));
assert.equal(msgs(B).length, 1); assert.equal(msgs(C).length, 1); assert.equal(msgs(A).length, 0);
assert.deepEqual(msgs(B)[0], { t: 'm', f: idA, d: { x: 1 } });
console.log('ok diffusion');
// 3. message ciblé
B.client.inbox.length = C.client.inbox.length = 0;
room.webSocketMessage(A.server, JSON.stringify({ t: 'm', to: idC, d: 'hello C' }));
assert.equal(msgs(B).length, 0); assert.equal(msgs(C).length, 1); assert.equal(msgs(C)[0].d, 'hello C');
console.log('ok ciblé');
// 4. messages invalides ignorés
B.client.inbox.length = C.client.inbox.length = 0;
room.webSocketMessage(A.server, 'pas du json'); room.webSocketMessage(A.server, JSON.stringify({ t: 'x' }));
room.webSocketMessage(A.server, 'x'.repeat(40000)); room.webSocketMessage(A.server, new ArrayBuffer(4));
assert.equal(msgs(B).length + msgs(C).length, 0);
console.log('ok invalides');
// 5. limite de débit : 500 messages d'un coup => rafale limitée, la connexion reste ouverte
B.client.inbox.length = 0;
for (let i = 0; i < 500; i++) room.webSocketMessage(A.server, JSON.stringify({ t: 'm', d: i }));
assert.ok(msgs(B).length <= 100 && msgs(B).length >= 80, 'rafale=' + msgs(B).length);
assert.equal(A.server.readyState, 1);
console.log('ok débit (', msgs(B).length, 'passés sur 500 )');
// 6. départ
B.client.inbox.length = C.client.inbox.length = 0;
room.webSocketClose(A.server, 1005);
assert.deepEqual(msgs(B)[0], { t: 'leave', id: idA }); assert.deepEqual(msgs(C)[0], { t: 'leave', id: idA });
console.log('ok leave');
// 7. salle pleine
const extra = []; for (let i = 0; i < 40; i++) extra.push(await join());
const last = extra[extra.length - 1];
assert.ok(msgs(last).some((m) => m.t === 'full') || extra.filter((e) => e.client.inbox.some((m) => J(m).t === 'full')).length >= 1);
console.log('ok salle pleine');
// 8. routes HTTP
const env = { ROOMS: { idFromName: (n) => n, get: () => ({ fetch: async () => 'DO' }) }, ALLOWED_ORIGINS: '' };
const req = (u, h = {}) => new Request('https://relay.test' + u, { headers: h });
assert.equal((await worker.fetch(req('/ws?room=abc'), env)).status, 426);
assert.equal((await worker.fetch(req('/ws?room=../x', { Upgrade: 'websocket' }), env)).status, 400);
assert.equal(await worker.fetch(req('/ws?room=g-abc12', { Upgrade: 'websocket' }), env), 'DO');
assert.equal((await worker.fetch(req('/ws?room=abc', { Upgrade: 'websocket' }), { ...env, ALLOWED_ORIGINS: 'https://a.vercel.app' })).status, 403);
assert.equal(await worker.fetch(req('/ws?room=abc', { Upgrade: 'websocket', Origin: 'https://a.vercel.app' }), { ...env, ALLOWED_ORIGINS: 'https://a.vercel.app' }), 'DO');
const key = async (ip) => (await (await worker.fetch(req('/ip', { 'CF-Connecting-IP': ip }), env)).json()).k;
const k1 = await key('203.0.113.7'), k2 = await key('203.0.113.7'), k3 = await key('203.0.113.8');
assert.equal(k1, k2); assert.notEqual(k1, k3);
assert.equal(await key('2a01:cb00:1:2::5'), await key('2a01:cb00:1:2:aaaa:bbbb:cccc:dddd')); // même /64
assert.notEqual(await key('2a01:cb00:1:2::5'), await key('2a01:cb00:1:3::5'));
console.log('ok routes /ws et /ip (clé wifi', k1, ')');
console.log('TOUS LES TESTS OK');
