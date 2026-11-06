import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { createHandler } from '../src/connector.mjs';

const SECRET = 'clave-local-de-agenda-solo-para-pruebas-12345';
function agenda(configured = true) {
  return createHandler({ scheduling: { request: async () => { throw new Error('No calendar calls expected'); } }, env: configured ? {
    CHATFUEL_BOT_ID: 'bot-simulado', CHATFUEL_API_TOKEN: 'token-simulado', CHATFUEL_BOOKING_SECRET: SECRET,
  } : {}, fetchImpl: async () => { throw new Error('No se permiten servicios externos en estas pruebas'); } });
}
async function serve(t, bookingHandler, logger = { error() {} }) {
  const rows = [];
  const server = createApp({ bookingHandler, logger,
    database: { ping: async () => {}, saveCliente: async row => rows.push(row) },
    bitrix: { getCliente: async id => ({ id_negociacion: id, telefono: '+573000000001' }) },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { rows, request: (path, init) => fetch(`http://127.0.0.1:${server.address().port}${path}`, init) };
}

test('una sola API conserva el registro MySQL y expone la agenda con su autenticación propia', async t => {
  const { request, rows } = await serve(t, agenda());
  assert.equal((await request('/registrar-cliente?id=123')).status, 200);
  assert.equal(rows.length, 1);
  const body = JSON.stringify({ contactId: 'wa_cfPreview:api-unificada', operation: 'start' });
  assert.equal((await request('/booking', { method: 'POST', body })).status, 401);
  const response = await request('/booking', { method: 'POST', body,
    headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).done, 'si');
  assert.equal(rows.length, 1);
  assert.equal((await request('/sync-handoffs', { method: 'POST' })).status, 401);
});

test('la salud conjunta identifica la versión y comprueba MySQL y la configuración de agenda', async t => {
  const { request } = await serve(t, agenda());
  const response = await request('/health');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.version, '1.0.14');
  assert.equal(body.service, 'api-chatfuel');
  assert.equal(body.mysql.ok, true);
  assert.equal(body.handoff.enabled, false);
});

test('una agenda sin configurar se detecta en salud sin eliminar la ruta de registro', async t => {
  const { request, rows } = await serve(t, agenda(false));
  assert.equal((await request('/health')).status, 503);
  assert.equal((await request('/registrar-cliente?id=123')).status, 200);
  assert.equal(rows.length, 1);
});

test('el diagnóstico de agenda conserva la respuesta y excluye datos y credenciales', async t => {
  const records = [];
  const state = Buffer.from(JSON.stringify({ step: 'city', contactId: 'contacto-privado' })).toString('base64url') + '.firma-privada';
  const expected = { message: '¿En qué ciudad está Persona Privada?', done: 'no', state };
  const { request } = await serve(t, async () => Response.json(expected), { error() {}, info: row => records.push(row) });
  const response = await request('/booking', { method: 'POST', headers: { authorization: 'Bearer clave-privada' },
    body: JSON.stringify({ operation: 'start', contactId: 'contacto-privado' }) });
  assert.deepEqual(await response.json(), expected);
  assert.equal(records.length, 1);
  assert.equal(records[0].etapa, 'city');
  assert.equal(records[0].operacion, 'start');
  assert.doesNotMatch(JSON.stringify(records), /privad|Persona|Bearer|firma/i);
});
