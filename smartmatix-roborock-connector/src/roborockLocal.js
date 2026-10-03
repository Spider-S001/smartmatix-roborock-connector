'use strict';

/**
 * roborockLocal.js – lokale Verbindung zu einem Saugroboter (TCP 58867)
 *
 * Portiert aus python-roborock (devices/transport/local_channel.py), wie es
 * die Home-Assistant-Integration nutzt:
 *   1. TCP-Verbindung zu <IP>:58867
 *   2. Hello-Handshake – erst Protokoll "1.0", dann "L01" (neuere Firmware)
 *   3. Befehle als GENERAL_REQUEST (4), Antworten/Pushes mit Datenpunkt 102/121 ff.
 *   4. Ping alle 10 s; zwei verpasste Pings > Verbindung neu aufbauen
 *
 * Die Verbindung baut sich nach einem Abbruch selbst wieder auf (Backoff bis 5 min).
 *
 * Events:
 *   'connected'    (version)   – Handshake erfolgreich
 *   'disconnected' (reason)    – Verbindung verloren
 *   'push'         (dps)       – Zustandsmeldung des Saugers
 *   'unreachable'  (attempts)  – mehrere Verbindungsversuche in Folge gescheitert
 *                                (z. B. neue IP-Adresse)
 */

const net          = require('net');
const crypto       = require('crypto');
const EventEmitter = require('events');
const log          = require('./logger');
const proto        = require('./roborockProtocol');
const { RpcError } = require('./roborockMqtt');

const PORT             = 58867;
const CONNECT_TIMEOUT  = 5_000;
const HELLO_TIMEOUT    = 5_000;
const RPC_TIMEOUT      = 10_000;
const PING_INTERVAL    = 10_000;
const PING_TIMEOUT     = 5_000;
const MAX_MISSED_PINGS = 2;
const BACKOFF_MIN_MS   = 10_000;
const BACKOFF_MAX_MS   = 5 * 60_000;
const UNREACHABLE_AFTER = 3;

class LocalConnection extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.duid
   * @param {string} opts.name
   * @param {string} opts.ip
   * @param {string} opts.localKey
   * @param {string} [opts.version] – zuletzt erfolgreiches Protokoll ('1.0' | 'L01')
   */
  constructor({ duid, name, ip, localKey, version }) {
    super();
    this.duid     = duid;
    this.name     = name;
    this.ip       = ip;
    this.localKey = localKey;
    this.version  = version ?? null;

    this._socket    = null;
    this._buffer    = Buffer.alloc(0);
    this._nonces    = {};
    this._ready     = false;
    this._running   = false;
    this._waiters   = new Set();   // { match(msg) => bool, resolve, reject, timer }
    this._pingTimer = null;
    this._missed    = 0;
    this._retryTimer = null;
    this._backoff    = BACKOFF_MIN_MS;
    this._failures   = 0;
  }

  get connected() { return this._ready; }

  start() {
    if (this._running) return;
    this._running = true;
    this._connect();
  }

  stop() {
    this._running = false;
    clearTimeout(this._retryTimer);
    this._retryTimer = null;
    this._teardown('gestoppt', { silent: true });
  }

  /** Neue IP bzw. neuer Schlüssel > Verbindung neu aufbauen */
  update({ ip, localKey, name }) {
    if (name) this.name = name;
    if ((ip && ip !== this.ip) || (localKey && localKey !== this.localKey)) {
      this.ip       = ip ?? this.ip;
      this.localKey = localKey ?? this.localKey;
      this._failures = 0;
      this._backoff  = BACKOFF_MIN_MS;
      if (this._running) {
        this._teardown('neue Adresse', { silent: true });
        clearTimeout(this._retryTimer);
        this._connect();
      }
    }
  }

  // ---------------------------------------------------------------------------
  //  Verbindungsaufbau
  // ---------------------------------------------------------------------------

  _connect() {
    if (!this._running || this._socket) return;
    const socket = net.createConnection({ host: this.ip, port: PORT });
    this._socket = socket;
    this._buffer = Buffer.alloc(0);
    socket.setNoDelay(true);
    socket.setTimeout(CONNECT_TIMEOUT, () => socket.destroy(new Error('Zeitueberschreitung beim Verbinden')));

    socket.once('connect', async () => {
      socket.setTimeout(0);
      try {
        await this._hello();
        this._ready    = true;
        this._failures = 0;
        this._backoff  = BACKOFF_MIN_MS;
        this._missed   = 0;
        this._pingTimer = setInterval(() => this._ping(), PING_INTERVAL);
        log.info(`Lokal: ${this.name} verbunden (${this.ip}, Protokoll ${this.version}).`);
        this.emit('connected', this.version);
      } catch (err) {
        socket.destroy(err);
      }
    });
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', (err) => { socket._lastError = err; });
    socket.on('close', () => {
      if (this._socket !== socket) return;
      this._teardown(socket._lastError?.code ?? socket._lastError?.message ?? 'Verbindung geschlossen');
      this._scheduleRetry();
    });
  }

  /** Hello-Handshake: bevorzugtes Protokoll zuerst, dann das andere */
  async _hello() {
    const versions = this.version === 'L01' ? ['L01', '1.0'] : ['1.0', 'L01'];
    for (const version of versions) {
      const connectNonce = crypto.randomInt(10000, 32767);
      try {
        const rsp = await this._request(
          { protocol: proto.PROTOCOL.HELLO_REQUEST, payload: null, version, seq: 1, random: connectNonce },
          (m) => m.protocol === proto.PROTOCOL.HELLO_RESPONSE && m.seq === 1,
          HELLO_TIMEOUT,
        );
        this.version = version;
        this._nonces = { connectNonce, ackNonce: rsp.random };
        return;
      } catch (err) {
        log.debug(`Lokal: ${this.name} spricht kein Protokoll ${version} (${err.message}).`);
        if (!this._socket || this._socket.destroyed) throw err;
      }
    }
    throw new Error('Handshake fehlgeschlagen');
  }

  async _ping() {
    const seq = crypto.randomInt(100000, 999999);
    try {
      await this._request(
        { protocol: proto.PROTOCOL.PING_REQUEST, payload: null, version: this.version, seq },
        (m) => m.protocol === proto.PROTOCOL.PING_RESPONSE && m.seq === seq,
        PING_TIMEOUT,
      );
      this._missed = 0;
    } catch {
      this._missed++;
      log.debug(`Lokal: ${this.name} Ping verpasst (${this._missed}).`);
      if (this._missed >= MAX_MISSED_PINGS) this._socket?.destroy(new Error('keine Ping-Antwort'));
    }
  }

  _teardown(reason, { silent = false } = {}) {
    const wasReady = this._ready;
    this._ready = false;
    clearInterval(this._pingTimer);
    this._pingTimer = null;
    for (const w of this._waiters) { clearTimeout(w.timer); w.reject(new RpcError(`Lokale Verbindung getrennt (${reason})`, 'offline')); }
    this._waiters.clear();
    if (this._socket) {
      const s = this._socket;
      this._socket = null;
      s.removeAllListeners('close');
      s.destroy();
    }
    if (wasReady && !silent) {
      log.warn(`Lokal: Verbindung zu ${this.name} (${this.ip}) getrennt: ${reason}`);
      this.emit('disconnected', reason);
    }
  }

  _scheduleRetry() {
    if (!this._running) return;
    this._failures++;
    if (this._failures === UNREACHABLE_AFTER) {
      log.warn(`Lokal: ${this.name} unter ${this.ip}:${PORT} nicht erreichbar (${this._failures} Versuche).`);
      this.emit('unreachable', this._failures);
    }
    const delay = this._backoff;
    this._backoff = Math.min(this._backoff * 2, BACKOFF_MAX_MS);
    clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => { this._retryTimer = null; this._connect(); }, delay);
  }

  // ---------------------------------------------------------------------------
  //  Senden / Empfangen
  // ---------------------------------------------------------------------------

  _write(msg) {
    const frame = proto.frameLocal(proto.encode(msg, this.localKey, this._nonces));
    this._socket.write(frame);
  }

  /** Sendet eine Nachricht und wartet auf die passende Antwort */
  _request(msg, match, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!this._socket || this._socket.destroyed) return reject(new RpcError('Nicht lokal verbunden', 'offline'));
      const w = { match, resolve, reject };
      w.timer = setTimeout(() => { this._waiters.delete(w); reject(new RpcError('Zeitueberschreitung (lokal)', 'timeout')); }, timeoutMs);
      this._waiters.add(w);
      try {
        this._write(msg);
      } catch (err) {
        clearTimeout(w.timer);
        this._waiters.delete(w);
        reject(new RpcError(`Senden fehlgeschlagen: ${err.message}`, 'offline'));
      }
    });
  }

  /**
   * Befehl an den Sauger
   * @returns {Promise<any>} result der Antwort
   */
  async rpc(method, params = [], timeoutMs = RPC_TIMEOUT) {
    if (!this._ready) throw new RpcError('Nicht lokal verbunden', 'offline');
    const { id, payload, timestamp } = proto.buildRpcRequest(method, params, null);
    log.debug(`Lokal > ${this.name}: ${method} ${JSON.stringify(params)} (id ${id})`);
    const msg = await this._request(
      { protocol: proto.PROTOCOL.GENERAL_REQUEST, payload, version: this.version, timestamp },
      (m) => m.rpc?.id === id,
      timeoutMs,
    );
    if (msg.rpc.error) throw new RpcError(`Befehl abgelehnt: ${JSON.stringify(msg.rpc.error)}`, 'device');
    return msg.rpc.result;
  }

  _onData(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk]);
    const { frames, rest } = proto.splitLocalFrames(this._buffer);
    this._buffer = Buffer.from(rest);

    for (const frame of frames) {
      let messages;
      try {
        messages = proto.decodeLocalFrame(frame, this.localKey, this._nonces);
      } catch (err) {
        log.debug(`Lokal < ${this.name}: nicht lesbar: ${err.message}`);
        continue;
      }
      for (const m of messages) {
        const dps = proto.parseDps(m.payload);
        if (dps) m.rpc = proto.parseRpcResponse(dps);

        let handled = false;
        for (const w of this._waiters) {
          if (w.match(m)) {
            clearTimeout(w.timer);
            this._waiters.delete(w);
            w.resolve(m);
            handled = true;
            break;
          }
        }
        if (!handled && dps && !m.rpc) {
          log.debug(`Lokal < ${this.name}: Push ${JSON.stringify(dps)}`);
          this.emit('push', dps);
        }
      }
    }
  }
}

module.exports = { LocalConnection, LOCAL_PORT: PORT };
