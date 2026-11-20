import { createHash } from 'node:crypto';

export function createFollowupStore(pool) {
  return {
    async discoveryCursor(){
      const [rows]=await pool.execute('SELECT ultimo_id FROM chatfuel_seguimientos_cursor WHERE id=1');
      return String(rows[0]?.ultimo_id||'0');
    },
    async advanceCursor(id){
      if(!/^\d+$/.test(String(id)))throw new Error('INVALID_DISCOVERY_CURSOR');
      await pool.execute(`INSERT INTO chatfuel_seguimientos_cursor(id,ultimo_id) VALUES(1,?)
        ON DUPLICATE KEY UPDATE ultimo_id=GREATEST(ultimo_id,VALUES(ultimo_id))`,[String(id)]);
    },
    async nextSetter(ids) {
      const db=await pool.getConnection();
      try{
        await db.beginTransaction();
        await db.execute("INSERT IGNORE INTO chatfuel_seguimientos_reparto(id,turno) VALUES(1,0)");
        const [rows]=await db.execute('SELECT turno FROM chatfuel_seguimientos_reparto WHERE id=1 FOR UPDATE');
        const next=ids[Number(rows[0].turno)%ids.length];
        await db.execute('UPDATE chatfuel_seguimientos_reparto SET turno=turno+1 WHERE id=1');
        await db.commit();return next;
      }catch(error){await db.rollback();throw error;}finally{db.release();}
    },
    async withContact(channel, phone, action) {
      const db = await pool.getConnection();
      const key = 'followup:' + createHash('sha256').update(`${channel}:${phone}`).digest('hex').slice(0,55);
      let acquired = false, releaseFailed = false;
      try {
        const [locks] = await db.execute('SELECT GET_LOCK(?, 1) AS acquired', [key]);
        if (Number(locks[0].acquired) !== 1) throw new Error('FOLLOWUP_BUSY');
        acquired = true;
        const [rows] = await db.execute('SELECT datos FROM chatfuel_seguimientos WHERE canal=? AND telefono=?', [channel,phone]);
        let current = rows[0]?.datos;
        if (typeof current === 'string') current = JSON.parse(current);
        return await action(current || null, async value => {
          await db.execute(`INSERT INTO chatfuel_seguimientos(canal,telefono,datos) VALUES(?,?,?)
            ON DUPLICATE KEY UPDATE datos=VALUES(datos)`, [channel,phone,JSON.stringify(value)]);
        });
      } finally {
        if (acquired) { try { await db.execute('SELECT RELEASE_LOCK(?)',[key]); } catch { releaseFailed = true; } }
        if (releaseFailed) db.destroy(); else db.release();
      }
    },
    async pending(at) {
      const [rows] = await pool.execute(`SELECT canal AS channel,telefono AS phone FROM chatfuel_seguimientos
        WHERE JSON_UNQUOTE(JSON_EXTRACT(datos,'$.status')) IN ('waiting_initial','pending','awaiting_activity','delivery_pending','handoff_pending')
          AND JSON_UNQUOTE(JSON_EXTRACT(datos,'$.nextDueAt'))<=?
        ORDER BY JSON_UNQUOTE(JSON_EXTRACT(datos,'$.nextDueAt')),actualizado_en LIMIT 20`,[at]);
      return rows;
    },
  };
}
