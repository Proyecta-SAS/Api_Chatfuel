import mysql from 'mysql2/promise';
import { readFile } from 'node:fs/promises';
import { phoneVariants } from './phone.js';
import { AppError } from './errors.js';
import { createSchedulingStore } from './calendar/store.js';
import { createFollowupStore } from './followups/store.js';

export const schemaUrl = new URL('../sql/001_clientes.sql', import.meta.url);

export function createDatabase(uri) {
  const pool = mysql.createPool({
    uri, connectionLimit: 5, waitForConnections: true, queueLimit: 100,
    connectTimeout: 10000, enableKeepAlive: true, charset: 'utf8mb4',
    supportBigNumbers: true, bigNumberStrings: true, timezone: 'Z',
  });
  return {
    scheduling: createSchedulingStore(pool),
    followups: createFollowupStore(pool),
    async init() {
      await pool.query(await readFile(schemaUrl, 'utf8'));
      for (const statement of (await readFile(new URL('../sql/002_agenda.sql', import.meta.url), 'utf8')).split(';').map(s => s.trim()).filter(Boolean)) {
        await pool.query(statement);
      }
      for(const statement of (await readFile(new URL('../sql/003_seguimientos.sql',import.meta.url),'utf8')).split(';').map(s=>s.trim()).filter(Boolean)){
        await pool.query(statement);
      }
    },
    async ping() { await pool.query({ sql: 'SELECT 1', timeout: 5000 }); },
    async findClienteByPhone(phone) {
      const variants = phoneVariants(phone);
      if (!variants.length) return null;
      const [rows] = await pool.execute({ sql: `
        SELECT id_negociacion, id_contacto FROM clientes
        WHERE telefono REGEXP '^[+0-9() .-]+$'
          AND REGEXP_REPLACE(telefono, '[^0-9]', '') IN (${variants.map(() => '?').join(',')})
        LIMIT 2
      `, timeout: 5000 }, variants);
      if (rows.length > 1) throw new AppError(409, 'TELEFONO_AMBIGUO', 'El teléfono tiene más de una negociación registrada.');
      return rows[0] ? { id_negociacion: String(rows[0].id_negociacion), id_contacto: String(rows[0].id_contacto) } : null;
    },
    async saveCliente(cliente) {
      await pool.execute(`
        INSERT INTO clientes (id_negociacion, id_contacto, nombres, apellidos, nombre_completo, telefono)
        VALUES (?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE id_contacto = ?, nombres = ?, apellidos = ?,
          nombre_completo = ?, telefono = ?, actualizado_en = CURRENT_TIMESTAMP(3)
      `, [cliente.id_negociacion, cliente.id_contacto, cliente.nombres, cliente.apellidos,
        cliente.nombre_completo, cliente.telefono, cliente.id_contacto, cliente.nombres,
        cliente.apellidos, cliente.nombre_completo, cliente.telefono]);
    },
    async close() { await pool.end(); },
  };
}
