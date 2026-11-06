import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createApp } from '../src/app.js';
import { createHandler } from '../src/connector.mjs';
import { schemaUrl } from '../src/database.js';

assert.equal(typeof WebSocket, 'function');
assert.match(await readFile(schemaUrl, 'utf8'), /clientes/);
const secret = 'clave-local-simulada-para-comprobar-la-imagen-12345';
const handler = createHandler({ scheduling: { request: async () => { throw new Error('No calendar calls expected'); } }, env: {
  CHATFUEL_BOT_ID: 'simulado', CHATFUEL_API_TOKEN: 'simulado', CHATFUEL_BOOKING_SECRET: secret,
}, fetchImpl: async () => { throw new Error('No se permiten conexiones externas'); } });
let stored = 0;
const server = createApp({ bookingHandler: handler, logger: { error() {} },
  bitrix: { getCliente: async id => ({ id_negociacion: id, telefono: '+573000000001' }) },
  database: { ping: async () => {}, saveCliente: async () => { stored++; } },
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
try {
  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.version, '1.0.12');
  assert.equal(health.mysql.ok, true);
  assert.equal((await fetch(`${base}/registrar-cliente?id=123`)).status, 200);
  assert.equal(stored, 1);
  const body = JSON.stringify({ contactId: 'wa_cfPreview:imagen-unificada', operation: 'start' });
  assert.equal((await fetch(`${base}/booking`, { method: 'POST', body })).status, 401);
  const preview = await fetch(`${base}/booking`, { method: 'POST', body, headers: { Authorization: `Bearer ${secret}` } });
  assert.equal(preview.status, 200);
  assert.equal((await preview.json()).done, 'si');
  console.log(JSON.stringify({ ok: true, version: health.version, registroYAgendaEnUnaAPI: true, mysqlDriverIncluido: true, esquemaIncluido: true, serviciosExternosUsados: false, registrosRealesCreados: false }));
} finally {
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
}
