import { readConfig } from './config.js';
import { createDatabase } from './database.js';
import { createBitrixClient } from './bitrix.js';
import { createApp } from './app.js';
import { createHandler, startHandoffListener } from './connector.mjs';
import { createSchedulingService, readAdvisors, startCrmSyncWorker } from './calendar/service.js';
import { readFollowupConfig } from './followups/policy.js';
import { createFollowupGateway } from './followups/gateway.js';
import { createFollowupService, startFollowupWorker } from './followups/service.js';
import { createFollowupHandler } from './followups/http.js';

let database;
let stopBookingListener;
let stopCrmSync;
let stopFollowups;
try {
  const config = readConfig();
  database = createDatabase(config.mysqlUrl);
  await database.init();
  const bitrix = createBitrixClient(config.bitrixUrl);
  const calendar = createBitrixClient(config.calendarUrl, { timeoutMs: 2500 });
  const scheduling = createSchedulingService({ database, bitrix, calendar, advisors: readAdvisors(process.env) });
  const bookingHandler = createHandler({ database, scheduling });
  const followupConfig=readFollowupConfig();
  const followups=createFollowupService({config:followupConfig,store:database.followups,
    gateway:createFollowupGateway({config:followupConfig,bitrix,bookingHandler})});
  const followupHandler=createFollowupHandler({service:followups,bookingHandler,secret:process.env.CHATFUEL_BOOKING_SECRET,
    contactPrefix:followupConfig.contactPrefix,testPhones:followupConfig.testPhones});
  const server = createApp({ database, bitrix, webhookToken: config.webhookToken, bookingHandler,followupHandler });
  server.listen(config.port, '0.0.0.0', () => console.log(`API escuchando en puerto ${config.port}`));
  server.on('error', () => { console.error('No se pudo iniciar el servidor HTTP.'); process.exit(1); });
  if (process.env.HANDOFF_SYNC_ENABLED === 'true') stopBookingListener = startHandoffListener(bookingHandler);
  stopCrmSync = startCrmSyncWorker(scheduling);
  stopFollowups=startFollowupWorker(followups);
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    stopBookingListener?.();
    stopCrmSync?.();
    stopFollowups?.();
    const deadline = setTimeout(() => process.exit(1), 15000);
    deadline.unref();
    server.close(async () => { await database.close(); clearTimeout(deadline); });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
} catch {
  console.error('No se pudo iniciar la API. Verifica MySQL, los webhooks Bitrix y APPOINTMENT_ADVISORS_JSON.');
  stopBookingListener?.();
  stopCrmSync?.();
  stopFollowups?.();
  if (database) await database.close();
  process.exitCode = 1;
}
