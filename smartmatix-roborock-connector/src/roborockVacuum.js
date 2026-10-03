'use strict';

/**
 * roborockVacuum.js – Befehle und Zustände der Roborock-Saugroboter (Protokoll 1.0)
 *
 * Unterstützt werden alle Saugroboter, die das V1-Protokoll ("1.0") sprechen –
 * das sind die S-, Q-, Qrevo- und Saros-Modelle (z. B. S5, S6, S7, S8, Q5, Q8).
 * Geräte mit den neueren Protokollen A01/B01 (Nass-Trocken-Sauger, Q7/Q10-Serie)
 * werden in den Einstellungen als "nicht unterstützt" angezeigt.
 */

const VACUUM_CATEGORY = 'robot.vacuum.cleaner';

// Zustandscodes (RoborockStateCode), in denen der Sauger reinigt
const CLEANING_STATES = new Set([
  1,    // starting
  4,    // remote_control_active
  5,    // cleaning
  7,    // manual_mode
  11,   // spot_cleaning
  16,   // going_to_target
  17,   // zoned_cleaning
  18,   // segment_cleaning
  6301, 6302, 6303, 6304, 6305, 6306, 6307, 6308, 6309,   // Wisch-/Kombi-Reinigung
]);

// Zustände, in denen eine laufende Reinigung (in_cleaning > 0) nur unterbrochen ist
const INTERRUPTED_STATES = new Set([
  10,   // paused
  22,   // emptying_the_bin
  23,   // washing_the_mop
  25,   // washing_the_mop
  26,   // going_to_wash_the_mop
  6310, // back_to_dock_washing_duster
]);

// in_cleaning: 0 = keine, 1 = gesamte Wohnung, 2 = Zone, 3 = Raum/Segment
const IN_CLEANING_SEGMENT = 3;

function isSupported(device, product) {
  return String(device?.pv ?? '1.0') === '1.0' && product?.category === VACUUM_CATEGORY;
}

function isVacuum(product) {
  return product?.category === VACUUM_CATEGORY;
}

/**
 * Normalisiert die Antwort von get_status
 * @returns {{state:number, battery:number|null, inCleaning:number}|null}
 */
function parseStatus(result) {
  const s = Array.isArray(result) ? result[0] : result;
  if (!s || typeof s !== 'object') return null;
  return {
    state:      Number(s.state ?? 0),
    battery:    s.battery ?? null,
    inCleaning: Number(s.in_cleaning ?? 0),
    errorCode:  Number(s.error_code ?? 0),
    dockError:  Number(s.dock_error_status ?? 0),   // nur Modelle mit Absaug-/Waschstation
  };
}

// Wartungsintervalle der Verschleißteile in Sekunden Laufzeit (wie python-roborock / Roborock-App)
const CONSUMABLE_LIMITS = {
  main_brush: { field: 'main_brush_work_time', limit: 300 * 3600 },
  side_brush: { field: 'side_brush_work_time', limit: 200 * 3600 },
  filter:     { field: 'filter_work_time',     limit: 150 * 3600 },
  sensor:     { field: 'sensor_dirty_time',    limit: 30 * 3600 },
};

/**
 * Fällige Wartungen aus der Antwort von get_consumable
 * @returns {string[]} Schlüssel aus CONSUMABLE_LIMITS, deren Intervall abgelaufen ist
 */
function parseConsumablesDue(result) {
  const c = Array.isArray(result) ? result[0] : result;
  if (!c || typeof c !== 'object') return [];
  return Object.entries(CONSUMABLE_LIMITS)
    .filter(([, def]) => Number.isFinite(Number(c[def.field])) && Number(c[def.field]) >= def.limit)
    .map(([key]) => key);
}

/** true, solange eine Reinigung läuft */
function isCleaning(status) {
  if (!status) return false;
  if (CLEANING_STATES.has(status.state)) return true;
  return status.inCleaning > 0 && INTERRUPTED_STATES.has(status.state);
}

/** Zonen- oder Spot-Reinigung */
function isZoneCleaning(status) {
  return isCleaning(status) && (status.inCleaning === 2 || status.state === 17 || status.state === 11);
}

function isSegmentCleaning(status) {
  return isCleaning(status) && (status.inCleaning === IN_CLEANING_SEGMENT || status.state === 18);
}

/**
 * Ordnet die Antwort von get_room_mapping den Raumnamen zu
 * Format: [[segmentId, iotRoomId, ...], ...] oder [segmentId, iotRoomId]
 * @returns {{segmentId:number, iotId:string}[]}
 */
function parseRoomMapping(result) {
  if (!Array.isArray(result)) return [];
  const pairs = (result.length >= 2 && !Array.isArray(result[0])) ? [result] : result;
  return pairs
    .filter(p => Array.isArray(p) && p.length >= 2)
    .map(p => ({ segmentId: Number(p[0]), iotId: String(p[1]) }));
}

// ---------------------------------------------------------------------------
//  Befehle
// ---------------------------------------------------------------------------

const getStatus      = async (cloud, duid) => parseStatus(await cloud.rpc(duid, 'get_status'));
const getConsumablesDue = async (cloud, duid) => parseConsumablesDue(await cloud.rpc(duid, 'get_consumable'));
const getRoomMapping = async (cloud, duid) => parseRoomMapping(await cloud.rpc(duid, 'get_room_mapping'));
const start          = (cloud, duid) => cloud.rpc(duid, 'app_start');

/**
 * Reinigung beenden und zur Ladestation zurückkehren
 */
const returnToDock = (cloud, duid) => cloud.rpc(duid, 'app_charge');

/** true, wenn der Sauger zur Station fährt, angedockt ist oder lädt. */
function isHeadingHome(status) {
  return Boolean(status) && [6, 8, 15, 100].includes(status.state);   // returning, charging, docking, charged
}

/**
 * Raumreinigung. Neuere Firmware erwartet [{segments, repeat}], ältere eine reine Liste. Das funktionierende Format wird je Sauger gemerkt.
 * @param {object} robot – Eintrag aus roborock.json (segmentFormat wird gesetzt)
 */
async function cleanSegments(cloud, robot, segmentIds) {
  const formats = robot.segmentFormat === 'list' ? ['list', 'object'] : ['object', 'list'];
  let lastErr;
  for (const f of formats) {
    const params = f === 'object' ? [{ segments: segmentIds, repeat: 1 }] : segmentIds;
    try {
      await cloud.rpc(robot.duid, 'app_segment_clean', params);
      robot.segmentFormat = f;
      return;
    } catch (err) {
      if (err.kind !== 'device') throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

module.exports = {
  isSupported, isVacuum, parseStatus, parseRoomMapping, isCleaning, isSegmentCleaning, isZoneCleaning,
  parseConsumablesDue, getConsumablesDue, CONSUMABLE_LIMITS,
  getStatus, getRoomMapping, start, returnToDock, isHeadingHome, cleanSegments,
};
