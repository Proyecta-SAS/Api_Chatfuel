import { AppError } from './errors.js';
import { phoneVariants } from './phone.js';

export const CLIENT_PHONE_FIELD = 'UF_CRM_1584616588730';

export function validId(value) {
  return typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value)
    && Number.isSafeInteger(Number(value));
}

export function createBitrixClient(baseUrl, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  async function call(method, params = {}) {
    let response, payload;
    try {
      response = await fetchImpl(new URL(`${method}.json`, baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(typeof params === 'object' ? params : { id: params }),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
      payload = await response.json();
    } catch (error) {
      const timeout = ['TimeoutError', 'AbortError'].includes(error.name);
      const failure = new AppError(timeout ? 504 : 502, timeout ? 'BITRIX_TIMEOUT' : 'BITRIX_NO_DISPONIBLE',
        timeout ? 'Bitrix tardó demasiado en responder.' : 'No se pudo consultar Bitrix.');
      failure.retryable = true;
      throw failure;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new AppError(502, 'BITRIX_RESPUESTA_INVALIDA', 'Bitrix devolvió una respuesta inválida.');
    }
    if (!response.ok || Object.hasOwn(payload, 'error')) {
      if (method === 'crm.deal.get' && (payload.error === 'NOT_FOUND'
          || (payload.error === '' && payload.error_description === 'Not found'))) {
        throw new AppError(404, 'NEGOCIACION_NO_ENCONTRADA', 'La negociación no existe en Bitrix.');
      }
      const failure = new AppError(502, 'BITRIX_ERROR', 'Bitrix rechazó la consulta. Verifica el webhook y sus permisos.');
      failure.retryable = response.status === 429 || response.status >= 500;
      throw failure;
    }
    if (payload.result == null || payload.result === false) {
      throw new AppError(502, 'BITRIX_RESPUESTA_INVALIDA', 'Bitrix devolvió una respuesta inválida.');
    }
    return payload.result;
  }

  return {
    call,
    async getCliente(id) {
      const deal = await call('crm.deal.get', id);
      if (String(deal.ID) !== id) throw new AppError(502, 'BITRIX_RESPUESTA_INVALIDA', 'La negociación recibida no corresponde al ID solicitado.');
      const links = await call('crm.deal.contact.items.get', id);
      if (!Array.isArray(links)) throw new AppError(502, 'BITRIX_RESPUESTA_INVALIDA', 'Bitrix no devolvió la lista de contactos.');
      const primary = links.find(link => link.IS_PRIMARY === 'Y')
        ?? [...links].sort((a, b) => Number(a.SORT || 0) - Number(b.SORT || 0))[0];
      const contactId = String(primary?.CONTACT_ID ?? deal.CONTACT_ID ?? '');
      if (!validId(contactId)) throw new AppError(422, 'SIN_CONTACTO', 'La negociación no tiene un contacto asociado.');
      const contact = await call('crm.contact.get', contactId);
      if (String(contact.ID) !== contactId) throw new AppError(502, 'BITRIX_RESPUESTA_INVALIDA', 'Bitrix devolvió un contacto inválido.');
      const nombres = [contact.NAME, contact.SECOND_NAME].filter(Boolean).join(' ').trim();
      const apellidos = String(contact.LAST_NAME || '').trim();
      const nombreCompleto = [nombres, apellidos].filter(Boolean).join(' ');
      if (!nombreCompleto) throw new AppError(422, 'SIN_NOMBRE', 'El contacto no tiene nombre.');
      const phones = Array.isArray(contact.PHONE)
        ? contact.PHONE.filter(phone => typeof phone.VALUE === 'string' && phone.VALUE.trim()) : [];
      const phone = phones.find(p => p.VALUE_TYPE === 'MOBILE') ?? phones.find(p => p.VALUE_TYPE === 'WORK') ?? phones[0];
      // Campaigns store the actual customer's phone on the deal; its linked
      // contact can belong to the person who created the test or lead.
      const customerPhone = deal[CLIENT_PHONE_FIELD];
      const dealPhone = customerPhone == null || customerPhone === false ? '' : String(customerPhone).trim();
      if (dealPhone && !phoneVariants(dealPhone).length) {
        throw new AppError(422, 'TELEFONO_CLIENTE_INVALIDO', 'Revisa el campo TELÉFONO CLIENTE (DEF) de la negociación.');
      }
      const telefono = dealPhone || phone?.VALUE.trim() || null;
      if (nombres.length > 255 || apellidos.length > 255 || (telefono?.length ?? 0) > 100) {
        throw new AppError(422, 'DATOS_DEMASIADO_LARGOS', 'El nombre o teléfono supera la longitud permitida.');
      }
      return { id_negociacion: id, id_contacto: contactId, nombres, apellidos, nombre_completo: nombreCompleto, telefono };
    },
  };
}
