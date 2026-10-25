'use strict';

/**
 * configStore.js
 *
 * Liest und schreibt die Plugin-Konfiguration aus/in eine config.json.
 * Die Datei liegt im Arbeitsverzeichnis des Plugins: /data
 *
 * Inhalt config.json (Beispiel):
 * {
 *   "email":             "name@example.com",   // Roborock-Konto
 *   "userData":          { "token": "...", "rriot": { ... }, "baseUrl": "https://euiot.roborock.com" },
 *   "deviceIdentifier":  "...",                // stabile Client-ID für die Anmeldung
 *   "deviceAccount":     "rr...",              // Konto, zu dem die gespeicherten Geräte gehören
 *   "autoAddNewDevices": false,
 *   "pollInterval":      120
 * }
 */

const fs   = require('fs');
const path = require('path');
const log  = require('./logger');

const DATA_PATH = fs.existsSync('/data')
  ? '/data'
  : path.join(__dirname, '..', 'data');

const CONFIG_FILE = path.join(DATA_PATH, 'config.json');

// Standard-Konfiguration > wird verwendet wenn config.json noch nicht existiert
const DEFAULTS = {
  email:             '',
  userData:          null,   // Zugangsdaten nach erfolgreicher Anmeldung
  deviceIdentifier:  '',
  deviceAccount:     '',     // Kennung des Kontos der gespeicherten Geräte (Kontowechsel erkennen)
  autoAddNewDevices: false,
  pollInterval:      120,    // Sekunden
};

/**
 * Liest die config.json vom Dateisystem.
 * Falls die Datei nicht existiert, wird die Standard-Konfiguration zurückgegeben.
 * @returns {object} Konfigurationsobjekt
 */
function load() {
  try {
    const raw    = fs.readFileSync(CONFIG_FILE, 'utf8');
    const config = JSON.parse(raw);
    log.debug(`Konfiguration geladen aus: ${CONFIG_FILE}`);
    return { ...DEFAULTS, ...config };
  } catch (err) {
    if (err.code === 'ENOENT') {
      log.info('Keine config.json gefunden > verwende Standard-Konfiguration.');
    } else {
      log.warn('Fehler beim Lesen der config.json:', err.message);
    }
    return { ...DEFAULTS };
  }
}

/**
 * Schreibt das Konfigurationsobjekt in die config.json.
 * @param {object} config – Konfigurationsobjekt
 */
function save(config) {
  try {
    fs.mkdirSync(DATA_PATH, { recursive: true });
    // Atomar schreiben: erst Temp-Datei, dann umbenennen (nie eine halb geschriebene Datei)
    const tmp = `${CONFIG_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8');
    fs.renameSync(tmp, CONFIG_FILE);
    log.info(`Konfiguration gespeichert in: ${CONFIG_FILE}`);
  } catch (err) {
    log.error('Fehler beim Schreiben der config.json:', err.message);
  }
}

module.exports = { load, save, DEFAULTS };
