import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { createBitrixClient } from '../src/bitrix.js';
import { readConfig } from '../src/config.js';

const fixture = { ID: '81', NAME: 'María', SECOND_NAME: 'José', LAST_NAME: "D'Ávila", PHONE: [
  { VALUE_TYPE: 'WORK', VALUE: '601 1234567' }, { VALUE_TYPE: 'MOBILE', VALUE: '+57 3001234567' },
] };

function bitrixMock(overrides = {}, options = {}) {
  const calls = [];
  const results = {
    'crm.deal.get': { ID: '32135', CONTACT_ID: '10' },
    'crm.deal.contact.items.get': [{ CONTACT_ID: '10', IS_PRIMARY: 'N', SORT: 10 }, { CONTACT_ID: '81', IS_PRIMARY: 'Y', SORT: 20 }],
    'crm.contact.get': fixture,
    ...overrides,
  };
  const client = createBitrixClient('https://example.test/rest/1/secret/', {
    fetchImpl: async (url, init) => {
      const method = url.pathname.split('/').pop().replace('.json', '');
      calls.push({ method, id: JSON.parse(init.body).id });
      const result = results[method];
      if (result instanceof Error) throw result;
      return result instanceof Response ? result : Response.json({ result });
    }, ...options,
  });
  return { client, calls };
}

async function serve(t, overrides = {}) {
  const rows = new Map();
  const mock = bitrixMock();
  const server = createApp({ bitrix: mock.client, database: {
    ping: async () => {}, saveCliente: async row => rows.set(row.id_negociacion, row),
  }, logger: { error() {} }, ...overrides });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { rows, calls: mock.calls, request: (path, options) => fetch(`http://127.0.0.1:${server.address().port}${path}`, options) };
}

test('GET y POST guardan el contacto principal y responden sin datos personales', async t => {
  const { request, rows, calls } = await serve(t);
  for (const method of ['GET', 'POST']) {
    const response = await request('/registrar-cliente?id=32135', { method });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.id_negociacion, '32135');
    assert.equal(body.telefono, undefined);
  }
  assert.equal(rows.size, 1);
  assert.equal(rows.get('32135').nombre_completo, "María José D'Ávila");
  assert.equal(rows.get('32135').telefono, '+57 3001234567');
  assert.equal(calls[2].id, '81');
});

test('rechaza IDs inválidos antes de consultar Bitrix', async t => {
  const { request, calls, rows } = await serve(t);
  for (const query of ['', '?id=0', '?id=-1', '?id=1.5', '?id=abc', '?id=1&id=2', '?id=9007199254740992', '?id=1%20OR%201=1']) {
    assert.equal((await request(`/registrar-cliente${query}`)).status, 400);
  }
  assert.equal(calls.length, 0);
  assert.equal(rows.size, 0);
});

test('vincula el teléfono cliente DEF aunque el contacto tenga otro número', async t => {
  const mock = bitrixMock({ 'crm.deal.get': { ID: '32135', CONTACT_ID: '81', UF_CRM_1584616588730: '573009990001' } });
  const { request, rows } = await serve(t, { bitrix: mock.client });
  assert.equal((await request('/registrar-cliente?id=32135')).status, 200);
  assert.equal(rows.get('32135').telefono, '573009990001');
  assert.equal(rows.get('32135').id_contacto, '81');
});

test('sin teléfono cliente DEF conserva el teléfono del contacto', async t => {
  for (const value of ['', '  ', null, false]) {
    const mock = bitrixMock({ 'crm.deal.get': { ID: '32135', CONTACT_ID: '81', UF_CRM_1584616588730: value } });
    const { request, rows } = await serve(t, { bitrix: mock.client });
    assert.equal((await request('/registrar-cliente?id=32135')).status, 200);
    assert.equal(rows.get('32135').telefono, '+57 3001234567');
  }
});

test('un teléfono cliente DEF inválido no vincula el número de otra persona', async t => {
  const mock = bitrixMock({ 'crm.deal.get': { ID: '32135', CONTACT_ID: '81', UF_CRM_1584616588730: 'pendiente' } });
  const { request, rows } = await serve(t, { bitrix: mock.client });
  const response = await request('/registrar-cliente?id=32135');
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error, 'TELEFONO_CLIENTE_INVALIDO');
  assert.equal(rows.size, 0);
});

test('token opcional funciona por encabezado o query', async t => {
  const { request, calls } = await serve(t, { webhookToken: 'test-secret' });
  assert.equal((await request('/registrar-cliente?id=32135')).status, 401);
  assert.equal(calls.length, 0);
  assert.equal((await request('/registrar-cliente?id=32135&token=test-secret')).status, 200);
  assert.equal((await request('/registrar-cliente?id=32135', { headers: { 'X-Webhook-Token': 'test-secret' } })).status, 200);
});

test('errores de Bitrix no escriben datos y no filtran credenciales', async t => {
  const cases = [
    [Response.json({ error: '', error_description: 'Not found' }, { status: 400 }), 404],
    [Response.json({ error: 'INVALID_CREDENTIALS', error_description: 'secret' }, { status: 401 }), 502],
    [new DOMException('secret', 'TimeoutError'), 504],
    [new Error('secret'), 502],
    [new Response('invalid json'), 502],
    [Response.json(null), 502],
  ];
  for (const [result, expected] of cases) {
    const { request, rows } = await serve(t, { bitrix: bitrixMock({ 'crm.deal.get': result }).client });
    const response = await request('/registrar-cliente?id=32135');
    assert.equal(response.status, expected);
    assert.equal((await response.text()).includes('secret'), false);
    assert.equal(rows.size, 0);
  }
});

test('sin contacto falla; sin teléfono conserva nombre y advierte', async t => {
  const empty = bitrixMock({ 'crm.deal.get': { ID: '32135', CONTACT_ID: '0' }, 'crm.deal.contact.items.get': [] });
  const noContact = await serve(t, { bitrix: empty.client });
  assert.equal((await noContact.request('/registrar-cliente?id=32135')).status, 422);
  assert.equal(noContact.rows.size, 0);
  const noPhone = await serve(t, { bitrix: bitrixMock({ 'crm.contact.get': { ...fixture, PHONE: [] } }).client });
  const response = await noPhone.request('/registrar-cliente?id=32135');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).advertencias.length, 1);
  assert.equal(noPhone.rows.get('32135').telefono, null);
});

test('un fallo MySQL nunca responde registro exitoso y health falla', async t => {
  const { request } = await serve(t, { database: {
    saveCliente: async () => { throw new Error('password'); },
    ping: async () => { throw new Error('password'); },
  } });
  for (const path of ['/registrar-cliente?id=32135', '/health']) {
    const response = await request(path);
    assert.equal(response.status, 503);
    assert.equal((await response.text()).includes('password'), false);
  }
});

test('rutas y métodos no autorizados no consultan Bitrix', async t => {
  const { request, calls } = await serve(t);
  assert.equal((await request('/otra-ruta')).status, 404);
  assert.equal((await request('/registrar-cliente?id=32135', { method: 'DELETE' })).status, 405);
  assert.equal((await request('/health')).status, 200);
  assert.equal(calls.length, 0);
});

test('valida configuración y normaliza URL Bitrix', () => {
  const env = { MYSQL_URL: 'mysql://root:pass@localhost/chatfuel', BITRIX_WEBHOOK_URL: 'https://example.test/rest/1/secret' };
  assert.equal(readConfig(env).bitrixUrl, `${env.BITRIX_WEBHOOK_URL}/`);
  assert.throws(() => readConfig({ ...env, MYSQL_URL: 'postgres://localhost/test' }));
  assert.throws(() => readConfig({ ...env, BITRIX_WEBHOOK_URL: 'http://example.test/rest/1/secret/' }));
});
