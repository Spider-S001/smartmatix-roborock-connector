'use strict';

/**
 * Homematic IP Connect API – SmartMatix Roborock Connector (Node.js)
 *
 * Einstiegspunkt. Liest den Auth-Token aus /TOKEN mit Retry-Logik
 * (die HCU schreibt /TOKEN asynchron nach dem Containerstart) und
 * startet dann den WebSocket-Client.
 */

const fs     = require('fs');
const Plugin = require('./plugin');
const log    = require('./logger');

const TOKEN_RETRY_INTERVAL_MS = 2_000;
const TOKEN_MAX_RETRIES       = 60;

const [pluginId, host, authtokenFile] = process.argv.slice(2);

if (!pluginId || !host || !authtokenFile) {
  log.error('Verwendung: node src/index.js <plugin-id> <hcu-host> <authtoken-datei>');
  process.exit(1);
}

// ---------------------------------------------------------------------------
//  Globale Fehlerbehandlung – Prozess darf nie unkontrolliert beendet werden
// ---------------------------------------------------------------------------

process.on('uncaughtException', (err) => {
  log.error('Unbehandelte Exception:', err.message, err.stack);
});

process.on('unhandledRejection', (reason) => {
  log.error('Unbehandelte Promise-Rejection:', reason?.message ?? reason);
});

// ---------------------------------------------------------------------------
//  /TOKEN mit Retry lesen (HCU schreibt die Datei asynchron nach dem Start)
// ---------------------------------------------------------------------------

function readTokenWithRetry(filePath, attempt = 1) {
  try {
    const token = fs.readFileSync(filePath, 'utf8').trim();
    if (token) {
      log.info(`Auth-Token gelesen (Versuch ${attempt}).`);
      return Promise.resolve(token);
    }
    throw new Error('Token-Datei ist leer.');
  } catch (err) {
    if (attempt >= TOKEN_MAX_RETRIES) {
      return Promise.reject(new Error(
        `Auth-Token konnte nach ${TOKEN_MAX_RETRIES} Versuchen nicht gelesen werden: ${err.message}`
      ));
    }
    log.info(`Auth-Token noch nicht verfuegbar (Versuch ${attempt}/${TOKEN_MAX_RETRIES}) > warte ${TOKEN_RETRY_INTERVAL_MS}ms ...`);
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        readTokenWithRetry(filePath, attempt + 1).then(resolve).catch(reject);
      }, TOKEN_RETRY_INTERVAL_MS);
    });
  }
}

// ---------------------------------------------------------------------------
//  Start
// ---------------------------------------------------------------------------

log.info('=== Homematic IP Connect API Plugin SmartMatix Roborock Connector ===');
log.info(`Plugin-ID : ${pluginId}`);
log.info(`HCU-Host  : ${host}`);
log.info(`Token-Datei: ${authtokenFile}`);

readTokenWithRetry(authtokenFile)
  .then((authtoken) => {
    const plugin = new Plugin({ pluginId, host, authtoken });

    process.on('SIGINT',  () => plugin.stop());
    process.on('SIGTERM', () => plugin.stop());

    plugin.start();
  })
  .catch((err) => {
    log.error('Fataler Fehler beim Start:', err.message);
  });
