'use strict';

/**
 * roborockMqtt.js – MQTT-Verbindung zur Roborock-Cloud
 *
 * Eine Verbindung für das gesamte Konto. Je Sauger wird das Antwort-Topic
 * abonniert; Befehle werden als RPC (Datenpunkt 101) gesendet und über die
 * Request-ID der Antwort (Datenpunkt 102) zugeordnet.
 *
 * Events:
 *   'connected'                     – Verbindung (wieder) aufgebaut
 *   'disconnected'                  – Verbindung verloren
 *   'push'       (duid, dps)        – unaufgeforderte Zustandsmeldung (z. B. 121 = state)
 *   'authError'  (error)            – Zugangsdaten abgelehnt, kein Reconnect mehr
 *   'health'     (ok, reason)       – Cloud nutzbar ja/nein (Verbindung + Antworten)
 *   'recoveryFailed' (attempt)      – Neuaufbau + Prüfanfrage ohne Antwort
 *
 * "Verbunden" heißt nicht "nutzbar": Die Roborock-Cloud hält Verbindungen
 * manchmal scheinbar offen, stellt aber keine Nachrichten mehr zu (bekannt aus
 * python-roborock). healthy ist deshalb false, sobald eine Anfrage unbeantwortet
 * bleibt, und wieder true, sobald über die Verbindung etwas ankommt.
 *
 * Wiederherstellung: Nach einer unbeantworteten Anfrage wird die Verbindung
 * neu aufgebaut und mit einer Anfrage geprüft – in wachsenden Abständen
 * (20 s, 2, 5, 15, 30, 60 min), bis wieder eine Antwort kommt. Im Normalbetrieb
 * gibt es keine Testanfragen.
 */

const EventEmitter = require('events');
const mqtt         = require('mqtt');
const log          = require('./logger');
const proto        = require('./roborockProtocol');

const RPC_TIMEOUT_MS = 15_000;
const KEEPALIVE_S    = 45;
const RECONNECT_MS   = 15_000;

// Wiederherstellung nach einer unbeantworteten Anfrage: Verbindung neu aufbauen
// und mit einer Anfrage prüfen – in wachsenden Abständen, der letzte wiederholt sich.
// (Objekt, damit Tests die Zeiten verkürzen können.)
const TIMING = {
  RECOVERY_DELAYS_MS: [20_000, 2 * 60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000],
  CONNECT_WAIT_MS:    30_000,
};


// CONNACK-Codes für abgelehnte Zugangsdaten (MQTT 3.1.1: 4/5, MQTT 5: 134/135)
const AUTH_REASON_CODES = new Set([4, 5, 134, 135]);

class RpcError extends Error {
  constructor(message, kind) { super(message); this.kind = kind; }
}

class RoborockCloud extends EventEmitter {
  constructor() {
    super();
    this._client   = null;
    this._params   = null;
    this._security = null;
    this._devices  = new Map();   // duid > { localKey, online }
    this._pending  = new Map();   // requestId > { resolve, reject, timer, duid }
    this._userData = null;
    this._timeouts = 0;
    this._wasConnected = false;
    this._suspect         = false;   // Anfrage blieb unbeantwortet, seitdem nichts empfangen
    this._recoveryTimer   = null;
    this._recoveryAttempt = 0;
    this._recovering      = false;
    this._restarting      = false;
    this._healthy     = false;
    this._ready       = false;   // Abos nach dem Verbinden bestätigt
    this._healthReason = 'nicht verbunden';
  }

  /**
   * MQTT-Verbindung steht und die Antwort-Topics sind abonniert (sonst gingen Antworten auf direkt gesendete Anfragen verloren). Sagt nichts über die Zustellung
   */
  get connected() { return Boolean(this._client?.connected && this._ready); }

  /** Eine Anfrage blieb unbeantwortet, die Wiederherstellung läuft */
  get suspect() { return this._suspect; }

  /** Cloud ist nutzbar: verbunden und Anfragen werden beantwortet. */
  get healthy() { return this._healthy; }
  get healthReason() { return this._healthReason; }

  _updateHealth() {
    let ok = this.connected;
    let reason = ok ? '' : 'MQTT-Verbindung getrennt';
    if (ok && this._suspect) {
      ok = false;
      reason = 'Anfrage blieb unbeantwortet';
    }
    this._healthReason = reason;
    if (ok === this._healthy) return;
    this._healthy = ok;
    if (ok) log.info('Roborock-Cloud: nutzbar.');
    else    log.warn(`Roborock-Cloud: nicht nutzbar – ${reason}.`);
    this.emit('health', ok, reason);
  }

  /** Baut die Verbindung mit den Zugangsdaten des Logins auf */
  connect(userData) {
    this.close();
    this._userData = userData;
    this._timeouts = 0;
    // Neue Anmeldung/Verbindung von außen: offenen Ausfall verwerfen
    // (nicht beim Neuaufbau durch die Wiederherstellung)
    if (!this._restarting) {
      this._suspect = false;
      this._cancelRecovery();
    }
    this._params   = proto.mqttParams(userData.rriot);
    this._security = proto.createSecurity(userData.rriot.k);

    log.info(`Roborock-MQTT: verbinde zu ${this._params.url} ...`);
    const client = mqtt.connect(this._params.url, {
      username:        this._params.username,
      password:        this._params.password,
      protocolVersion: 4,
      keepalive:       KEEPALIVE_S,
      reconnectPeriod: RECONNECT_MS,
      connectTimeout:  30_000,
      clean:           true,
    });
    this._client = client;

    client.on('connect', () => {
      this._wasConnected = true;
      this._ready = false;
      const ready = () => {
        if (this._client !== client) return;
        this._ready = true;
        log.info('Roborock-MQTT: verbunden.');
        this._updateHealth();
        this.emit('connected');
      };
      if (!this._devices.size) return ready();
      this._subscribe([...this._devices.keys()], ready);
    });
    client.on('reconnect', () => log.info('Roborock-MQTT: neuer Verbindungsversuch ...'));
    client.on('close', () => {
      if (this._client !== client) return;
      if (this._wasConnected) log.warn('Roborock-MQTT: Verbindung getrennt.');
      this._wasConnected = false;
      this._ready = false;
      this._rejectAll(new RpcError('MQTT-Verbindung getrennt', 'offline'));
      this._updateHealth();
      this.emit('disconnected');
    });
    client.on('error', (err) => {
      if (AUTH_REASON_CODES.has(err.code)) {
        log.warn(`Roborock-MQTT: Zugangsdaten abgelehnt (${err.code}).`);
        this.close();
        this.emit('authError', err);
        return;
      }
      log.warn('Roborock-MQTT-Fehler:', err.message);
    });
    client.on('message', (topic, payload) => this._onMessage(topic, payload));
  }

  close() {
    if (!this._restarting) this._cancelRecovery();
    this._wasConnected = false;
    this._ready = false;
    // Abbruch durch den Neuaufbau ist kein "Cloud nicht verbunden"
    this._rejectAll(this._restarting
      ? new RpcError('MQTT-Verbindung wird neu aufgebaut', 'restart')
      : new RpcError('MQTT-Verbindung geschlossen', 'offline'));
    if (this._client) {
      const c = this._client;
      this._client = null;
      c.removeAllListeners('close');
      c.end(true);
    }
    this._updateHealth();
  }

  /** Legt die zu bedienenden Sauger fest (duid > localKey) und passt die Abos an */
  setDevices(list) {
    const next = new Map(list.map(d => [d.duid, { localKey: d.localKey, online: d.online }]));
    const removed = [...this._devices.keys()].filter(duid => !next.has(duid));
    const added   = [...next.keys()].filter(duid => !this._devices.has(duid));
    this._devices = next;
    if (!this._client?.connected || !this._params) return;
    if (removed.length) this._client.unsubscribe(removed.map(this._params.subTopic));
    if (added.length)   this._subscribe(added);
  }

  _subscribe(duids, done = () => {}) {
    this._client.subscribe(duids.map(this._params.subTopic), { qos: 0 }, (err) => {
      if (err) log.warn('Roborock-MQTT: Abonnieren fehlgeschlagen:', err.message);
      else log.debug(`Roborock-MQTT: ${duids.length} Geraet(e) abonniert.`);
      done();
    });
  }

  /**
   * Sendet einen Befehl und wartet auf die Antwort
   * @returns {Promise<any>} result der Antwort
   */
  rpc(duid, method, params = [], timeoutMs = RPC_TIMEOUT_MS) {
    const localKey = this._devices.get(duid)?.localKey;
    if (!localKey)        return Promise.reject(new RpcError(`Unbekannter Sauger ${duid}`, 'unknown'));
    if (!this.connected)  return Promise.reject(new RpcError('Roborock-Cloud nicht verbunden', 'offline'));

    const { id, payload, timestamp } = proto.buildRpcRequest(method, params, this._security);
    const frame = proto.encode({ protocol: proto.PROTOCOL.RPC_REQUEST, payload, timestamp }, localKey);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        this._onTimeout(method, duid);
        reject(new RpcError(`Zeitueberschreitung bei ${method} (Cloud)`, 'timeout'));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer, duid });
      log.debug(`Roborock > ${duid}: ${method} ${JSON.stringify(params)} (id ${id})`);
      this._client.publish(this._params.pubTopic(duid), frame, { qos: 0 }, (err) => {
        if (!err) return;
        clearTimeout(timer);
        this._pending.delete(id);
        reject(new RpcError(`Senden fehlgeschlagen: ${err.message}`, 'offline'));
      });
    });
  }

  _onMessage(topic, payload) {
    const duid     = topic.split('/').pop();
    const localKey = this._devices.get(duid)?.localKey;
    if (!localKey) return;

    // Jede zugestellte Nachricht beweist, dass die Cloud wieder erreichbar ist
    this._timeouts = 0;
    if (this._suspect) {
      this._suspect = false;
      this._cancelRecovery();
    }
    this._updateHealth();

    let messages;
    try {
      messages = proto.decode(payload, localKey);
    } catch (err) {
      log.debug(`Roborock < ${duid}: nicht lesbar: ${err.message}`);
      return;
    }

    for (const m of messages) {
      const dps = proto.parseDps(m.payload);
      if (!dps) continue;

      const rsp = proto.parseRpcResponse(dps);
      if (rsp) {
        const p = this._pending.get(rsp.id);
        if (p) {
          clearTimeout(p.timer);
          this._pending.delete(rsp.id);
          this._timeouts = 0;
          log.debug(`Roborock < ${duid}: Antwort ${rsp.id}: ${JSON.stringify(rsp.error ?? rsp.result)}`);
          if (rsp.error) p.reject(new RpcError(`Befehl abgelehnt: ${JSON.stringify(rsp.error)}`, 'device'));
          else p.resolve(rsp.result);
        }
        continue;
      }
      log.debug(`Roborock < ${duid}: Push ${JSON.stringify(dps)}`);
      this.emit('push', duid, dps);
    }
  }

  /**
   * Unbeantwortete Anfrage: Cloud gilt als nicht nutzbar, bis wieder eine
   * Nachricht ankommt. Die Wiederherstellung läuft nur, solange ein solcher
   * Ausfall offen ist – es gibt keine Prüfung im Normalbetrieb.
   */
  _onTimeout(method, duid) {
    // Sauger laut Roborock offline: Zeitüberschreitung sagt nichts über die Cloud
    if (this._devices.get(duid)?.online === false) return;
    this._timeouts++;
    this._suspect = true;
    this._updateHealth();
    log.info(`Roborock-MQTT: keine Antwort auf ${method} (${this._timeouts}x in Folge).`);
    this._scheduleRecovery();
  }

  _scheduleRecovery() {
    if (this._recoveryTimer || this._recovering || !this._userData) return;
    const delays = TIMING.RECOVERY_DELAYS_MS;
    const delay  = delays[Math.min(this._recoveryAttempt, delays.length - 1)];
    this._recoveryTimer = setTimeout(() => {
      this._recoveryTimer = null;
      this._recover().catch(err => log.warn('Roborock-MQTT: Wiederherstellung fehlgeschlagen:', err.message));
    }, delay);
  }

  _cancelRecovery() {
    clearTimeout(this._recoveryTimer);
    this._recoveryTimer   = null;
    this._recoveryAttempt = 0;
  }

  /** Verbindung neu aufbauen und mit get_status prüfen, ob die Cloud wieder liefert. */
  async _recover() {
    if (!this._suspect || !this._userData) return;
    this._recovering = true;
    const attempt = ++this._recoveryAttempt;
    try {
      log.warn(`Roborock-MQTT: Verbindung liefert keine Antworten > wird neu aufgebaut (Versuch ${attempt}).`);
      this._restarting = true;
      try { this.connect(this._userData); } finally { this._restarting = false; }
      this.emit('disconnected');

      await new Promise((resolve) => {
        const timer = setTimeout(() => { this.off('connected', ok); resolve(); }, TIMING.CONNECT_WAIT_MS);
        const ok = () => { clearTimeout(timer); resolve(); };
        this.once('connected', ok);
      });

      // Prüfanfrage nur an Sauger, die laut Roborock online sind
      const target = [...this._devices].find(([, d]) => d.online !== false)?.[0];
      if (this.connected && target && this._suspect) {
        this._recovering = false;   // die Prüfanfrage darf wieder gezählt werden
        await this.rpc(target, 'get_status').catch(() => {});
      }
    } finally {
      this._recovering = false;
    }
    if (!this._suspect) return;   // Antwort erhalten > _onMessage hat alles zurückgesetzt
    log.warn(`Roborock-MQTT: Cloud antwortet weiterhin nicht (Versuch ${attempt}).`);
    this.emit('recoveryFailed', attempt);
    this._scheduleRecovery();
  }

  _rejectAll(err) {
    for (const [id, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this._pending.delete(id);
    }
  }
}

module.exports = { RoborockCloud, RpcError, TIMING };
