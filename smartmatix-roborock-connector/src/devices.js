'use strict';

/**
 * devices.js – Verwaltung der HCU-Geräte
 *
 * Hält die Geräte, die dieses Plugin gegenüber der HCU (Connect API 1.0.1)
 * repräsentiert, im Speicher und persistiert sie in der devices.json.
 *
 * Je Saugroboter gibt es einen Schalter "Reinigen (Gerätename)" (Kanal
 * "main") und optional je Raum einen Schalter "Reinige <Raum> (Gerätename)"
 * (Kanal "room-<Raum-ID>"). Die deviceId ist deterministisch
 * (roborock-<duid>-<kanal>), damit ein in der HCU gelöschtes Gerät beim
 * Reinkludieren wieder dieselbe ID erhält.
 */

const log          = require('./logger');
const devicesStore = require('./devicesStore');

const MODEL_TYPE = 'roborock-vacuum-robot';
const BATTERY_CHANNEL = 'battery';
// Akkukapazität in Wh für batteryState (S-Serie: 5200 mAh × 14,4 V ≈ 75 Wh)
const BATTERY_CAPACITY_WH = 75;

// Map<deviceId, deviceObject>
let registry = load();

function load() {
  const map = new Map(Object.entries(devicesStore.load('devices')));
  log.info(`${map.size} HCU-Geraet(e) aus devices.json geladen.`);
  return map;
}

function persist() {
  devicesStore.save('devices', Object.fromEntries(registry));
}

/** Kompakter Schlüssel einer Roborock-Geräte-ID (duid) */
function robotKey(duid) {
  return String(duid).replace(/[^0-9a-z]/gi, '');
}

function makeDeviceId(duid, channel) {
  return `roborock-${robotKey(duid)}-${channel}`;
}

function roomChannel(iotId) { return `room-${iotId}`; }

function getAll()            { return Array.from(registry.values()); }
function getById(deviceId)   { return registry.get(deviceId) ?? null; }
function getByDuid(duid)     { return getAll().filter(d => d.duid === duid); }

/** Aktive Geräte: an die HCU gemeldet und dort nicht gelöscht */
function getActive() {
  return getAll().filter(d => d.alreadyIncluded && !d.excluded);
}

/**
 * Legt einen Schalter für einen Sauger bzw. Raum an (falls noch nicht vorhanden)
 * @param {string} duid
 * @param {string} channel       'main' | 'room-<iotId>' | 'battery'
 * @param {string} friendlyName
 * @returns {object} das neue oder bestehende Gerät
 */
function ensure(duid, channel, friendlyName) {
  const deviceId = makeDeviceId(duid, channel);
  const existing = registry.get(deviceId);
  if (existing) {
    // Migration Sabotage aus älteren Versionen
    const m = existing.features.find(f => f.type === 'maintenance');
    if (channel === 'main' && m && m.sabotage === undefined) {
      m.sabotage = false;
      persist();
    }
    // Akku-Gerät aus 0.2.9 ohne lowBat-Attribut > ergänzen
    if (channel === BATTERY_CHANNEL && m && m.lowBat === undefined) {
      m.lowBat = false;
      persist();
    }
    // Fahrzeug aus älteren Versionen ohne Akkukapazität > ergänzen
    const b = existing.features.find(f => f.type === 'batteryState');
    if (channel === BATTERY_CHANNEL && b && b.batteryCapacity === undefined) {
      b.batteryCapacity = BATTERY_CAPACITY_WH;
      persist();
    }
    return existing;
  }

  // Akku: VEHICLE mit batteryState (0–1); Schalter: SWITCH.
  // Sabotage am Hauptschalter = Sauger meldet einen Fehler (steckt fest, Bürste blockiert, etc.)
  const isBattery = channel === BATTERY_CHANNEL;
  const device = {
    deviceType:      isBattery ? 'VEHICLE' : 'SWITCH',
    deviceId,
    friendlyName:    sanitize(friendlyName),
    modelType:       MODEL_TYPE,
    features:        isBattery
      ? [{ type: 'batteryState', batteryLevel: 0, batteryCapacity: BATTERY_CAPACITY_WH }, { type: 'maintenance', unreach: false, lowBat: false }]
      : [{ type: 'switchState', on: false },
         channel === 'main' ? { type: 'maintenance', unreach: false, sabotage: false } : { type: 'maintenance', unreach: false }],
    duid,
    channel,
    alreadyIncluded: false,
    excluded:        false,
  };
  registry.set(deviceId, device);
  persist();
  log.info(`HCU-Geraet angelegt: ${deviceId} fuer "${device.friendlyName}"`);
  return device;
}

/** Entfernt ein HCU-Gerät aus der Registry */
function remove(deviceId) {
  if (registry.delete(deviceId)) {
    persist();
    log.info(`HCU-Geraet entfernt: ${deviceId}`);
  }
}

/** Setzt Flags (alreadyIncluded, excluded) für mehrere Geräte */
function setFlags(deviceIds, flags) {
  let changed = false;
  for (const id of deviceIds) {
    const d = registry.get(id);
    if (!d) continue;
    Object.assign(d, flags);
    changed = true;
  }
  if (changed) persist();
}

/**
 * Übernimmt Features in das Gerät (Werte werden überschrieben, neue Feature-Typen ignoriert) und persistiert
 */
function mergeFeatures(deviceId, features) {
  const d = registry.get(deviceId);
  if (!d) return;
  for (const incoming of features) {
    const existing = d.features.find(f => f.type === incoming.type);
    if (existing) Object.assign(existing, incoming);
  }
  persist();
}

/** Nur die Felder des Device-Schemas der Connect API (für DISCOVER/STATUS) */
function toHcu(device) {
  return {
    deviceId:     device.deviceId,
    deviceType:   device.deviceType,
    friendlyName: device.friendlyName,
    modelType:    device.modelType,
    ...(device.firmwareVersion ? { firmwareVersion: device.firmwareVersion } : {}),
    features:     device.features,
  };
}

function reload() { registry = load(); }

/** Bereinigt kaputte Encoding-Zeichen (HCU-Bug Workaround) */
function sanitize(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/�/g, '?');
}

module.exports = {
  MODEL_TYPE, BATTERY_CHANNEL, BATTERY_CAPACITY_WH,
  getAll, getById, getByDuid, getActive,
  ensure, remove, setFlags, mergeFeatures, toHcu, reload,
  robotKey, makeDeviceId, roomChannel, sanitize,
};
