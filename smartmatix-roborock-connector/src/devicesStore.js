'use strict';

/**
 * devicesStore.js
 *
 * Liest und schreibt die HCU-Geräte (devices.json) sowie den Roborock-
 * Gerätecache (roborock.json). Die Dateien liegen im Arbeitsverzeichnis des
 * Plugins: /data
 *
 * Format der devices.json (ein Eintrag je HCU-Schalter):
 * {
 *   "roborock-1a2b3c-main": {
 *     "deviceType":      "SWITCH",
 *     "deviceId":        "roborock-1a2b3c-main",
 *     "friendlyName":    "Reinigen (Robbi)",
 *     "modelType":       "roborock-vacuum-robot",
 *     "features":        [ { "type": "switchState", "on": false }, { "type": "maintenance", "unreach": false } ],
 *     "duid":            "1a2b3c",
 *     "channel":         "main",            // oder "room-<Raum-ID>"
 *     "alreadyIncluded": true,              // per DISCOVER_RESPONSE an die HCU gemeldet
 *     "excluded":        false              // in der HCU gelöscht (EXCLUSION_EVENT)
 *   }
 * }
 *
 * Format der roborock.json (ein Eintrag je Gerät des Roborock-Kontos):
 * [
 *   {
 *     "duid":         "1a2b3c",
 *     "name":         "Robbi",
 *     "model":        "roborock.vacuum.s6",
 *     "productName":  "Roborock S6",
 *     "pv":           "1.0",               // Protokollversion
 *     "localKey":     "...",               // Schlüssel für die Nachrichten
 *     "supported":    true,                // Saugroboter mit Protokoll 1.0
 *     "online":       true,
 *     "addToHcu":     true,                // Haken "Zu Homematic IP hinzufügen"
 *     "roomSwitches": false,               // Haken "Schalter je Raum"
 *     "notifyCleaning": false,             // Haken "Hinweis bei laufender Reinigung"
 *     "notifyMaintenance": true,           // Haken "Wartungshinweise in der App" (Standard: an)
 *     "maintNotice": "filter,sensor",      // bereits gemeldete Wartungen (kein erneuter Hinweis nach Neustart)
 *     "rooms":        [ { "iotId": "123", "segmentId": 16, "name": "Küche", "active": true } ],
 *     "roomsAt":      0,                   // Zeitpunkt der letzten Raumabfrage
 *     "available":    true,                // noch im Konto vorhanden
 *     "firstSeen":    "2026-09-28T18:00:00.000Z"
 *   }
 * ]
 */

const fs   = require('fs');
const path = require('path');
const log  = require('./logger');

const DATA_PATH = fs.existsSync('/data')
  ? '/data'
  : path.join(__dirname, '..', 'data');

const FILES = {
  devices:  { file: 'devices.json',  empty: () => ({}) },
  roborock: { file: 'roborock.json', empty: () => [] },
};

function filePath(type) {
  const def = FILES[type];
  if (!def) throw new Error(`devicesStore: Unbekannter Typ "${type}"`);
  return path.join(DATA_PATH, def.file);
}

/**
 * Liest eine JSON-Datei vom Dateisystem.
 * @param {'devices'|'roborock'} type
 */
function load(type) {
  const fp = filePath(type);
  try {
    const raw = fs.readFileSync(fp, 'utf8');
    return raw.trim() ? JSON.parse(raw) : FILES[type].empty();
  } catch (err) {
    if (err.code !== 'ENOENT') log.warn(`Fehler beim Lesen der ${FILES[type].file}:`, err.message);
    return FILES[type].empty();
  }
}

/**
 * Schreibt Daten als JSON in die Datei des angegebenen Typs
 * @param {'devices'|'roborock'} type
 * @param {object|Array}      data
 */
function save(type, data) {
  const fp = filePath(type);
  try {
    fs.mkdirSync(DATA_PATH, { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(data, null, 2), 'utf8');
    log.debug(`${FILES[type].file} gespeichert.`);
  } catch (err) {
    log.error(`Fehler beim Schreiben der ${FILES[type].file}:`, err.message);
  }
}

module.exports = {
  load,
  save,
  loadRobots: () => load('roborock'),
  saveRobots: (list) => save('roborock', list),
};
