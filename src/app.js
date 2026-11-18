import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { AppError } from './errors.js';
import { validId } from './bitrix.js';

function tokenMatches(actual, expected) {
  const a = Buffer.from(actual || '');
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createApp({ bitrix, database, webhookToken = '', logger = console, bookingHandler = null, followupHandler = null }) {
  return createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const send = (status, data) => { res.writeHead(status); res.end(JSON.stringify(data)); };
    try {
      const url = new URL(req.url, 'http://localhost');
      const routedHandler=followupHandler && ['/followups/resume','/followups/cancel','/followups/status'].includes(url.pathname)
        ? followupHandler : bookingHandler && ['/booking','/sync-handoffs'].includes(url.pathname) ? bookingHandler : null;
      if (routedHandler) {
        const startedAt = Date.now();
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
          if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
        }
        const chunks = [];
        let size = 0;
        if (!['GET', 'HEAD'].includes(req.method)) {
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 65536) throw new AppError(413, 'CUERPO_DEMASIADO_GRANDE', 'La solicitud supera el tamaño permitido.');
            chunks.push(chunk);
          }
        }
        const requestBody = Buffer.concat(chunks);
        const response = await routedHandler(new Request(url, {
          method: req.method, headers,
          ...(!['GET', 'HEAD'].includes(req.method) ? { body: requestBody } : {}),
        }));
        const responseBody = Buffer.from(await response.arrayBuffer());
        if (url.pathname === '/booking') {
          try {
            const input = JSON.parse(requestBody.toString('utf8'));
            const output = JSON.parse(responseBody.toString('utf8'));
            const step = output.state ? JSON.parse(Buffer.from(output.state.split('.')[0], 'base64url').toString('utf8')).step : null;
            logger.info?.({ evento: 'agenda_chatfuel',
              operacion: ['start', 'step'].includes(input.operation) ? input.operation : 'invalida',
              estado_http: response.status, etapa: typeof step === 'string' ? step : null,
              finalizada: output.done === 'si', error: output.error || null,
              causa: ['CRM_UNAUTHORIZED', 'CRM_UNAVAILABLE', 'CRM_INVALID_RESPONSE', 'CHATFUEL_UNAVAILABLE',
                'ADVISOR_NOT_ASSIGNED', 'LEAD_NOT_PERSISTED', 'INTEGRATION_UNAVAILABLE'].includes(output.cause) ? output.cause : null,
              duracion_ms: Date.now() - startedAt });
          } catch { /* El diagnóstico no debe cambiar la respuesta HTTP. */ }
        }
        for (const [key, value] of response.headers) res.setHeader(key, value);
        res.writeHead(response.status);
        return res.end(responseBody);
      }
      if (url.pathname === '/health' && req.method === 'GET') {
        try { await database.ping(); } catch { throw new AppError(503, 'DB_NO_DISPONIBLE', 'La base de datos no está disponible.'); }
        if (bookingHandler) {
          const health = await bookingHandler(new Request(url));
          const details = await health.json();
          return send(health.status, { ...details, service: 'api-chatfuel', mysql: { ok: true } });
        }
        return send(200, { ok: true });
      }
      if (url.pathname !== '/registrar-cliente') throw new AppError(404, 'RUTA_NO_ENCONTRADA', 'Ruta no encontrada.');
      if (!['GET', 'POST'].includes(req.method)) {
        res.setHeader('Allow', 'GET, POST');
        throw new AppError(405, 'METODO_NO_PERMITIDO', 'Usa GET o POST.');
      }
      if (webhookToken && !tokenMatches(req.headers['x-webhook-token'] || url.searchParams.get('token'), webhookToken)) {
        throw new AppError(401, 'NO_AUTORIZADO', 'Token de webhook inválido.');
      }
      const ids = url.searchParams.getAll('id');
      if (ids.length !== 1 || !validId(ids[0])) throw new AppError(400, 'ID_INVALIDO', 'Envía un único id de negociación entero positivo.');
      const cliente = await bitrix.getCliente(ids[0]);
      try { await database.saveCliente(cliente); }
      catch { throw new AppError(503, 'DB_NO_DISPONIBLE', 'No se pudo guardar el cliente. Puedes reintentar la solicitud.'); }
      return send(200, {
        ok: true, id_negociacion: cliente.id_negociacion,
        mensaje: 'Cliente registrado o actualizado correctamente.',
        ...(cliente.telefono ? {} : { advertencias: ['El contacto no tiene teléfono en Bitrix.'] }),
      });
    } catch (error) {
      // No registrar URLs, credenciales ni datos personales en los errores.
      logger.error({ code: error instanceof AppError ? error.code : 'ERROR_INTERNO' });
      send(error instanceof AppError ? error.status : 500, {
        ok: false,
        error: error instanceof AppError ? error.code : 'ERROR_INTERNO',
        mensaje: error instanceof AppError ? error.message : 'Error interno del servidor.',
      });
    }
  });
}
