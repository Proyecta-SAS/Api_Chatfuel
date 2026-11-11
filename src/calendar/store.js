import { createHash, randomUUID } from 'node:crypto';

const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const iso = value => new Date(value).toISOString();
const appointment = row => row && ({ id: row.id, clientCode: row.cliente_codigo,
  advisorId: row.asesor_id, bitrixUserId: row.bitrix_usuario_id, bitrixEventId: row.bitrix_evento_id,
  key: row.clave_idempotencia, startAt: iso(row.inicio), endAt: iso(row.fin), status: row.estado,
  request: parse(row.solicitud), response: parse(row.respuesta), createdAt: iso(row.creado_en) });

export function createSchedulingStore(pool, executor = pool) {
  const store = {
    async withLock(key, action) {
      // GET_LOCK is connection scoped: keep this connection until release, including
      // the durable pending write before the external event creation.
      const connection = executor === pool ? await pool.getConnection() : executor;
      const name = 'cf:' + createHash('sha256').update(key).digest('hex').slice(0, 60);
      let acquired = false, releaseFailed = false;
      try {
        const [rows] = await connection.execute('SELECT GET_LOCK(?, 10) AS acquired', [name]);
        if (Number(rows[0].acquired) !== 1) throw new Error('BOOKING_BUSY');
        acquired = true;
        return await action(createSchedulingStore(pool, connection));
      } finally {
        if (acquired) { try { await connection.execute('SELECT RELEASE_LOCK(?)', [name]); } catch { releaseFailed = true; } }
        if (executor === pool) { if (releaseFailed) connection.destroy(); else connection.release(); }
      }
    },
    async resolveProfile(phone, preferredCode) {
      return store.withLock('profile:' + phone, async locked => {
        const [rows] = await locked.sql('SELECT * FROM chatfuel_perfiles WHERE telefono=?', [phone]);
        if (rows[0]) return { clientCode: rows[0].codigo, name: rows[0].nombre, phone, data: parse(rows[0].datos) };
        const code = preferredCode || 'CF-' + randomUUID();
        if (!/^[\w:-]{1,128}$/.test(code)) throw new Error('INVALID_CLIENT_CODE');
        await locked.sql('INSERT INTO chatfuel_perfiles(codigo,telefono,datos) VALUES(?,?,?)', [code, phone, '{}']);
        return { clientCode: code, name: 'Contacto WhatsApp', phone, data: {} };
      });
    },
    async getProfile(code) {
      const [rows] = await executor.execute('SELECT * FROM chatfuel_perfiles WHERE codigo=?', [code]);
      return rows[0] && { clientCode: rows[0].codigo, name: rows[0].nombre, phone: rows[0].telefono, data: parse(rows[0].datos) };
    },
    async saveProfile(profile, body) {
      await executor.execute('UPDATE chatfuel_perfiles SET nombre=?,conversacion=?,datos=? WHERE codigo=?',
        [body.contactName || profile.name, body.externalConversationId || null,
          JSON.stringify({ ...profile.data, ...body, answers: { ...profile.data?.answers, ...body.answers } }), profile.clientCode]);
    },
    async hasActiveAppointment(code) {
      const [rows] = await executor.execute("SELECT id FROM chatfuel_citas WHERE cliente_codigo=? AND estado IN ('pending','confirmed') LIMIT 1", [code]);
      return rows.length > 0;
    },
    async saveRejectionSync(code, sync) {
      await executor.execute("UPDATE chatfuel_perfiles SET datos=JSON_SET(datos,'$.rejectionSync',JSON_EXTRACT(?,'$')) WHERE codigo=?", [JSON.stringify(sync), code]);
    },
    async pendingRejectionProfiles(at) {
      const [rows] = await executor.execute(`SELECT codigo FROM chatfuel_perfiles
        WHERE JSON_UNQUOTE(JSON_EXTRACT(datos,'$.rejectionSync.status'))='pending'
          AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(datos,'$.rejectionSync.reviewRequired')),'false')<>'true'
          AND JSON_UNQUOTE(JSON_EXTRACT(datos,'$.rejectionSync.nextAttemptAt'))<=?
        ORDER BY actualizado_en LIMIT 5`, [at]);
      return rows.map(row => row.codigo);
    },
    async getByKey(key) {
      const [rows] = await executor.execute('SELECT * FROM chatfuel_citas WHERE clave_idempotencia=?', [key]);
      return appointment(rows[0]);
    },
    async getAppointment(id) {
      const [rows] = await executor.execute('SELECT * FROM chatfuel_citas WHERE id=?', [id]);
      return appointment(rows[0]);
    },
    async latestAppointment(code) {
      const [rows] = await executor.execute("SELECT * FROM chatfuel_citas WHERE cliente_codigo=? AND estado IN ('pending','confirmed') ORDER BY creado_en DESC,inicio DESC,id DESC LIMIT 1", [code]);
      return appointment(rows[0]);
    },
    async saveFeedbackSync(id, sync) {
      await executor.execute("UPDATE chatfuel_citas SET respuesta=JSON_SET(respuesta,'$.feedbackSync',JSON_EXTRACT(?,'$')) WHERE id=?", [JSON.stringify(sync),id]);
    },
    async pendingFeedbackAppointments(at) {
      const [rows] = await executor.execute(`SELECT id FROM chatfuel_citas WHERE estado='confirmed' AND bitrix_evento_id IS NOT NULL
        AND JSON_UNQUOTE(JSON_EXTRACT(respuesta,'$.feedbackSync.status'))='pending'
        AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(respuesta,'$.feedbackSync.reviewRequired')),'false')<>'true'
        AND (JSON_EXTRACT(respuesta,'$.feedbackSync.nextAttemptAt') IS NULL
          OR JSON_UNQUOTE(JSON_EXTRACT(respuesta,'$.feedbackSync.nextAttemptAt'))='null'
          OR JSON_UNQUOTE(JSON_EXTRACT(respuesta,'$.feedbackSync.nextAttemptAt'))<=?)
        ORDER BY creado_en LIMIT 5`, [at]);
      return rows.map(row=>row.id);
    },
    async commentStatus(hash) {
      const [rows] = await executor.execute('SELECT estado FROM chatfuel_comentarios WHERE huella=?', [hash]);
      return rows[0]?.estado || null;
    },
    async reservations(from, to) {
      const [rows] = await executor.execute(`SELECT * FROM chatfuel_citas WHERE estado IN ('pending','confirmed') AND inicio<? AND fin>?`,
        [new Date(`${to}T23:59:59.999-05:00`), new Date(`${from}T00:00:00-05:00`)]);
      return rows.map(appointment);
    },
    async insertPending(row) {
      await executor.execute(`INSERT INTO chatfuel_citas(id,cliente_codigo,asesor_id,bitrix_usuario_id,clave_idempotencia,inicio,fin,estado,solicitud,respuesta)
        VALUES(?,?,?,?,?,?,?,'pending',?,?)`, [row.id, row.clientCode, row.advisorId, row.bitrixUserId, row.key,
        new Date(row.startAt), new Date(row.endAt), JSON.stringify(row.request), JSON.stringify(row.response)]);
    },
    async confirm(id, eventId, response) {
      await executor.execute("UPDATE chatfuel_citas SET estado='confirmed',bitrix_evento_id=?,respuesta=? WHERE id=?", [eventId, JSON.stringify(response), id]);
    },
    async saveSync(id, response) { await executor.execute('UPDATE chatfuel_citas SET respuesta=? WHERE id=?', [JSON.stringify(response), id]); },
    async pendingCrmAppointments(at) {
      const [rows] = await executor.execute(`SELECT id FROM chatfuel_citas WHERE estado='confirmed' AND bitrix_evento_id IS NOT NULL
        AND JSON_UNQUOTE(JSON_EXTRACT(respuesta,'$.crmSync.stageId'))='C370:EXECUTING'
        AND JSON_UNQUOTE(JSON_EXTRACT(respuesta,'$.crmSync.status'))='pending'
        AND JSON_UNQUOTE(JSON_EXTRACT(respuesta,'$.crmSync.requiresResponsible'))='true'
        AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(respuesta,'$.crmSync.reviewRequired')),'false')<>'true'
        AND (JSON_EXTRACT(respuesta,'$.crmSync.nextAttemptAt') IS NULL
          OR JSON_UNQUOTE(JSON_EXTRACT(respuesta,'$.crmSync.nextAttemptAt'))<=?)
        ORDER BY creado_en LIMIT 5`, [at]);
      return rows.map(row=>row.id);
    },
    async hasNewerBooking(row) {
      const [rows] = await executor.execute(`SELECT id FROM chatfuel_citas WHERE estado='confirmed' AND id<>?
        AND JSON_UNQUOTE(JSON_EXTRACT(respuesta,'$.crmSync.dealId'))=?
        AND JSON_UNQUOTE(JSON_EXTRACT(respuesta,'$.crmSync.requiresResponsible'))='true'
        AND creado_en>=? LIMIT 1`, [row.id,String(row.response.crmSync.dealId),new Date(row.createdAt)]);
      return rows.length>0;
    },
    async claimComment(hash, dealId) {
      const [result] = await executor.execute('INSERT IGNORE INTO chatfuel_comentarios(huella,negociacion_id) VALUES(?,?)', [hash, dealId]);
      return result.affectedRows === 1;
    },
    async confirmComment(hash, id) {
      await executor.execute("UPDATE chatfuel_comentarios SET estado='confirmed',comentario_id=? WHERE huella=?", [String(id), hash]);
    },
    sql: (query, params) => executor.execute(query, params),
  };
  return store;
}
