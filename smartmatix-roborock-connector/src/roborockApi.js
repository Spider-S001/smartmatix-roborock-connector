'use strict';

/**
 * roborockApi.js – REST-API der Roborock-Cloud
 *
 * Portiert aus python-roborock (web_api.py), wie es die Home-Assistant-
 * Integration verwendet:
 *   1. getUrlByEmail      > Region-Server, Land und Landesvorwahl des Kontos
 *   2. sendCode           > Roborock schickt einen Code per E-Mail
 *   3. loginWithCode      > Zugangsdaten (token + rriot) für REST und MQTT
 *   4. getHomeData        > Geräte, Produkte (Modelle) und Räume des Zuhauses
 *
 * Fehler tragen ein "kind" für die Einstellungsseite:
 *   'auth' | 'invalidCode' | 'noAccount' | 'tooFrequent' | 'agreement' | 'network' | 'api'
 */

const crypto = require('crypto');
const log    = require('./logger');

const ENTRY_URL  = 'https://euiot.roborock.com';   // Region Europa (liefert die Konto-Region zurück)
const TIMEOUT_MS = 20_000;

// Rückfallwerte, falls die aktuelle Version der Nutzungsbedingungen nicht abrufbar ist
const DEFAULT_AGREEMENT = { majorVersion: 14, minorVersion: 0 };

class RoborockApiError extends Error {
  constructor(message, kind = 'api', code = null) {
    super(message);
    this.kind = kind;
    this.code = code;
  }
}

const md5hex = (s) => crypto.createHash('md5').update(s).digest('hex');

/** Header-Client-ID: md5(E-Mail + Geräte-ID) als Base64 – muss zwischen Code-Anforderung und Login gleich bleiben. */
function clientId(email, deviceIdentifier) {
  return crypto.createHash('md5').update(email).update(deviceIdentifier).digest('base64');
}

function newDeviceIdentifier() {
  return crypto.randomBytes(12).toString('base64url');
}

async function request(baseUrl, path, { method = 'GET', query, form, headers = {} } = {}) {
  const url = new URL(baseUrl.replace(/\/+$/, '') + path);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v));

  const init = { method, headers: { ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) };
  if (form) {
    init.body = new URLSearchParams(Object.entries(form).map(([k, v]) => [k, String(v ?? '')])).toString();
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }

  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new RoborockApiError(`Roborock-Cloud nicht erreichbar (${url.host}): ${err.cause?.code ?? err.message}`, 'network');
  }
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch {
    throw new RoborockApiError(`Unerwartete Antwort von ${url.host}${path} (HTTP ${res.status})`, res.status === 401 ? 'auth' : 'network');
  }
  log.debug(`Roborock ${method} ${path} > HTTP ${res.status}, code ${json.code ?? '-'}`);
  return json;
}

/** Hawk-Signatur für die IoT-Endpunkte (rriot.r.a) */
function hawk(rriot, path) {
  const ts    = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(6).toString('base64url');
  const pre   = [rriot.u, rriot.s, nonce, String(ts), md5hex(path), '', ''].join(':');
  const mac   = crypto.createHmac('sha256', rriot.h).update(pre).digest('base64');
  return `Hawk id="${rriot.u}",s="${rriot.s}",ts="${ts}",nonce="${nonce}",mac="${mac}"`;
}

function fail(json, context) {
  const code = json?.code;
  const msg  = `${context}: ${json?.msg ?? 'Fehler'} (code ${code})`;
  switch (code) {
    case 2008: case 3039: return new RoborockApiError(msg, 'noAccount', code);
    case 9002:            return new RoborockApiError(msg, 'tooFrequent', code);
    case 2018:            return new RoborockApiError(msg, 'invalidCode', code);
    case 3006: case 3009: return new RoborockApiError(msg, 'agreement', code);
    case 2010:            return new RoborockApiError(msg, 'auth', code);
    default:              return new RoborockApiError(msg, 'api', code);
  }
}

// ---------------------------------------------------------------------------
//  Anmeldung
// ---------------------------------------------------------------------------

/** Region-Server und Land des Kontos */
async function getLoginInfo(email) {
  const json = await request(ENTRY_URL, '/api/v1/getUrlByEmail', {
    method: 'POST',
    query:  { email, needtwostepauth: 'false' },
  });
  if (json.code !== 200) throw fail(json, 'Konto-Region');
  const d = json.data ?? {};
  return { baseUrl: d.url || ENTRY_URL, country: d.country ?? null, countryCode: d.countrycode ?? null };
}

/**
 * Fordert einen Anmeldecode per E-Mail an
 * @returns {Promise<{baseUrl, country, countryCode}>} Login-Info für loginWithCode
 */
async function sendCode(email, deviceIdentifier) {
  const info = await getLoginInfo(email);
  const headers = { header_clientid: clientId(email, deviceIdentifier), header_clientlang: 'en' };

  const json = (info.country && info.countryCode)
    ? await request(info.baseUrl, '/api/v4/email/code/send', {
        method: 'POST', headers, form: { email, type: 'login', platform: '' },
      })
    : await request(info.baseUrl, '/api/v1/sendEmailCode', {
        method: 'POST', headers, query: { username: email, type: 'auth' },
      });
  if (json.code !== 200) throw fail(json, 'Code anfordern');
  
  log.info(`Roborock: Anmeldecode an ${maskEmail(email)} gesendet (${info.baseUrl}).`);
  
  return info;
}

async function agreementVersion(baseUrl, country) {
  try {
    const json = await request(baseUrl, '/api/v3/app/agreement/latest', {
      query: { country }, headers: { header_clientlang: 'en' },
    });
    const { majorVersion, minorVersion } = json?.data ?? {};
    if (json?.code === 200 && Number.isInteger(majorVersion) && Number.isInteger(minorVersion)) {
      return { majorVersion, minorVersion };
    }
  } catch (err) {
    log.debug('Roborock: Version der Nutzungsbedingungen nicht abrufbar:', err.message);
  }
  return DEFAULT_AGREEMENT;
}

/**
 * Meldet sich mit dem E-Mail-Code an
 * @returns {Promise<object>} userData (token, rriot, ...) – enthält alle Zugangsdaten
 */
async function loginWithCode(email, code, deviceIdentifier, info) {
  const { baseUrl, country, countryCode } = info ?? await getLoginInfo(email);
  const cid = clientId(email, deviceIdentifier);
  let json;

  if (country && countryCode) {
    const ks   = crypto.randomBytes(12).toString('base64url').replace(/[^A-Za-z0-9]/g, 'x').slice(0, 16);
    const sign = await request(baseUrl, '/api/v3/key/sign', { method: 'POST', headers: { header_clientid: cid }, query: { s: ks } });
    if (sign.code !== 200 || !sign.data?.k) throw fail(sign, 'Anmeldung (Signatur)');

    json = await request(baseUrl, '/api/v4/auth/email/login/code', {
      method: 'POST',
      headers: {
        header_clientid:    cid,
        'x-mercy-ks':       ks,
        'x-mercy-k':        sign.data.k,
        header_clientlang:  'en',
        header_appversion:  '4.54.02',
        header_phonesystem: 'iOS',
        header_phonemodel:  'iPhone16,1',
      },
      form: { country, countryCode, email, code, ...(await agreementVersion(baseUrl, country)) },
    });
  } else {
    json = await request(baseUrl, '/api/v1/loginWithCode', {
      method: 'POST',
      headers: { header_clientid: cid },
      query: { username: email, verifycode: code, verifycodetype: 'AUTH_EMAIL_CODE' },
    });
  }

  if (json.code !== 200) throw fail(json, 'Anmeldung');
  const userData = json.data;
  if (!userData?.rriot?.r?.a || !userData?.rriot?.r?.m) throw new RoborockApiError('Anmeldung: unvollstaendige Zugangsdaten', 'api');
  log.info(`Roborock: Angemeldet als ${maskEmail(email)}.`);
  return { ...userData, baseUrl };
}

// ---------------------------------------------------------------------------
//  Zuhause, Geräte, Räume
// ---------------------------------------------------------------------------

async function getHomeId(userData) {
  const json = await request(userData.baseUrl, '/api/v1/getHomeDetail', {
    headers: { Authorization: userData.token },
  });
  if (json.code !== 200) throw fail(json, 'Zuhause abrufen');
  return json.data.rrHomeId;
}

async function iotGet(userData, path) {
  const json = await request(userData.rriot.r.a, path, { headers: { Authorization: hawk(userData.rriot, path) } });
  if (!json.success) {
    const e = new RoborockApiError(`${path}: ${json.msg ?? 'Fehler'}`, json.code === 401 || /auth|token|sign/i.test(json.msg ?? '') ? 'auth' : 'api', json.code);
    throw e;
  }
  return json.result;
}

/**
 * Geräte, Produkte und Räume des Zuhauses (v3, Rückfall auf v1)
 * @returns {Promise<{homeId:number, devices:object[], products:object[], rooms:{id:number,name:string}[]}>}
 */
async function getHomeData(userData) {
  const homeId = await getHomeId(userData);
  let home;
  try {
    home = await iotGet(userData, `/v3/user/homes/${homeId}`);
  } catch (err) {
    if (err.kind === 'auth') throw err;
    log.debug('Roborock: v3-Home-Daten nicht verfuegbar, verwende v1:', err.message);
    home = await iotGet(userData, `/user/homes/${homeId}`);
  }
  return {
    homeId,
    devices:  [...(home.devices ?? []), ...(home.receivedDevices ?? [])],
    products: home.products ?? [],
    rooms:    home.rooms ?? [],
  };
}

/** Aktuelle Raumliste des Zuhauses (neue Raumnamen nach Kartenänderungen) */
async function getRooms(userData, homeId) {
  const result = await iotGet(userData, `/user/homes/${homeId}/rooms`);
  return Array.isArray(result) ? result : [];
}

function maskEmail(email) {
  return String(email).replace(/^(.).*?(@.*)$/, '$1***$2');
}

module.exports = {
  RoborockApiError,
  newDeviceIdentifier,
  sendCode,
  loginWithCode,
  getHomeData,
  getRooms,
  maskEmail,
};
