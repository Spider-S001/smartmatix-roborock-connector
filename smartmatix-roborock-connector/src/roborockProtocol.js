'use strict';

/**
 * roborockProtocol.js – Nachrichtenformat der Roborock-Cloud (Protokoll "1.0")
 *
 * Portiert aus python-roborock (protocol.py, protocols/v1_protocol.py,
 * devices/transport/local_channel.py).
 *
 * Aufbau einer Nachricht (Big Endian):
 *   version   3 Byte  "1.0"
 *   seq       uint32
 *   random    uint32
 *   timestamp uint32
 *   protocol  uint16  0/1 Hello, 2/3 Ping, 4/5 lokaler Befehl, 101/102 Cloud-Befehl
 *   length    uint16
 *   payload   AES-128-ECB (PKCS7), Schlüssel = md5(encTs + localKey + SALT)
 *   crc32     uint32  über alle vorherigen Bytes
 *
 * Nachrichten ohne Nutzdaten (Hello/Ping) haben kein Längenfeld. Lokal (TCP 58867) steht vor jeder Nachricht ihre Länge
 * (uint32). Neuere Firmware spricht lokal "L01" (AES-256-GCM statt ECB).
 */

const crypto = require('crypto');

const SALT    = 'TXdfu$jyZ#TZHsg4';
const VERSION = '1.0';

const PROTOCOL = {
  HELLO_REQUEST:    0,
  HELLO_RESPONSE:   1,
  PING_REQUEST:     2,
  PING_RESPONSE:    3,
  GENERAL_REQUEST:  4,     // lokale Befehle
  GENERAL_RESPONSE: 5,
  RPC_REQUEST:      101,   // Befehle über die Cloud
  RPC_RESPONSE:     102,
};

// Datenpunkte, die V1-Sauger unaufgefordert pushen
const DPS = {
  ERROR_CODE: 120,
  STATE:      121,
  BATTERY:    122,
};

const md5    = (data) => crypto.createHash('md5').update(data).digest();
const md5hex = (data) => crypto.createHash('md5').update(data).digest('hex');

// ---------------------------------------------------------------------------
//  CRC32
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ---------------------------------------------------------------------------
//  Verschlüsselung
// ---------------------------------------------------------------------------

/** Zeitstempel als Hex mit vertauschten Stellen (Roborock-spezifisch). */
function encodeTimestamp(ts) {
  const hex = (ts >>> 0).toString(16).padStart(8, '0');
  return [5, 6, 3, 7, 1, 2, 0, 4].map(i => hex[i]).join('');
}

function messageKey(timestamp, localKey) {
  return md5(Buffer.from(encodeTimestamp(timestamp) + localKey + SALT, 'utf8'));
}

function encryptEcb(plain, key) {
  const c = crypto.createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([c.update(plain), c.final()]);
}

function decryptEcb(cipher, key) {
  const d = crypto.createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([d.update(cipher), d.final()]);
}

let seqCounter    = crypto.randomInt(100000, 999999);
let randomCounter = crypto.randomInt(10000, 99999);
const nextSeq    = () => (seqCounter    = seqCounter    >= 999999 ? 100000 : seqCounter + 1);
const nextRandom = () => (randomCounter = randomCounter >= 99999  ? 10000  : randomCounter + 1);

// ---------------------------------------------------------------------------
//  L01 (neuere Firmware, nur lokal): AES-256-GCM
// ---------------------------------------------------------------------------

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; };

function l01Key(timestamp, localKey) {
  return crypto.createHash('sha256').update(Buffer.from(encodeTimestamp(timestamp) + localKey + SALT, 'utf8')).digest();
}
function l01Iv(timestamp, nonce, seq) {
  return crypto.createHash('sha256').update(Buffer.concat([u32(seq), u32(nonce), u32(timestamp)])).digest().subarray(0, 12);
}
function l01Aad(timestamp, nonce, seq, connectNonce, ackNonce) {
  return Buffer.concat([u32(seq), u32(connectNonce), ...(ackNonce != null ? [u32(ackNonce)] : []), u32(nonce), u32(timestamp)]);
}
function encryptL01(plain, localKey, { timestamp, seq, random }, { connectNonce, ackNonce }) {
  const c = crypto.createCipheriv('aes-256-gcm', l01Key(timestamp, localKey), l01Iv(timestamp, random, seq));
  c.setAAD(l01Aad(timestamp, random, seq, connectNonce, ackNonce));
  return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
}
function decryptL01(data, localKey, { timestamp, seq, random }, { connectNonce, ackNonce }) {
  if (data.length < 16) throw new Error('L01-Nachricht zu kurz');
  const d = crypto.createDecipheriv('aes-256-gcm', l01Key(timestamp, localKey), l01Iv(timestamp, random, seq));
  d.setAAD(l01Aad(timestamp, random, seq, connectNonce, ackNonce));
  d.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
}

/**
 * Baut eine verschlüsselte Nachricht.
 * @param {object} msg
 * @param {number} msg.protocol
 * @param {Buffer|null} msg.payload   Klartext (null = Nachricht ohne Nutzdaten, z. B. Hello/Ping)
 * @param {string} [msg.version]      '1.0' (Standard) oder 'L01'
 * @param {string} localKey
 * @param {object} [nonces]           { connectNonce, ackNonce } – nur für L01
 */
function encode({ protocol, payload, version = VERSION, seq = nextSeq(), random = nextRandom(), timestamp = Math.floor(Date.now() / 1000) }, localKey, nonces = {}) {
  const header = Buffer.alloc(17);
  header.write(version, 0, 'ascii');
  header.writeUInt32BE(seq >>> 0, 3);
  header.writeUInt32BE(random >>> 0, 7);
  header.writeUInt32BE(timestamp >>> 0, 11);
  header.writeUInt16BE(protocol, 15);
  if (payload == null) return Buffer.concat([header, u32(crc32(header))]);   // ohne Längenfeld (wie python-roborock)

  const enc = version === 'L01'
    ? encryptL01(payload, localKey, { timestamp, seq, random }, nonces)
    : (payload.length ? encryptEcb(payload, messageKey(timestamp, localKey)) : Buffer.alloc(0));
  const len = Buffer.alloc(2);
  len.writeUInt16BE(enc.length, 0);
  const body = Buffer.concat([header, len, enc]);
  if (!enc.length) return body;
  return Buffer.concat([body, u32(crc32(body))]);
}

/**
 * Zerlegt einen Puffer in Nachrichten (MQTT liefert i. d. R. genau eine) Nachrichten der Protokolle A01/B01 werden übersprungen.
 * @param {object} [nonces] { connectNonce, ackNonce } – nur für L01
 * @returns {Array<{version:string, seq:number, random:number, timestamp:number, protocol:number, payload:Buffer|null}>}
 */
function decode(buf, localKey, nonces = {}) {
  const out = [];
  let off = 0;
  while (off + 17 <= buf.length) {
    const version = buf.toString('ascii', off, off + 3);
    if (!['1.0', 'A01', 'B01', 'L01'].includes(version)) { off++; continue; }
    const head = {
      version,
      seq:       buf.readUInt32BE(off + 3),
      random:    buf.readUInt32BE(off + 7),
      timestamp: buf.readUInt32BE(off + 11),
      protocol:  buf.readUInt16BE(off + 15),
    };
    const known = version === VERSION || version === 'L01';

    // Nachricht ohne Nutzdaten (nur Kopf, z. B. Hello-/Ping-Antwort)
    if (off + 19 > buf.length) {
      if (known) out.push({ ...head, payload: null });
      break;
    }
    const len = buf.readUInt16BE(off + 17);
    const end = off + 19 + len;
    if (end > buf.length) throw new Error('Roborock-Nachricht unvollstaendig');

    let payload = null;
    if (len > 0) {
      if (end + 4 > buf.length) throw new Error('Roborock-Nachricht ohne Pruefsumme');
      if (buf.readUInt32BE(end) !== crc32(buf.subarray(off, end))) throw new Error('Roborock-Pruefsumme falsch');
      const data = buf.subarray(off + 19, end);
      if (version === VERSION) payload = decryptEcb(data, messageKey(head.timestamp, localKey));
      else if (version === 'L01') payload = decryptL01(data, localKey, head, nonces);
      off = end + 4;
    } else {
      off = end;
    }
    if (known) out.push({ ...head, payload });
  }
  return out;
}

/** Lokale TCP-Frames: 4 Byte Länge (Big Endian) + Nachricht. */
function frameLocal(message) {
  return Buffer.concat([u32(message.length), message]);
}

/**
 * Dekodiert einen lokalen Frame. Hello-/Ping-Antworten tragen keine Nutzdaten;
 * je nach Firmware folgen dem Kopf (17 Byte) noch Länge 0 und/oder Prüfsumme –
 * kurze Frames werden deshalb nur als Kopf gelesen.
 */
function decodeLocalFrame(frame, localKey, nonces = {}) {
  if (frame.length < 17) return [];
  if (frame.length <= 23) {
    const version = frame.toString('ascii', 0, 3);
    if (version !== VERSION && version !== 'L01') return [];
    return [{
      version,
      seq:       frame.readUInt32BE(3),
      random:    frame.readUInt32BE(7),
      timestamp: frame.readUInt32BE(11),
      protocol:  frame.readUInt16BE(15),
      payload:   null,
    }];
  }
  return decode(frame, localKey, nonces);
}

/** Entnimmt vollständige lokale Frames aus einem Empfangspuffer. */
function splitLocalFrames(buffer) {
  const frames = [];
  let off = 0;
  while (off + 4 <= buffer.length) {
    const len = buffer.readUInt32BE(off);
    if (off + 4 + len > buffer.length) break;
    frames.push(buffer.subarray(off + 4, off + 4 + len));
    off += 4 + len;
  }
  return { frames, rest: buffer.subarray(off) };
}

// ---------------------------------------------------------------------------
//  V1-RPC (JSON in Datenpunkt 101/102)
// ---------------------------------------------------------------------------

let requestCounter = crypto.randomInt(10000, 32767);
const nextRequestId = () => (requestCounter = requestCounter >= 32767 ? 10000 : requestCounter + 1);

/** Sicherheitsdaten, die die Cloud bei MQTT-RPCs erwartet. */
function createSecurity(rriotK) {
  return {
    endpoint: md5(Buffer.from(rriotK, 'utf8')).subarray(8, 14).toString('base64'),
    nonce:    crypto.randomBytes(16).toString('hex'),
  };
}

/**
 * RPC-Anfrage als Klartext-Payload.
 * @returns {{id:number, payload:Buffer, timestamp:number}}
 */
function buildRpcRequest(method, params, security) {
  const id        = nextRequestId();
  const timestamp = Math.floor(Date.now() / 1000);
  const inner     = { id, method, params: params ?? [], ...(security ? { security } : {}) };
  const payload   = Buffer.from(JSON.stringify({ dps: { 101: JSON.stringify(inner) }, t: timestamp }), 'utf8');
  return { id, payload, timestamp };
}

/** Datenpunkte (dps) einer entschlüsselten Nachricht, Schlüssel als Zahl. */
function parseDps(payload) {
  if (!payload?.length) return null;
  let json;
  try { json = JSON.parse(payload.toString('utf8')); } catch { return null; }
  if (!json || typeof json.dps !== 'object' || json.dps === null) return null;
  const dps = {};
  for (const [k, v] of Object.entries(json.dps)) {
    const code = Number(k);
    if (Number.isInteger(code)) dps[code] = v;
  }
  return dps;
}

/**
 * Antwort auf eine RPC-Anfrage.
 * @returns {{id:number, result:any, error:any}|null}
 */
function parseRpcResponse(dps) {
  const raw = dps?.[PROTOCOL.RPC_RESPONSE];
  if (raw === undefined) return null;
  let data;
  try { data = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
  let error = data.error ?? null;
  const result = data.result;
  if (typeof result === 'string' && result !== 'ok') error = error ?? { message: result };
  return { id: data.id, result, error };
}

/** MQTT-Zugangsdaten aus den rriot-Daten des Logins. */
function mqttParams(rriot) {
  const url = new URL(rriot.r.m.replace(/^ssl:/, 'mqtts:').replace(/^tcp:/, 'mqtt:'));
  const username = md5hex(`${rriot.u}:${rriot.k}`).slice(2, 10);
  return {
    url:       `${url.protocol}//${url.hostname}:${url.port}`,
    username,
    password:  md5hex(`${rriot.s}:${rriot.k}`).slice(16),
    pubTopic:  (duid) => `rr/m/i/${rriot.u}/${username}/${duid}`,
    subTopic:  (duid) => `rr/m/o/${rriot.u}/${username}/${duid}`,
  };
}

module.exports = {
  PROTOCOL, DPS,
  encode, decode, encodeTimestamp, crc32, frameLocal, splitLocalFrames, decodeLocalFrame,
  createSecurity, buildRpcRequest, parseDps, parseRpcResponse, mqttParams,
};
