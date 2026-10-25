'use strict';

/**
 * plugin.js – Kernklasse des SmartMatix Roborock Connectors
 *
 * Verwaltet:
 *   • WebSocket-Verbindung zur HCU (inkl. Exponential-Backoff-Reconnect)
 *   • Protokoll gemäß Connect API
 *   • Anmeldung am Roborock-Konto per E-Mail-Code
 *   • Lokale Verbindung zu den Saugern (TCP 58867), Roborock-Cloud (MQTT) als Rückfall
 *   • Befehle, Status, Push-Meldungen
 *   • Auswahl der Saugroboter in den Plugin-Einstellungen (Haken je Gerät)
 *   • Optional ein Schalter je Raum der aktiven Karte (Haken je Gerät)
 *   • "Neue Geräte automatisch hinzufügen"
 *   • Reinkludieren in der HCU gelöschter Geräte beim Speichern und Start
 *
 * Schalter in der HCU (deviceType SWITCH, modelType roborock-vacuum-robot):
 *   "Reinigen (Gerätename)"          an  > Reinigung der ganzen Wohnung
 *                                    aus > Stopp und zurück zur Station
 *   "Reinige <Raum> (Gerätename)"    an  > Raumreinigung (gleichzeitig
 *                                          eingeschaltete Räume werden gebündelt)
 *                                    aus > Stopp und zurück zur Station
 *   Die Schalter gehen von selbst auf "aus", sobald die Reinigung beendet ist.
 *   Optional (Haken je Sauger) zeigt die App während einer Reinigung eine
 *   schließbare Nachricht, ob die ganze Wohnung oder einzelne Räume gereinigt werden.
 *
 * Ablauf Anmeldung (die Einstellungsseite kann nichts nachladen):
 *   1. E-Mail eintragen und speichern > Roborock schickt einen Code.
 *   2. Code eintragen und speichern   > Anmeldung, Geräte erscheinen als Tabs.
 */

const WebSocket      = require('ws');
const { v4: uuidv4 } = require('uuid');
const log            = require('./logger');
const devices        = require('./devices');
const configStore    = require('./configStore');
const devicesStore   = require('./devicesStore');
const api            = require('./roborockApi');
const vacuum         = require('./roborockVacuum');
const { RoborockCloud, RpcError } = require('./roborockMqtt');
const { LocalConnection }  = require('./roborockLocal');
const { t }                = require('./localization');
const { createNotifier }   = require('./notifications');
const backup               = require('./backup-plugin-data');

// ---------------------------------------------------------------------------
//  Konstanten
// ---------------------------------------------------------------------------
const REPO_URL    = 'https://github.com/Spider-S001/smartmatix-roborock-connector';

// Port des temporären Backup/Restore-Servers – muss zu EXPOSE im Dockerfile passen
const BACKUP_PORT = 8747;

const RECONNECT_BASE_MS = 5_000;
const RECONNECT_MAX_MS  = 60_000;
const RECONNECT_FACTOR  = 1.5;

// Die HCU erlaubt 25 Nachrichten pro Sekunde je Plugin – mit Abstand darunter bleiben
const SEND_LIMIT_PER_SEC = 15;

// Nach einem Befehl meldet der Sauger den neuen Zustand erst nach einigen
// Sekunden; so lange wird der Schalterzustand aus Abfragen ignoriert
const CONTROL_GRACE_MS   = 12_000;
// Zusätzliche Abfragen nach einem Befehl (ms)
const FOLLOWUP_POLLS_MS  = [15_000, 45_000];
// Nach "zur Station" prüfen, ob der Sauger wirklich losfährt
const DOCK_CHECK_MS      = 8_000;
// Raum-Schalter, die innerhalb dieser Zeit eingeschaltet werden, werden gebündelt
const ROOM_BATCH_MS      = 3_000;

// Geräteliste regelmäßig neu laden (neue Geräte, Namen, online-Status)
// Roborock begrenzt die Home-Daten auf ca. 40 Abrufe pro Tag
const DEVICE_LIST_REFRESH_MS = 60 * 60 * 1000;
const DEVICE_LIST_MAX_AGE_MS = 10 * 60 * 1000;
const ROOMS_MAX_AGE_MS       = 10 * 60 * 1000;

// Akku-Gerät (VEHICLE): lowBat bei höchstens diesem Ladestand
const LOW_BATTERY_PERCENT = 20;

// Verschleißteile nach jeder Reinigung und mindestens so oft abfragen
const MAINT_CHECK_MS = 24 * 60 * 60 * 1000;

// IP-Adresse eines Saugers höchstens so oft über die Cloud nachfragen
const LOCAL_IP_REFRESH_MS = 10 * 60 * 1000;

// Mindestabstand zwischen zwei angeforderten Anmeldecodes
const CODE_RESEND_MS = 60 * 1000;

const POLL_OPTIONS = { '60s': 60, '2min': 120, '5min': 300, '10min': 600 };

// Feste Message-IDs (self-replacing notifications)
const MSG_ID_AUTH        = 'roborock-auth';
const MSG_ID_API_ERROR   = 'roborock-api-error';
const MSG_ID_REMOVE_HINT = 'roborock-remove-hint';
const MSG_ID_CLOUD_LOST  = 'roborock-cloud-lost';
const MSG_ID_ERROR       = (duid) => `roborock-error-${devices.robotKey(duid)}`;
const MSG_ID_MAINT       = (duid) => `roborock-maint-${devices.robotKey(duid)}`;
const MSG_ID_CLEANING    = (duid) => `roborock-cleaning-${devices.robotKey(duid)}`;


class Plugin {
  /**
   * @param {object} opts
   * @param {string} opts.pluginId  – Eindeutige Plugin-ID
   * @param {string} opts.host      – Hostname/IP der HCU
   * @param {string} opts.authtoken – Auth-Token der HCU
   */
  constructor({ pluginId, host, authtoken }) {
    this.pluginId  = pluginId;
    this.host      = host;
    this.authtoken = authtoken;

    this._config = configStore.load();
    if (!this._config.deviceIdentifier) {
      this._config.deviceIdentifier = api.newDeviceIdentifier();
      configStore.save(this._config);
    }
    // Migration älterer Installationen: Konto, zu dem die gespeicherten Geräte gehören, nachtragen
    if (this._loggedIn() && !this._config.deviceAccount) {
      this._config.deviceAccount = accountIdOf(this._config.userData, this._config.email);
      configStore.save(this._config);
    }
    this._lang = 'de';

    this._ws             = null;
    this._reconnectDelay = RECONNECT_BASE_MS;
    this._reconnectTimer = null;
    this._stopping       = false;

    // Sende-Warteschlange zur HCU (Begrenzung auf SEND_LIMIT_PER_SEC)
    this._sendQueue = [];
    this._sentAt    = [];
    this._sendTimer = null;

    this._pollTimer   = null;
    this._polling     = false;
    this._listTimer   = null;

    // Reinklusion: nächster DISCOVER meldet ALLE angehakten Geräte erneut
    this._reincludePending = false;
    this._startupDone      = false;

    // Zustand der Roborock-Cloud (für die Einstellungsseite)
    this._api   = { ok: null, error: null, lastListAt: 0, refreshing: null, homeId: null, roomNames: new Map() };
    // Laufende Anmeldung per Code: { email, info, sentAt }
    this._login = null;

    // Laufzeitzustand je Sauger: duid > { status, cleaningRooms, unreach, graceUntil, batch, followups }
    this._runtime = new Map();

    this._cloud        = new RoborockCloud();
    this._cloudStarted = false;
    this._cloud.on('connected',    () => this._onCloudConnected());
    this._cloud.on('disconnected', () => this._onCloudLost());
    this._cloud.on('push',         (duid, dps) => this._onPush(duid, dps));
    this._cloud.on('authError',    () => this._handleAuthLost());
    this._cloud.on('health',       (ok) => this._onCloudHealth(ok));
    this._cloud.on('recoveryFailed', () => this._notifyCloudLost());
    // Cloud-Ausfall: { since, notified, everHealthy }
    this._cloudState = { since: null, notified: false, everHealthy: false };

    // Lokale Verbindungen: duid > LocalConnection
    this._local       = new Map();
    this._ipCheckedAt = new Map();
    // Befehlsweg für roborockVacuum: lokal zuerst, sonst Cloud
    this._bus = { rpc: (duid, method, params) => this._rpc(duid, method, params) };

    this._notify        = null;
    this._backupManager = backup.create({ port: BACKUP_PORT });
    try {
      const sgtin = require('fs').readFileSync('/SGTIN', 'utf8').trim();
      this._backupHost = `hcu1-${sgtin.slice(-4)}.local`;
    } catch {
      this._backupHost = 'localhost';
    }

    log.info(`Roborock-Konto: ${this._loggedIn() ? api.maskEmail(this._config.email) : 'nicht angemeldet'}, Auto-Add: ${this._config.autoAddNewDevices ? 'an' : 'aus'}`);
  }

  // ---------------------------------------------------------------------------
  //  Öffentliche API
  // ---------------------------------------------------------------------------

  start() {
    this._stopping = false;
    this._connect();
  }

  stop() {
    log.info('Plugin wird beendet...');
    this._stopping = true;
    this._clearReconnect();
    this._stopPolling();
    this._stopListRefresh();
    for (const c of this._local.values()) c.stop();
    this._cloud.close();
    if (this._ws) {
      this._ws.terminate();
      this._ws = null;
    }
    process.exit(0);
  }

  // ---------------------------------------------------------------------------
  //  WebSocket-Lifecycle (HCU)
  // ---------------------------------------------------------------------------

  _connect() {
    const url = `wss://${this.host}:9001`;
    log.info(`Verbinde zu ${url} ...`);

    this._ws = new WebSocket(url, {
      rejectUnauthorized: false,
      handshakeTimeout:   30_000,
      headers: {
        'authtoken': this.authtoken,
        'plugin-id': this.pluginId,
      },
    });

    this._ws.on('open',    ()             => this._onOpen());
    this._ws.on('message', (data)         => this._onMessage(data));
    this._ws.on('error',   (err)          => this._onError(err));
    this._ws.on('close',   (code, reason) => this._onClose(code, reason));
  }

  _onOpen() {
    log.info('WebSocket verbunden.');
    this._reconnectDelay = RECONNECT_BASE_MS;

    this._notify = createNotifier(this.pluginId, (msg) => this._send(msg), t);

    this._sendPluginState(uuidv4());
    this._syncLocal();

    if (this._loggedIn()) {
      this._refreshRobots()
        .catch(err => log.warn('Start: Geraeteliste konnte nicht geladen werden:', err.message))
        .finally(() => {
          this._startCloud();
          // Beim Plugin-Start: angehakte Geräte, die in der App gelöscht wurden, wieder hinzufügen
          if (!this._startupDone) {
            this._startupDone = true;
            this._syncHcuDevices({ reinclude: true });
            this._requestReinclude('Plugin-Start');
          }
          // Nur bereits verbundene Robos sofort abfragen – die übrigen folgen, sobald die lokale bzw. Cloud-Verbindung steht.
          const ready = this._loadRobots().filter(r => this._canTalk(r.duid)).map(r => r.duid);
          if (ready.length) this._pollAll({ force: true, onlyDuids: ready }).catch(err => log.warn('Start: Zustandsabruf fehlgeschlagen:', err.message));
          this._startPolling();
        });
      this._startListRefresh();
    } else if (this._local.size) {
      this._startPolling();   // Anmeldung abgelaufen, lokale Steuerung läuft weiter
    }
  }

  async _onMessage(raw) {
    let message;
    try {
      const decoded = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw.toString();
      message = JSON.parse(decoded);
    } catch {
      log.warn('Ungueltige JSON-Nachricht empfangen:', raw.toString());
      return;
    }

    log.debug('< HCU:', JSON.stringify(message));

    try {
      switch (message.type) {
        case 'PLUGIN_STATE_REQUEST':    this._sendPluginState(message.id); break;
        case 'DISCOVER_REQUEST':        this._sendDiscoverResponse(message.id); break;
        case 'INCLUSION_EVENT':         this._handleInclusionEvent(message); break;
        case 'EXCLUSION_EVENT':         this._handleExclusionEvent(message); break;
        case 'CONTROL_REQUEST':         await this._handleControlRequest(message); break;
        case 'STATUS_REQUEST':          this._handleStatusRequest(message); break;
        case 'CONFIG_TEMPLATE_REQUEST': this._handleConfigTemplateRequest(message); break;
        case 'CONFIG_UPDATE_REQUEST':   await this._handleConfigUpdateRequest(message); break;
        case 'ERROR_RESPONSE':
          log.warn('ERROR_RESPONSE der HCU:', JSON.stringify(message.body));
          break;
        default:
          log.debug(`Nicht behandelter Nachrichtentyp: "${message.type}"`);
      }
    } catch (e) {
      log.error(`${message.type} Handler-Fehler:`, e.message, e.stack);
    }
  }

  _onError(err) {
    log.error('WebSocket-Fehler:', err.code ?? '', err.message ?? err);
  }

  _onClose(code, reason) {
    log.warn(`WebSocket getrennt (Code: ${code}, Grund: ${reason ? reason.toString() : '-'})`);
    this._stopPolling();
    this._stopListRefresh();
    clearTimeout(this._sendTimer);
    this._sendTimer = null;
    this._sendQueue = [];
    if (!this._stopping) this._scheduleReconnect();
  }

  // ---------------------------------------------------------------------------
  //  Ausgehende Nachrichten
  // ---------------------------------------------------------------------------

  _wsOpen() { return Boolean(this._ws && this._ws.readyState === WebSocket.OPEN); }

  /**
   * Sendet eine Nachricht an die HCU. Die HCU verwirft Nachrichten oberhalb
   * von 25 pro Sekunde (TOO_MANY_REQUESTS) – deshalb gehen höchstens
   * SEND_LIMIT_PER_SEC pro Sekunde raus, der Rest wartet in einer Warteschlange.
   */
  _send(message) {
    if (!this._wsOpen()) {
      log.warn('_send() aufgerufen, aber WebSocket ist nicht offen.');
      return;
    }
    this._sendQueue.push(JSON.stringify(message));
    this._drainSendQueue();
  }

  _drainSendQueue() {
    if (this._sendTimer) return;
    const now = Date.now();
    this._sentAt = this._sentAt.filter(ts => now - ts < 1000);

    while (this._sendQueue.length && this._sentAt.length < SEND_LIMIT_PER_SEC) {
      if (!this._wsOpen()) { this._sendQueue = []; return; }
      const payload = this._sendQueue.shift();
      log.debug('> HCU:', payload);
      this._ws.send(payload);
      this._sentAt.push(Date.now());
    }
    if (this._sendQueue.length) {
      const wait = Math.max(20, 1000 - (Date.now() - this._sentAt[0]));
      this._sendTimer = setTimeout(() => { this._sendTimer = null; this._drainSendQueue(); }, wait);
    }
  }

  _reply(request, type, body) {
    this._send({ id: request?.id ?? uuidv4(), pluginId: this.pluginId, type, body });
  }

  /** PLUGIN_STATE_RESPONSE – READY, bzw. CONFIG_REQUIRED solange keine Anmeldung besteht. */
  _sendPluginState(messageId) {
    const status = this._loggedIn() ? 'READY' : 'CONFIG_REQUIRED';
    log.info(`Sende PLUGIN_STATE_RESPONSE { ${status} }`);
    this._send({
      id:       messageId,
      pluginId: this.pluginId,
      type:     'PLUGIN_STATE_RESPONSE',
      body:     { pluginReadinessStatus: status },
    });
  }

  _sendStatusEvent(deviceId, features) {
    if (!features?.length || !this._wsOpen()) return;
    this._send({
      id:       uuidv4(),
      pluginId: this.pluginId,
      type:     'STATUS_EVENT',
      body:     { deviceId, features },
    });
  }

  // ---------------------------------------------------------------------------
  //  Geräteaufnahme (DISCOVER / INCLUSION / EXCLUSION)
  // ---------------------------------------------------------------------------

  /** Meldet beim nächsten DISCOVER alle angehakten Geräte erneut und triggert ihn. */
  _requestReinclude(reason) {
    if (devices.getAll().length === 0) return;
    log.info(`Reinklusion angefordert (${reason}): alle angehakten Geraete werden erneut gemeldet.`);
    this._reincludePending = true;
    this._triggerRediscover();
  }

  /** Triggert einen DISCOVER_REQUEST der HCU (via PLUGIN_STATE_RESPONSE). */
  _triggerRediscover() {
    log.info('Triggere DISCOVER_REQUEST via PLUGIN_STATE_RESPONSE ...');
    this._sendPluginState(uuidv4());
  }

  /**
   * DISCOVER_RESPONSE: meldet alle HCU-Geräte, die noch nicht an die HCU
   * gemeldet wurden – nach Speichern/Start (Reinklusion) alle angehakten,
   * so kommen auch Geräte zurück, die gelöscht wurden, während das Plugin
   * (kein EXCLUSION_EVENT)
   */
  _sendDiscoverResponse(messageId = null) {
    const reinclude = this._reincludePending;
    this._reincludePending = false;

    const toReport = reinclude
      ? devices.getAll()
      : devices.getAll().filter(d => !d.alreadyIncluded && !d.excluded);

    this._send({
      id:       messageId ?? uuidv4(),
      pluginId: this.pluginId,
      type:     'DISCOVER_RESPONSE',
      body:     { success: true, devices: toReport.map(devices.toHcu) },
    });

    // Diagnose: Fahrzeug-Geräte genau so protokollieren, wie sie an die HCU gehen
    for (const d of toReport.filter(x => x.channel === devices.BATTERY_CHANNEL)) {
      log.info(`DISCOVER Fahrzeug: ${JSON.stringify(devices.toHcu(d))}`);
    }

    devices.setFlags(toReport.map(d => d.deviceId), { alreadyIncluded: true, excluded: false });
    log.info(`DISCOVER_RESPONSE gesendet mit ${toReport.length} Geraet(en)${reinclude ? ' (Reinklusion)' : ''}.`);
  }

  /** INCLUSION_EVENT > Zustände der eingebundenen Geräte senden. */
  _handleInclusionEvent(message) {
    const ids = message.body?.deviceIds ?? [];
    log.info(`INCLUSION_EVENT fuer ${ids.length} Geraet(e).`);
    devices.setFlags(ids, { alreadyIncluded: true, excluded: false });

    const included = ids.map(id => devices.getById(id)).filter(Boolean);
    this._reply(message, 'STATUS_RESPONSE', { success: true, devices: included.map(devices.toHcu) });

    const duids = [...new Set(included.map(d => d.duid))];
    this._pollAll({ force: true, onlyDuids: duids })
      .catch(err => log.debug('INCLUSION_EVENT: Refresh fehlgeschlagen:', err.message));
    this._pushConfigTemplate();
  }

  /** EXCLUSION_EVENT > Geräte wurden in der HCU gelöscht: nicht mehr bedienen. */
  _handleExclusionEvent(message) {
    const ids = message.body?.deviceIds ?? [];
    log.info(`EXCLUSION_EVENT fuer ${ids.length} Geraet(e): ${ids.join(', ')}`);
    devices.setFlags(ids, { alreadyIncluded: false, excluded: true });
    this._pushConfigTemplate();
  }

  // ---------------------------------------------------------------------------
  //  Steuerung
  // ---------------------------------------------------------------------------

  /** CONTROL_REQUEST > Sauger steuern > CONTROL_RESPONSE */
  async _handleControlRequest(message) {
    const { deviceId, features } = message.body ?? {};
    log.info(`CONTROL_REQUEST fuer ${deviceId}:`, JSON.stringify(features));

    const fail = (code, msg) => {
      log.warn(`CONTROL_REQUEST ${deviceId} fehlgeschlagen: ${msg}`);
      this._reply(message, 'CONTROL_RESPONSE', { deviceId, success: false, error: { code, message: msg } });
    };

    const device = devices.getById(deviceId);
    if (!device || device.excluded) return fail('UNKNOWN_DEVICE', 'Device is not managed by this plugin anymore.');
    if (device.channel === devices.BATTERY_CHANNEL) return fail('INVALID_REQUEST', 'Battery device cannot be controlled.');
    const sw = Array.isArray(features) ? features.find(f => f.type === 'switchState') : null;
    if (!sw) return fail('INVALID_REQUEST', 'No switchState in control request.');
    if (!this._loggedIn() && !this._local.get(device.duid)?.connected) return fail('CONFIG_REQUIRED', 'Not logged in to Roborock.');

    const robot = this._findRobot(device.duid);
    if (!robot) return fail('UNKNOWN_DEVICE', 'Roborock device not found.');

    const on  = sw.on === true || sw.on === 'true';
    const rt  = this._rt(robot.duid);
    const room = device.channel === 'main' ? null : this._roomOf(robot, device.channel);
    if (device.channel !== 'main' && !room) return fail('UNKNOWN_DEVICE', 'Room not found.');

    try {
      if (!on) {
        await vacuum.returnToDock(this._bus, robot.duid);
        rt.cleaningRooms.clear();
        this._setOptimistic(robot, { state: 6, inCleaning: 0 });
        this._verifyReturnToDock(robot.duid);
      } else if (!room) {
        await vacuum.start(this._bus, robot.duid);
        rt.cleaningRooms.clear();
        this._setOptimistic(robot, { state: 5, inCleaning: 1 });
      } else {
        if (room.active === false) return fail('INVALID_REQUEST', 'Room is not on the active map.');
        await this._queueRoomClean(robot, room);
      }
    } catch (err) {
      return fail(['offline', 'timeout', 'restart'].includes(err.kind) ? 'DEVICE_UNREACHABLE' : 'ROBOROCK_ERROR', err.message);
    }

    this._reply(message, 'CONTROL_RESPONSE', { deviceId, success: true });
    this._scheduleFollowupPolls(robot.duid);
  }

  /**
   * Bündelt Raum-Schalter, die kurz nacheinander eingeschaltet werden
   * (z. B. aus einer Automation), zu einer Raumreinigung
   */
  _queueRoomClean(robot, room) {
    const rt = this._rt(robot.duid);
    if (!rt.batch) {
      rt.batch = { rooms: new Map(), waiters: [] };
      setTimeout(() => this._flushRoomBatch(robot.duid), ROOM_BATCH_MS);
    }
    rt.batch.rooms.set(room.iotId, room);
    return new Promise((resolve, reject) => rt.batch.waiters.push({ resolve, reject }));
  }

  async _flushRoomBatch(duid) {
    const rt    = this._rt(duid);
    const batch = rt.batch;
    rt.batch = null;
    if (!batch) return;

    const robot = this._findRobot(duid);
    const rooms = [...batch.rooms.values()];
    try {
      if (!robot) throw new Error('Roborock device not found.');
      
      log.info(`Raumreinigung ${robot.name}: ${rooms.map(r => r.name).join(', ')}`);
      
      await vacuum.cleanSegments(this._bus, robot, rooms.map(r => r.segmentId));
      
      this._saveRobot(robot);   // gemerktes Befehlsformat
      rt.cleaningRooms = new Set(rooms.map(r => r.iotId));
      this._setOptimistic(robot, { state: 18, inCleaning: 3 });
      batch.waiters.forEach(w => w.resolve());
    } catch (err) {
      batch.waiters.forEach(w => w.reject(err));
    }
  }

  /** Setzt einen erwarteten Zustand, sendet ihn an die HCU und startet die Schonfrist */
  _setOptimistic(robot, status) {
    const rt = this._rt(robot.duid);
    
    rt.status = { battery: rt.status?.battery ?? null, errorCode: rt.status?.errorCode ?? 0, dockError: rt.status?.dockError ?? 0, ...status };
    rt.graceUntil = 0;
    this._publishRobot(robot.duid);
    rt.graceUntil = Date.now() + CONTROL_GRACE_MS;
  }

  /**
   * Prüft einige Sekunden nach "zur Station", ob der Sauger wirklich losfährt
   * Steht er noch (z. B. pausiert), wird app_charge einmal wiederholt
   */
  _verifyReturnToDock(duid) {
    const rt = this._rt(duid);
    
    clearTimeout(rt.dockCheck);
    
    rt.dockCheck = setTimeout(async () => {
      const robot = this._findRobot(duid);
      
      try {
        const status = await vacuum.getStatus(this._bus, duid);
        
        if (!status || vacuum.isHeadingHome(status)) return;
        log.warn(`${robot?.name ?? duid}: faehrt nach app_charge nicht zur Station (Zustand ${status.state}) > wiederhole.`);
        await vacuum.returnToDock(this._bus, duid);
        this._scheduleFollowupPolls(duid);
      } catch (err) {
        log.warn(`${robot?.name ?? duid}: Rueckkehr zur Station nicht pruefbar: ${err.message}`);
      }
    }, DOCK_CHECK_MS);
  }

  _scheduleFollowupPolls(duid) {
    const rt = this._rt(duid);
    
    rt.followups.forEach(clearTimeout);
    rt.followups = FOLLOWUP_POLLS_MS.map(ms => setTimeout(() => {
      this._pollAll({ onlyDuids: [duid] }).catch(err => log.debug('Nachabfrage fehlgeschlagen:', err.message));
    }, ms));
  }

  // ---------------------------------------------------------------------------
  //  Status
  // ---------------------------------------------------------------------------

  /** STATUS_REQUEST > gespeicherte Zustände liefern, live nachladen */
  _handleStatusRequest(message) {
    const requested = message.body?.deviceIds
      ?? (message.body?.deviceId ? [message.body.deviceId] : null);

    const list = (requested ? requested.map(id => devices.getById(id)) : devices.getActive())
      .filter(d => d && !d.excluded);

    log.info(`STATUS_REQUEST fuer ${requested ? requested.join(', ') : 'alle Geraete'} > ${list.length} Geraet(e).`);
    this._reply(message, 'STATUS_RESPONSE', { success: true, devices: list.map(devices.toHcu) });

    const duids = [...new Set(list.map(d => d.duid))];
    if (duids.length && this._loggedIn()) {
      this._pollAll({ onlyDuids: duids }).catch(err => log.debug('STATUS_REQUEST: Refresh fehlgeschlagen:', err.message));
    }
  }

  _rt(duid) {
    let rt = this._runtime.get(duid);
    
    if (!rt) {
      rt = { status: null, cleaningRooms: new Set(), unreach: false, graceUntil: 0, batch: null, followups: [], notice: null };
      this._runtime.set(duid, rt);
    }
    
    return rt;
  }

  /** Features eines HCU-Schalters aus dem aktuellen Zustand des Saugers */
  _featuresFor(dev, robot, rt) {
    // Live-Ergebnis (lokal/Cloud) hat Vorrang vor dem Online-Kennzeichen der Geräteliste
    const unreach = Boolean(rt.unreach || (rt.status == null && robot?.online === false) || robot?.available === false);
    let on;
    
    if (dev.channel === devices.BATTERY_CHANNEL) {
      const battery = Number(rt.status?.battery);
      if (!Number.isFinite(battery) || rt.status?.battery == null) return [{ type: 'maintenance', unreach }];
      // lowBat ab LOW_BATTERY_PERCENT (z. B. für HmIP-Automationen)
      return [
        { type: 'batteryState', batteryLevel: Math.min(1, Math.max(0, battery / 100)), batteryCapacity: devices.BATTERY_CAPACITY_WH },
        { type: 'maintenance', unreach, lowBat: battery <= LOW_BATTERY_PERCENT },
      ];
    }

    if (dev.channel === 'main') {
      on = vacuum.isCleaning(rt.status);
      // Fehler des Saugers nur am Hauptschalter als Sabotage melden
      const sabotage = Boolean(rt.status?.errorCode);
      return [{ type: 'switchState', on }, { type: 'maintenance', unreach, sabotage }];
    }
    
    const iotId = dev.channel.replace(/^room-/, '');
    on = vacuum.isSegmentCleaning(rt.status) && rt.cleaningRooms.has(iotId);
    
    return [{ type: 'switchState', on }, { type: 'maintenance', unreach }];
  }

  /** Sendet geänderte Zustände aller Schalter eines Saugers an die HCU */
  _publishRobot(duid, { force = false } = {}) {
    const robot = this._findRobot(duid);
    const rt    = this._rt(duid);
    if (!vacuum.isCleaning(rt.status)) rt.cleaningRooms.clear();
    const inGrace = Date.now() < rt.graceUntil;

    for (const dev of devices.getByDuid(duid)) {
      if (!dev.alreadyIncluded || dev.excluded) continue;
      let live = this._featuresFor(dev, robot, rt);
      if (inGrace) live = live.filter(f => f.type !== 'switchState');
      if (!force && !hasChanges(dev.features, live)) continue;
      devices.mergeFeatures(dev.deviceId, live);
      this._sendStatusEvent(dev.deviceId, live);

      // Fahrzeug: ersten Akkustand nach dem Start und lowBat-Wechsel protokollieren
      if (dev.channel === devices.BATTERY_CHANNEL) {
        const level = live.find(f => f.type === 'batteryState')?.batteryLevel;
        const low   = live.find(f => f.type === 'maintenance')?.lowBat;
        if (level !== undefined && (!rt.vehicleLogged || low !== rt.vehicleLow)) {
          log.info(`Fahrzeug ${robot?.name ?? duid}: Akkustand ${Math.round(level * 100)} %${low ? ' (Batterie schwach)' : ''} an die HCU gemeldet: ${JSON.stringify(live)}`);
          rt.vehicleLogged = true;
          rt.vehicleLow    = low;
        }
      }
    }
    
    if (!inGrace) this._updateCleaningNotice(robot, rt);
    this._updateErrorNotice(robot, rt);

    // Wartung: nach Ende einer Reinigung und sonst einmal täglich die Verschleißteile abfragen
    const cleaning = vacuum.isCleaning(rt.status);
    if (rt.status) {
      if (!inGrace) {
        const ended = rt.wasCleaning && !cleaning;
        rt.wasCleaning = cleaning;
        if (ended || Date.now() - (rt.maintCheckedAt ?? 0) > MAINT_CHECK_MS) {
          this._checkMaintenance(duid).catch(() => {});
        }
      }
      this._updateMaintenanceNotice(robot, rt);   // Stationsmeldung aus dem Status
    }
  }

  /** Verschleißteile abfragen (get_consumable) und den Wartungshinweis aktualisieren */
  async _checkMaintenance(duid) {
    const robot = this._findRobot(duid);
    const rt    = this._rt(duid);
    if (!robot || !robot.addToHcu || robot.notifyMaintenance === false || !this._canTalk(duid)) return;
    rt.maintCheckedAt = Date.now();
    try {
      rt.maintDue = await vacuum.getConsumablesDue(this._bus, duid);
    } catch (err) {
      rt.maintCheckedAt = Date.now() - MAINT_CHECK_MS + 10 * 60_000;   // in 10 min erneut versuchen
      log.debug(`${robot.name}: Verschleissteile nicht abrufbar: ${err.message}`);
      return;
    }
    this._updateMaintenanceNotice(this._findRobot(duid), rt);
  }

  /**
   * Wartungshinweis (Verschleißteile fällig, Meldung der Station) als schließbare
   * Nachricht. Sie bleibt stehen, bis die Wartung erledigt ist (Zähler in der
   * Roborock-App zurückgesetzt bzw. Station meldet keinen Fehler mehr) oder der
   * Nutzer sie schließt. Was bereits gemeldet wurde, wird in roborock.json
   * gemerkt, damit ein Plugin-Neustart die Nachricht nicht erneut auslöst.
   */
  _updateMaintenanceNotice(robot, rt) {
    if (!robot || !this._notify) return;
    const enabled = robot.addToHcu && robot.notifyMaintenance !== false;
    if (enabled && rt.maintDue === undefined) return;   // Verschleißteile noch nicht abgefragt

    const items = [];
    if (enabled) {
      for (const key of rt.maintDue ?? []) items.push({ id: key, textKey: `maint.${key}` });
      const dock = rt.status?.dockError ?? 0;
      if (dock) items.push({ id: `dock${dock}`, textKey: `dock.${dock}`, code: dock });
    }
    const key = items.map(i => i.id).sort().join(',');
    if (key === (robot.maintNotice ?? '')) return;

    const fresh = this._findRobot(robot.duid) ?? robot;
    fresh.maintNotice = key;
    robot.maintNotice = key;
    this._saveRobot(fresh);

    const msgId = MSG_ID_MAINT(robot.duid);
    if (!items.length) {
      log.info(`${robot.name}: Wartung erledigt.`);
      this._notify.dismiss(msgId);
      return;
    }
    const text = (lang) => items.map((i) => {
      const known = t(lang, i.textKey) !== i.textKey;
      return known ? t(lang, i.textKey) : tr(lang, 'dock.unknown', { code: String(i.code ?? '') });
    }).join(', ');
    log.info(`${robot.name}: Wartung faellig (${text('de')}).`);
    const vars = { device: robot.name };
    this._notify(
      { de: tr('de', 'notification.maint.title', vars), en: tr('en', 'notification.maint.title', vars) },
      { de: tr('de', 'notification.maint.message', { ...vars, items: text('de') }), en: tr('en', 'notification.maint.message', { ...vars, items: text('en') }) },
      'WARN',
      { id: msgId, behaviorType: 'DISMISSIBLE' },
    );
  }

  /**
   * Fehler des Saugers (error_code) als schließbare Nachricht in der App
   * Wechselt der Fehler, wird die Nachricht ersetzt; ist er behoben, entfernt
   */
  _updateErrorNotice(robot, rt) {
    if (!robot || !this._notify || !rt.status) return;
    
    const code = robot.addToHcu ? (rt.status.errorCode ?? 0) : 0;
    if (code === (rt.errorNotice ?? 0)) return;
    
    rt.errorNotice = code;
    const msgId = MSG_ID_ERROR(robot.duid);
    
    if (!code) {
      log.info(`${robot.name}: Fehler behoben.`);
      this._notify.dismiss(msgId);
      return;
    }
    
    const known = t('de', `error.${code}`) !== `error.${code}`;
    const vars  = { device: robot.name, code: String(code) };
    
    log.warn(`${robot.name}: Fehler ${code} (${known ? t('de', `error.${code}`) : 'unbekannt'}).`);
    
    this._notify(
      { de: tr('de', 'notification.error.title', vars), en: tr('en', 'notification.error.title', vars) },
      {
        de: tr('de', 'notification.error.message', { ...vars, error: known ? t('de', `error.${code}`) : tr('de', 'error.unknown', vars) }),
        en: tr('en', 'notification.error.message', { ...vars, error: known ? t('en', `error.${code}`) : tr('en', 'error.unknown', vars) }),
      },
      'ERROR',
      { id: msgId, behaviorType: 'DISMISSIBLE' },
    );
  }

  /**
   * Nachricht in der Homematic IP App, solange eine Reinigung läuft (Haken gesetzt)
   * Sie wird bei einem Wechsel der Reinigungsart ersetzt und nach Ende der Reinigung entfernt
   */
  _updateCleaningNotice(robot, rt) {
    if (!robot || !this._notify) return;
    const msgId = MSG_ID_CLEANING(robot.duid);

    let kind = null;
    let vars = { device: robot.name };
    
    if (robot.notifyCleaning && robot.addToHcu && vacuum.isCleaning(rt.status)) {
      if (vacuum.isSegmentCleaning(rt.status)) {
        const names = (robot.rooms ?? []).filter(r => rt.cleaningRooms.has(r.iotId)).map(r => r.name);
        kind = names.length ? 'rooms' : 'roomsunknown';
        vars.rooms = names.join(', ');
      } else {
        kind = vacuum.isZoneCleaning(rt.status) ? 'zone' : 'full';
      }
    }

    const key = kind ? `${kind}|${vars.rooms ?? ''}` : null;
    
    if (key === rt.notice) return;
    rt.notice = key;

    if (!kind) {
      this._notify.dismiss(msgId);
      return;
    }
    
    this._notify.localized('notification.cleaning.title', `notification.cleaning.${kind}`, vars, 'INFO',
      { id: msgId, behaviorType: 'DISMISSIBLE' });
  }

  /** Push-Meldung des Saugers (121 = Zustand, 122 = Akku) */
  _onPush(duid, dps) {
    if (dps[121] === undefined && dps[120] === undefined) return;
    
    const rt = this._rt(duid);
    rt.status  = { state: 0, inCleaning: 0, battery: null, errorCode: 0, dockError: 0, ...rt.status };
    if (dps[121] !== undefined) rt.status.state = Number(dps[121]);
    if (dps[120] !== undefined) rt.status.errorCode = Number(dps[120]);   // Fehlercode (0 = kein Fehler)
    this._setReachable(duid, true);
    if (dps[122] !== undefined) rt.status.battery = dps[122];
    this._publishRobot(duid);
    
    // in_cleaning kommt nicht per Push > vollständigen Status kurz danach abfragen
    setTimeout(() => this._pollAll({ onlyDuids: [duid] }).catch(() => {}), 3_000);
  }

  /** Cloud getrennt: Sauger ohne lokale Verbindung sind nicht mehr erreichbar */
  _onCloudLost() {
    for (const duid of new Set(devices.getActive().map(d => d.duid))) {
      if (this._local.get(duid)?.connected) continue;
      this._setReachable(duid, false, 'Roborock-Cloud getrennt, keine lokale Verbindung');
      this._publishRobot(duid);
    }
  }

  /** Erreichbarkeit setzen und Wechsel protokollieren */
  _setReachable(duid, ok, reason = '') {
    const rt   = this._rt(duid);
    const name = this._findRobot(duid)?.name ?? duid;
    
    if (ok) rt.lastOk = Date.now();
    if (ok && rt.unreach)  log.info(`${name} wieder erreichbar (${this._local.get(duid)?.connected ? 'lokal' : 'Cloud'}).`);
    if (!ok && !rt.unreach) log.warn(`${name} nicht erreichbar: ${reason}`);
    
    rt.unreach = !ok;
  }

  // ---------------------------------------------------------------------------
  //  Reihenfolge: lokal zuerst, Cloud als Rückfall
  // ---------------------------------------------------------------------------

  _canTalk(duid) {
    return Boolean(this._local.get(duid)?.connected || this._cloud.connected);
  }

  async _rpc(duid, method, params) {
    const local = this._local.get(duid);
    if (local?.connected) {
      try {
        return await local.rpc(method, params);
      } catch (err) {
        if (err.kind === 'device') throw err;
        log.info(`Lokal: ${method} an ${local.name} fehlgeschlagen (${err.message}) > versuche Cloud.`);
      }
    }
    try {
      if (!this._cloud.connected) throw new RpcError('Weder lokal noch ueber die Roborock-Cloud erreichbar', 'offline');
      return await this._cloud.rpc(duid, method, params);
    } catch (err) {
      if (this._loggedIn()) this._onCloudRequestFailed(duid, method, err);
      throw err;
    }
  }

  /** Lokale Verbindungen zu den eingebundenen Saugern starten/anpassen/beenden */
  _syncLocal() {
    const wanted = new Map();
    
    for (const r of this._loadRobots()) {
      if (!r.supported || r.available === false || !r.addToHcu || !r.localKey) continue;
      if (r.localIp) wanted.set(r.duid, r);
      else this._refreshLocalIp(r.duid).catch(() => {});   // IP noch unbekannt > über die Cloud erfragen
    }
    
    for (const [duid, conn] of this._local) {
      if (!wanted.has(duid)) { conn.stop(); this._local.delete(duid); }
    }
    
    for (const [duid, r] of wanted) {
      const conn = this._local.get(duid);
      if (conn) { conn.update({ ip: r.localIp, localKey: r.localKey, name: r.name }); continue; }
      const c = new LocalConnection({ duid, name: r.name, ip: r.localIp, localKey: r.localKey, version: r.localVersion });
      c.on('connected',    (version) => this._onLocalConnected(duid, version));
      c.on('disconnected', () => this._onLocalLost(duid));
      c.on('push',         (dps) => this._onPush(duid, dps));
      c.on('unreachable',  () => this._refreshLocalIp(duid));
      this._local.set(duid, c);
      c.start();
    }
  }

  _onLocalConnected(duid, version) {
    const robot = this._findRobot(duid);
    
    if (robot && robot.localVersion !== version) {
      robot.localVersion = version;
      this._saveRobot(robot);
    }
    
    this._pollAll({ force: true, onlyDuids: [duid] }).catch(() => {});
  }

  _onLocalLost(duid) {
    if (this._cloud.connected) {
      this._pollAll({ onlyDuids: [duid] }).catch(() => {});
    } else {
      this._setReachable(duid, false, 'lokale Verbindung getrennt, Roborock-Cloud nicht verbunden');
      this._publishRobot(duid);
    }
  }

  /** IP-Adresse eines Saugers über die Cloud abfragen (get_network_info) */
  async _refreshLocalIp(duid) {
    const robot = this._findRobot(duid);
    
    if (!robot || !this._cloud.connected) return;
    if (Date.now() - (this._ipCheckedAt.get(duid) ?? 0) < LOCAL_IP_REFRESH_MS) return;
    this._ipCheckedAt.set(duid, Date.now());
    
    try {
      const info = await this._cloud.rpc(duid, 'get_network_info');
      const ip   = (Array.isArray(info) ? info[0] : info)?.ip;
      
      if (!ip) return;
      
      if (ip !== robot.localIp) {
        log.info(`Lokal: IP-Adresse von ${robot.name}: ${ip}${robot.localIp ? ` (vorher ${robot.localIp})` : ''}.`);
        robot.localIp = ip;
        this._saveRobot(robot);
        this._syncLocal();
      }
    } catch (err) {
      log.warn(`Lokal: IP-Adresse von ${robot.name} nicht abrufbar: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  //  Polling
  // ---------------------------------------------------------------------------

  /** Sauger mit mindestens einem aktiven HCU-Schalter */
  _pollTargets() {
    const duids = new Set(devices.getActive().map(d => d.duid));
    return this._loadRobots().filter(r => duids.has(r.duid) && r.supported && r.available !== false);
  }

  _startPolling() {
    this._stopPolling();
    const interval = this._config.pollInterval;
    log.info(`Polling gestartet: alle ${interval}s (${this._pollTargets().length} Sauger).`);
    
    const tick = async () => {
      try { await this._pollAll(); }
      catch (err) { log.warn('Polling-Fehler:', err.message); }
      this._pollTimer = setTimeout(tick, this._config.pollInterval * 1000);
    };
    
    this._pollTimer = setTimeout(tick, interval * 1000);
  }

  _stopPolling() {
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
  }

  /**
   * Fragt den Zustand der Sauger ab und sendet STATUS_EVENTs
   * @param {object}   [opts]
   * @param {boolean}  [opts.force]     – STATUS_EVENT auch ohne Änderung senden
   * @param {string[]} [opts.onlyDuids] – nur diese Sauger abfragen
   */
  async _pollAll({ force = false, onlyDuids = null } = {}) {
    if (!this._wsOpen()) return;
    if (this._polling && !onlyDuids) return;
    if (!onlyDuids) this._polling = true;

    try {
      let targets = this._pollTargets();
      if (onlyDuids) targets = targets.filter(r => onlyDuids.includes(r.duid));

      await Promise.all(targets.map(async (robot) => {
        const rt = this._rt(robot.duid);
        const startedAt = Date.now();
        
        try {
          rt.status = await vacuum.getStatus(this._bus, robot.duid) ?? rt.status;
          this._setReachable(robot.duid, true);
        } catch (err) {
          if (err.kind === 'device') log.warn(`Poll: ${robot.name} lehnt get_status ab: ${err.message}`);
          // Veraltetes Ergebnis: inzwischen gab es eine Antwort bzw. eine lokale Verbindung
          else if ((rt.lastOk ?? 0) > startedAt) log.debug(`Poll: ${robot.name} veraltete Zeitueberschreitung ignoriert.`);
          else if (this._local.get(robot.duid)?.connected) this._pollAll({ onlyDuids: [robot.duid] }).catch(() => {});
          else this._setReachable(robot.duid, false, err.message);
        }
        
        this._publishRobot(robot.duid, { force });
      }));
    } finally {
      if (!onlyDuids) this._polling = false;
    }
  }

  // ---------------------------------------------------------------------------
  //  Roborock-Konto, Geräteliste und Räume
  // ---------------------------------------------------------------------------

  _loggedIn()        { return Boolean(this._config.userData?.rriot); }
  _loadRobots()      { return devicesStore.loadRobots(); }
  _findRobot(duid)   { return this._loadRobots().find(r => r.duid === duid) ?? null; }

  _saveRobot(robot) {
    const list = this._loadRobots();
    const i = list.findIndex(r => r.duid === robot.duid);
    if (i >= 0) list[i] = robot; else list.push(robot);
    devicesStore.saveRobots(list);
  }

  _roomOf(robot, channel) {
    const iotId = channel.replace(/^room-/, '');
    return (robot.rooms ?? []).find(r => r.iotId === iotId) ?? null;
  }

  /** MQTT-Verbindung aufbauen bzw. die abonnierten Sauger aktualisieren */
  _startCloud() {
    if (!this._loggedIn()) return;
    
    this._cloud.setDevices(this._loadRobots()
      .filter(r => r.supported && r.available !== false && r.localKey)
      .map(r => ({ duid: r.duid, localKey: r.localKey, online: r.online })));
    
    if (!this._cloudStarted) {
      this._cloudStarted = true;
      this._cloud.connect(this._config.userData);
    }
    
    this._syncLocal();
  }

  _stopCloud() {
    this._cloudStarted = false;
    this._cloud.close();
    
    if (this._cloudState.notified) this._notify?.dismiss(MSG_ID_CLOUD_LOST);
    
    this._cloudState = { since: null, notified: false, everHealthy: false };
  }

  /** Cloud wieder nutzbar (Antwort empfangen) > Hinweis entfernen; Ausfall merken */
  _onCloudHealth(ok) {
    const cs = this._cloudState;
    
    if (ok) {
      if (cs.notified) {
        log.info('Roborock-Cloud wieder erreichbar > Hinweis in der App entfernt.');
        this._notify?.dismiss(MSG_ID_CLOUD_LOST);
      }
      cs.since = null;
      cs.notified = false;
      cs.everHealthy = true;
    } else if (this._cloudStarted && !cs.since) {
      cs.since = Date.now();
    }
    
    this._pushConfigTemplate();
  }

  /**
   * Eine Anfrage konnte nicht über die Cloud gesendet bzw. beantwortet werden.
   *   - Cloud gar nicht verbunden > Hinweis sofort
   *   - keine Antwort             > roborockMqtt baut die Verbindung neu auf und
   *     prüft sie; erst wenn auch das scheitert, kommt der Hinweis ('recoveryFailed').
   *     So löst ein kurz nicht erreichbarer Sauger keinen Cloud-Hinweis aus.
   */
  _onCloudRequestFailed(duid, method, err) {
    if (err.kind !== 'offline' && err.kind !== 'timeout') return;
    if (this._findRobot(duid)?.online === false) return;   // Sauger offline, nicht die Cloud

    const cs = this._cloudState;
    if (!cs.since) cs.since = Date.now();
    log.warn(`Roborock-Cloud: ${method} konnte nicht gesendet werden (${err.message}).`);
    // Während der Wiederherstellung entscheidet deren Prüfanfrage über den Hinweis
    if (err.kind === 'offline' && !this._cloud.suspect) this._notifyCloudLost();
    this._pushConfigTemplate();
  }

  /** Schließbare Nachricht "Roborock-Cloud nicht erreichbar" (einmal je Ausfall) */
  _notifyCloudLost() {
    const cs = this._cloudState;
    if (cs.notified || !this._cloudStarted) return;
    if (!cs.since) cs.since = Date.now();
    cs.notified = true;
    const local = [...this._local.values()].some(c => c.connected);
    log.warn(`Roborock-Cloud seit ${formatTime(cs.since)} nicht erreichbar > Hinweis in der App.`);

    this._notify?.localized(
      'notification.cloudlost.title',
      local ? 'notification.cloudlost.message.local' : 'notification.cloudlost.message.nolocal',
      { since: formatTime(cs.since) },
      'WARN',
      { id: MSG_ID_CLOUD_LOST, behaviorType: 'DISMISSIBLE' },
    );
    this._pushConfigTemplate();
  }

  _onCloudConnected() {
    // IP-Adressen für die lokale Verbindung ermitteln
    for (const r of this._loadRobots()) {
      if (r.supported && r.available !== false && r.addToHcu && !this._local.get(r.duid)?.connected) {
        this._refreshLocalIp(r.duid).catch(() => {});
      }
    }
    
    this._refreshAllRooms()
      .then((changed) => { if (changed) this._afterDeviceChange(); })
      .catch(err => log.debug('Raeume konnten nicht geladen werden:', err.message))
      .finally(() => this._pollAll({ force: true }).catch(() => {}));
  }

  /**
   * Lädt Geräte und Räume des Roborock-Kontos und gleicht sie mit
   * roborock.json ab. Neue Sauger erhalten addToHcu = autoAddNewDevices.
   * Gleichzeitige Aufrufe teilen sich einen laufenden Request
   * @returns {Promise<{newCount:number, autoAdded:number}>}
   */
  _refreshRobots() {
    if (this._api.refreshing) return this._api.refreshing;

    this._api.refreshing = (async () => {
      if (!this._loggedIn()) return { newCount: 0, autoAdded: 0 };

      let home;
      try {
        home = await api.getHomeData(this._config.userData);
      } catch (err) {
        this._handleApiError(err);
        throw err;
      }

      this._api.ok         = true;
      this._api.error      = null;
      this._api.lastListAt = Date.now();
      this._api.homeId     = home.homeId;
      for (const r of home.rooms) this._api.roomNames.set(String(r.id), r.name);
      this._notify?.dismiss(MSG_ID_API_ERROR);

      const products = new Map(home.products.map(p => [p.id, p]));
      const stored   = this._loadRobots();
      const byDuid   = new Map(stored.map(r => [r.duid, r]));
      const seen     = new Set();
      let newCount   = 0;
      let autoAdded  = 0;

      for (const d of home.devices) {
        const product = products.get(d.productId);
        if (!d?.duid || !vacuum.isVacuum(product)) continue;   // nur Saugroboter
        seen.add(d.duid);
        
        const fields = {
          name:        d.name || product?.name || d.duid,
          model:       product?.model ?? '',
          productName: product?.name ?? '',
          pv:          d.pv ?? '1.0',
          fv:          d.fv ?? '',          // Firmware-Version des Saugers
          localKey:    d.localKey,
          online:      d.online !== false,
          supported:   vacuum.isSupported(d, product),
          available:   true,
        };
        
        const rec = byDuid.get(d.duid);
        if (rec) {
          Object.assign(rec, fields);
        } else {
          const add = Boolean(this._config.autoAddNewDevices && fields.supported);
          stored.push({
            duid: d.duid, ...fields,
            addToHcu: add, roomSwitches: false, rooms: [], roomsAt: 0,
            firstSeen: new Date().toISOString(),
          });
          newCount++;
          if (add) autoAdded++;
          log.info(`Roborock: Neuer Sauger "${fields.name}" (${fields.model}, Protokoll ${fields.pv}) gefunden${add ? ' > wird automatisch hinzugefuegt' : ''}.`);
        }
      }
      
      for (const rec of stored) {
        if (!seen.has(rec.duid) && rec.available !== false) {
          rec.available = false;
          log.warn(`Roborock: Sauger "${rec.name}" ist nicht mehr im Konto vorhanden.`);
        }
      }

      devicesStore.saveRobots(stored);
      log.info(`Roborock: ${seen.size} Sauger im Konto, ${newCount} neu, ${autoAdded} automatisch hinzugefuegt.`);
      if (this._cloudStarted) this._startCloud();   // Abos aktualisieren
      return { newCount, autoAdded };
    })().finally(() => { this._api.refreshing = null; });

    return this._api.refreshing;
  }

  /**
   * Liest die Räume der aktiven Karte eines Saugers (get_room_mapping) und
   * ordnet ihnen die Raumnamen des Kontos zu. Räume, die nicht (mehr) auf der
   * aktiven Karte sind, bleiben erhalten und werden als inaktiv markiert –
   * so gehen HCU-Schalter bei einem Kartenwechsel nicht verloren.
   *
   * @param {object}  robot
   * @param {object}  [opts]
   * @param {boolean} [opts.rebuild] – nur die Räume der aktiven Karte behalten
   * @returns {Promise<boolean>} true, wenn sich die Raumliste geändert hat
   */
  async _refreshRooms(robot, { rebuild = false } = {}) {
    if (!robot.supported || robot.available === false || !this._canTalk(robot.duid)) return false;

    const mapping = await vacuum.getRoomMapping(this._bus, robot.duid);
    const unknown = mapping.some(m => !this._api.roomNames.has(m.iotId));
    
    if (unknown && this._api.homeId) {
      try {
        for (const r of await api.getRooms(this._config.userData, this._api.homeId)) {
          this._api.roomNames.set(String(r.id), r.name);
        }
      } catch (err) {
        log.debug('Raumnamen konnten nicht geladen werden:', err.message);
      }
    }

    const before = JSON.stringify(robot.rooms ?? []);
    const rooms  = rebuild ? [] : (robot.rooms ?? []).map(r => ({ ...r, active: false }));
    
    for (const m of mapping) {
      const name = this._api.roomNames.get(m.iotId) ?? `${t(this._lang, 'room.fallback')} ${m.segmentId}`;
      const existing = rooms.find(r => r.iotId === m.iotId);
      if (existing) Object.assign(existing, { segmentId: m.segmentId, name, active: true });
      else rooms.push({ iotId: m.iotId, segmentId: m.segmentId, name, active: true });
    }
    
    rooms.sort((a, b) => String(a.name).localeCompare(String(b.name), this._lang));

    const fresh = this._findRobot(robot.duid) ?? robot;
    fresh.rooms   = rooms;
    fresh.roomsAt = Date.now();
    Object.assign(robot, { rooms, roomsAt: fresh.roomsAt });
    this._saveRobot(fresh);

    const changed = JSON.stringify(rooms) !== before;
    if (changed) log.info(`Raeume ${robot.name}: ${rooms.filter(r => r.active).map(r => `${r.name} (${r.segmentId})`).join(', ') || 'keine'}`);
    
    return changed;
  }

  /** Räume aller Sauger aktualisieren (nur veraltete, außer force) */
  async _refreshAllRooms({ force = false } = {}) {
    let changed = false;
    
    for (const robot of this._loadRobots()) {
      if (!robot.supported || robot.available === false) continue;
      if (!force && Date.now() - (robot.roomsAt ?? 0) < ROOMS_MAX_AGE_MS) continue;
      try {
        if (await this._refreshRooms(robot)) changed = true;
      } catch (err) {
        log.debug(`Raeume ${robot.name}: ${err.message}`);
      }
    }
    
    return changed;
  }

  /** Nach neuen Geräten/Räumen: HCU-Geräte abgleichen und neue melden */
  _afterDeviceChange() {
    const { added } = this._syncHcuDevices();
    if (added > 0) this._triggerRediscover();
    this._pushConfigTemplate();
  }

  _handleApiError(err) {
    if (err.kind === 'auth') return this._handleAuthLost();
    this._api.ok    = false;
    this._api.error = 'network';
    log.warn(`Roborock-API-Fehler: ${err.message}`);
    this._notify?.localized('notification.api.unavailable.title', 'notification.api.unavailable.message',
      { error: err.message }, 'ERROR', { id: MSG_ID_API_ERROR });
  }

  /** Zugangsdaten abgelehnt: abmelden, der Nutzer muss einen neuen Code anfordern */
  _handleAuthLost() {
    if (!this._loggedIn()) return;
    log.warn('Roborock: Anmeldung abgelaufen oder widerrufen.');
    this._config.userData = null;
    configStore.save(this._config);
    this._api = { ...this._api, ok: false, error: 'auth' };
    this._stopCloud();
    this._onCloudLost();
    this._notify?.localized('notification.auth.title', 'notification.auth.message', {}, 'ERROR', { id: MSG_ID_AUTH });
    this._sendPluginState(uuidv4());
    this._pushConfigTemplate();
  }

  /** Hintergrund-Refresh der Geräteliste und Räume */
  _startListRefresh() {
    this._stopListRefresh();
    
    this._listTimer = setInterval(async () => {
      try {
        const { autoAdded } = await this._refreshRobots();
        const roomsChanged  = await this._refreshAllRooms();
        if (autoAdded > 0 || roomsChanged) this._afterDeviceChange();
      } catch { /* bereits geloggt */ }
    }, DEVICE_LIST_REFRESH_MS);
  }

  _stopListRefresh() {
    if (this._listTimer) {
      clearInterval(this._listTimer);
      this._listTimer = null;
    }
  }

  /**
   * Gleicht die HCU-Schalter mit den Haken in roborock.json ab.
   *   Haken gesetzt  > Schalter "Reinigen" (+ je Raum, falls gewünscht) anlegen;
   *                    in der HCU gelöschte werden erneut gemeldet (reinclude)
   *   Haken entfernt > Schalter entfernen; waren sie bereits in der HCU,
   *                    erscheint ein Hinweis in der App
   *
   * @param {object} [opts]
   * @param {boolean} [opts.reinclude] – in der HCU gelöschte Geräte wieder melden
   * @returns {{added:number, removedNames:string[]}}
   */
  _syncHcuDevices({ reinclude = false } = {}) {
    let added = 0;
    const removedNames = [];

    const dropDevice = (d) => {
      if (d.alreadyIncluded && !d.excluded) removedNames.push(d.friendlyName);
      devices.remove(d.deviceId);
    };

    for (const robot of this._loadRobots()) {
      const existing = devices.getByDuid(robot.duid);

      if (robot.addToHcu && robot.supported && robot.available !== false) {
        const wanted = [{ channel: 'main', name: tr(this._lang, 'channel.main', { device: robot.name }) }];
        if (robot.batteryDevice) {
          wanted.push({ channel: devices.BATTERY_CHANNEL, name: tr(this._lang, 'channel.battery', { device: robot.name, product: productLabel(robot) }) });
        }
        if (robot.roomSwitches) {
          for (const room of robot.rooms ?? []) {
            wanted.push({
              channel: devices.roomChannel(room.iotId),
              name:    tr(this._lang, 'channel.room', { room: room.name, device: robot.name }),
            });
          }
        }
        const wantedIds = new Set(wanted.map(w => devices.makeDeviceId(robot.duid, w.channel)));

        for (const w of wanted) {
          const id     = devices.makeDeviceId(robot.duid, w.channel);
          const before = devices.getById(id);
          const dev    = devices.ensure(robot.duid, w.channel, w.name);
          if (!before) added++;
          // Firmware des Saugers an allen seinen HCU-Geräten anzeigen
          if (robot.fv && dev.firmwareVersion !== robot.fv) devices.setFlags([id], { firmwareVersion: robot.fv });
          if (reinclude && dev.excluded) {
            devices.setFlags([id], { excluded: false, alreadyIncluded: false });
            added++;
            log.info(`Reinklusion: ${id} wird erneut an die HCU gemeldet.`);
          }
        }
        for (const d of existing) if (!wantedIds.has(d.deviceId)) dropDevice(d);
      } else if (!robot.addToHcu || !robot.supported) {
        existing.forEach(dropDevice);
        const rt = this._runtime.get(robot.duid);
        if (rt?.errorNotice) { this._notify?.dismiss(MSG_ID_ERROR(robot.duid)); rt.errorNotice = 0; }
        if (robot.maintNotice) this._updateMaintenanceNotice(robot, this._rt(robot.duid));
      }
    }

    if (removedNames.length) {
      this._notify?.localized(
        'notification.remove.title',
        'notification.remove.message',
        { names: removedNames.join(', ') },
        'WARN',
        { id: MSG_ID_REMOVE_HINT },
      );
    }
    this._syncLocal();
    
    return { added, removedNames };
  }

  // ---------------------------------------------------------------------------
  //  Einstellungsseite (CONFIG_TEMPLATE / CONFIG_UPDATE)
  // ---------------------------------------------------------------------------

  _handleConfigTemplateRequest(message) {
    this._lang = message.body?.languageCode ?? message.body?.language ?? this._lang;
    log.info(`CONFIG_TEMPLATE_REQUEST (${this._lang}) > sende Konfigurationsvorlage.`);
    this._reply(message, 'CONFIG_TEMPLATE_RESPONSE', this._buildTemplate());

    // Geräteliste und Räume im Hintergrund aktualisieren und Seite ggf. neu senden
    if (!this._loggedIn()) return;
    const listStale = Date.now() - this._api.lastListAt > DEVICE_LIST_MAX_AGE_MS;
    (async () => {
      const { newCount, autoAdded } = listStale ? await this._refreshRobots() : { newCount: 0, autoAdded: 0 };
      const roomsChanged = await this._refreshAllRooms();
      if (autoAdded > 0 || roomsChanged) this._afterDeviceChange();
      else if (newCount > 0) this._pushConfigTemplate();
    })().catch(() => this._pushConfigTemplate());
  }

  async _handleConfigUpdateRequest(message) {
    const props = message.body?.properties ?? {};
    this._lang  = message.body?.languageCode ?? this._lang;
    log.info('CONFIG_UPDATE_REQUEST empfangen.');

    // --- Backup / Restore (Dropdown > backupMode/restoreMode) ---
    const actionValue  = props.backup_restore_action;
    const backupFields = {};
    if (actionValue !== undefined && actionValue !== null) {
      for (const lang of ['de', 'en']) {
        if (actionValue === t(lang, 'settings.backup_restore.action.backup'))  backupFields.backupMode  = true;
        if (actionValue === t(lang, 'settings.backup_restore.action.restore')) backupFields.restoreMode = true;
      }
    }
    if (this._backupManager.handleConfigUpdate(backupFields)) {
      this._pushConfigTemplate();
      this._reply(message, 'CONFIG_UPDATE_RESPONSE', { status: 'APPLIED' });
      return;
    }

    // --- Allgemeine Einstellungen ---
    if (props.autoAddNewDevices !== undefined) {
      this._config.autoAddNewDevices = toBool(props.autoAddNewDevices);
    }
    if (props.pollInterval !== undefined) {
      this._config.pollInterval = this._pollIntervalFromDisplay(String(props.pollInterval));
    }

    // --- Anmeldung ---
    let feedback = null;
    let status   = 'APPLIED';
    const wasLoggedIn = this._loggedIn();

    if (props.email !== undefined) {
      const email = String(props.email).trim();
      if (email !== this._config.email) {
        if (wasLoggedIn) log.info('Roborock: E-Mail geaendert > Abmeldung.');
        this._config.email    = email;
        this._config.userData = null;
        this._login = null;
        this._stopCloud();
      }
    }
    configStore.save(this._config);

    const code = typeof props.code === 'string' ? props.code.replace(/\s+/g, '') : '';
    if (!this._loggedIn() && this._config.email) {
      ({ status, feedback } = await this._loginStep(code));
    }
    const justLoggedIn = !wasLoggedIn && this._loggedIn();

    // --- Haken je Sauger übernehmen ---
    const stored = this._loadRobots();
    const roomsTurnedOn = [];
    const notifyChanged = [];
    const maintChanged  = [];
    let changed = false;
    for (const r of stored) {
      const gid = this._groupId(r);
      if (props[`${gid}_add`] !== undefined && r.addToHcu !== toBool(props[`${gid}_add`])) {
        r.addToHcu = toBool(props[`${gid}_add`]);
        changed = true;
        log.info(`Roborock: "${r.name}" ${r.addToHcu ? 'wird hinzugefuegt' : 'wird nicht mehr bedient'}.`);
      }
      if (props[`${gid}_notify`] !== undefined && Boolean(r.notifyCleaning) !== toBool(props[`${gid}_notify`])) {
        r.notifyCleaning = toBool(props[`${gid}_notify`]);
        notifyChanged.push(r.duid);
        changed = true;
        log.info(`Roborock: Reinigungshinweis fuer "${r.name}" ${r.notifyCleaning ? 'an' : 'aus'}.`);
      }
      if (props[`${gid}_maint`] !== undefined && (r.notifyMaintenance !== false) !== toBool(props[`${gid}_maint`])) {
        r.notifyMaintenance = toBool(props[`${gid}_maint`]);
        maintChanged.push(r.duid);
        changed = true;
        log.info(`Roborock: Wartungshinweise fuer "${r.name}" ${r.notifyMaintenance ? 'an' : 'aus'}.`);
      }
      if (props[`${gid}_battery`] !== undefined && Boolean(r.batteryDevice) !== toBool(props[`${gid}_battery`])) {
        r.batteryDevice = toBool(props[`${gid}_battery`]);
        changed = true;
        log.info(`Roborock: Akku-Geraet fuer "${r.name}" ${r.batteryDevice ? 'an' : 'aus'}.`);
      }
      if (props[`${gid}_rooms`] !== undefined && r.roomSwitches !== toBool(props[`${gid}_rooms`])) {
        r.roomSwitches = toBool(props[`${gid}_rooms`]);
        if (r.roomSwitches) roomsTurnedOn.push(r.duid);
        changed = true;
        log.info(`Roborock: Raum-Schalter fuer "${r.name}" ${r.roomSwitches ? 'an' : 'aus'}.`);
      }
    }
    if (changed) devicesStore.saveRobots(stored);

    // --- Geräteliste und Räume laden ---
    if (this._loggedIn()) {
      if (justLoggedIn || Date.now() - this._api.lastListAt > DEVICE_LIST_MAX_AGE_MS) {
        try {
          await this._refreshRobots();
        } catch (err) {
          feedback = feedback ?? tr(this._lang, err.kind === 'auth' ? 'feedback.auth' : 'feedback.api.unavailable');
        }
      }
      this._startCloud();
      // Räume neu einlesen, wenn Raum-Schalter gerade eingeschaltet wurden
      for (const duid of roomsTurnedOn) {
        const robot = this._findRobot(duid);
        if (!robot) continue;
        try {
          if (!this._canTalk(robot.duid)) await this._waitForCloud();
          await this._refreshRooms(robot, { rebuild: true });
        } catch (err) {
          log.warn(`Raeume ${robot.name} nicht abrufbar: ${err.message}`);
          feedback = feedback ?? tr(this._lang, 'feedback.rooms.unavailable', { device: robot.name });
        }
      }
    }

    // --- HCU-Geräte abgleichen, Reinklusion gelöschter Geräte ---
    this._syncHcuDevices({ reinclude: true });
    this._requestReinclude('Einstellungen gespeichert');

    if (justLoggedIn) {
      this._notify?.dismiss(MSG_ID_AUTH);
      this._sendPluginState(uuidv4());
      this._startListRefresh();
    }
    this._startPolling();
    for (const duid of notifyChanged) this._updateCleaningNotice(this._findRobot(duid), this._rt(duid));
    for (const duid of maintChanged) {
      const r = this._findRobot(duid);
      if (r?.notifyMaintenance === false) this._updateMaintenanceNotice(r, this._rt(duid));   // Hinweis entfernen
      else this._checkMaintenance(duid).catch(() => {});
    }

    this._pushConfigTemplate();
    this._reply(message, 'CONFIG_UPDATE_RESPONSE', feedback ? { status, message: feedback } : { status });
  }

  /**
   * Anmeldeschritt: ohne Code wird einer angefordert, mit Code angemeldet.
   * @returns {Promise<{status:string, feedback:string|null}>}
   */
  async _loginStep(code) {
    const email = this._config.email;
    try {
      if (code) {
        const info = this._login?.email === email ? this._login.info : null;
        const userData = await api.loginWithCode(email, code, this._config.deviceIdentifier, info);
        const account  = accountIdOf(userData, email);
        // Anderes Konto als das der gespeicherten Geräte > alte Geräte entfernen
        if (this._config.deviceAccount && this._config.deviceAccount !== account) this._purgeAccountData();
        this._config.userData      = userData;
        this._config.deviceAccount = account;
        configStore.save(this._config);
        this._login = null;
        this._api   = { ...this._api, ok: null, error: null, lastListAt: 0 };
        return { status: 'APPLIED', feedback: tr(this._lang, 'feedback.login.ok') };
      }
      if (this._login?.email === email && Date.now() - this._login.sentAt < CODE_RESEND_MS) {
        return { status: 'APPLIED', feedback: tr(this._lang, 'feedback.code.sent', { email }) };
      }
      const info = await api.sendCode(email, this._config.deviceIdentifier);
      this._login = { email, info, sentAt: Date.now() };
      return { status: 'APPLIED', feedback: tr(this._lang, 'feedback.code.sent', { email }) };
    } catch (err) {
      log.warn('Roborock-Anmeldung:', err.message);
      const key = {
        invalidCode: 'feedback.login.invalidcode',
        noAccount:   'feedback.login.noaccount',
        tooFrequent: 'feedback.login.toofrequent',
        agreement:   'feedback.login.agreement',
        network:     'feedback.api.unavailable',
      }[err.kind] ?? 'feedback.login.failed';
      return { status: 'FAILED', feedback: tr(this._lang, key, { error: err.message }) };
    }
  }

  /**
   * Kontowechsel: alle Sauger und HCU-Schalter des bisherigen Kontos entfernen.
   * Die Connect API erlaubt dem Plugin kein Löschen in der HCU – bereits
   * eingebundene Schalter werden deshalb nicht mehr bedient und in der App
   * erscheint ein Hinweis, sie dort zu löschen.
   */
  _purgeAccountData() {
    const robots = this._loadRobots();
    const all    = devices.getAll();
    const names  = all.filter(d => d.alreadyIncluded && !d.excluded).map(d => d.friendlyName);
    log.info(`Roborock: Kontowechsel > ${robots.length} Sauger und ${all.length} HCU-Geraet(e) des bisherigen Kontos werden entfernt.`);

    for (const r of robots) {
      this._notify?.dismiss(MSG_ID_CLEANING(r.duid));
      this._notify?.dismiss(MSG_ID_ERROR(r.duid));
      if (r.maintNotice) this._notify?.dismiss(MSG_ID_MAINT(r.duid));
    }
    for (const c of this._local.values()) c.stop();
    this._local.clear();
    this._ipCheckedAt.clear();
    for (const rt of this._runtime.values()) { rt.followups.forEach(clearTimeout); clearTimeout(rt.dockCheck); }
    this._runtime.clear();
    for (const d of all) devices.remove(d.deviceId);
    devicesStore.saveRobots([]);
    this._api = { ...this._api, lastListAt: 0, homeId: null, roomNames: new Map() };

    if (names.length) {
      this._notify?.localized('notification.remove.title', 'notification.remove.message',
        { names: names.join(', ') }, 'WARN', { id: MSG_ID_REMOVE_HINT });
    }
  }

  /** Wartet kurz auf die MQTT-Verbindung (z. B. direkt nach der Anmeldung). */
  _waitForCloud(timeoutMs = 15_000) {
    if (this._cloud.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this._cloud.off('connected', ok); reject(new Error('Roborock-Cloud nicht verbunden')); }, timeoutMs);
      const ok = () => { clearTimeout(timer); resolve(); };
      this._cloud.once('connected', ok);
    });
  }

  _pushConfigTemplate() {
    if (!this._wsOpen()) return;
    this._send({ id: uuidv4(), pluginId: this.pluginId, type: 'CONFIG_TEMPLATE_RESPONSE', body: this._buildTemplate() });
  }

  _groupId(robot) { return `robot_${devices.robotKey(robot.duid)}`; }

  /** Baut groups + properties der Einstellungsseite. */
  _buildTemplate() {
    const lang       = this._lang;
    const groups     = {};
    const properties = {};
    const loggedIn   = this._loggedIn();

    // --- Allgemein ---
    groups.general = {
      friendlyName: t(lang, 'group.general.name'),
      description:  t(lang, loggedIn ? 'group.general.description' : 'group.general.description.login'),
      order:        1,
    };

    properties.email = {
      friendlyName: t(lang, 'settings.email.label'),
      description:  t(lang, 'settings.email.description'),
      dataType:     'STRING',
      groupId:      'general',
      order:        1,
      defaultValue: '',
      currentValue: this._config.email ?? '',
    };
    if (!loggedIn) {
      properties.code = {
        friendlyName: t(lang, 'settings.code.label'),
        description:  t(lang, 'settings.code.description'),
        dataType:     'STRING',
        groupId:      'general',
        order:        2,
        defaultValue: '',
        currentValue: '',
      };
    }
    properties.loginStatus = {
      friendlyName: t(lang, 'settings.status.label'),
      description:  t(lang, 'settings.status.description'),
      dataType:     'READONLY',
      groupId:      'general',
      order:        3,
      currentValue: this._statusText(),
    };
    properties.autoAddNewDevices = {
      friendlyName: t(lang, 'settings.autoadd.label'),
      description:  t(lang, 'settings.autoadd.description'),
      dataType:     'BOOLEAN',
      groupId:      'general',
      order:        4,
      defaultValue: false,
      currentValue: Boolean(this._config.autoAddNewDevices),
    };
    properties.pollInterval = {
      friendlyName: t(lang, 'settings.pollinterval.label'),
      description:  t(lang, 'settings.pollinterval.description'),
      dataType:     'ENUM',
      groupId:      'general',
      order:        5,
      defaultValue: t(lang, 'settings.pollinterval.2min'),
      currentValue: t(lang, `settings.pollinterval.${this._pollIntervalKey()}`),
      values:       Object.keys(POLL_OPTIONS).map(k => t(lang, `settings.pollinterval.${k}`)),
    };

    // --- Ein Tab je Saugroboter ---
    const robots = loggedIn
      ? this._loadRobots().filter(r => r.available !== false)
        .sort((a, b) => String(a.name).localeCompare(String(b.name), lang))
      : [];

    robots.forEach((r, i) => {
      const gid = this._groupId(r);
      groups[gid] = {
        friendlyName: r.name,
        description:  tr(lang, 'group.device.description', {
          model:  r.productName || r.model || '-',
          online: this._connectionText(r),
        }),
        order: 10 + i,
      };

      if (!r.supported) {
        properties[`${gid}_unsupported`] = {
          friendlyName: t(lang, 'device.unsupported.label'),
          description:  tr(lang, 'device.unsupported.description', { pv: r.pv ?? '-' }),
          dataType:     'READONLY',
          groupId:      gid,
          order:        1,
          currentValue: t(lang, 'device.unsupported.value'),
        };
        return;
      }

      properties[`${gid}_add`] = {
        friendlyName: t(lang, 'device.add.label'),
        description:  t(lang, 'device.add.description'),
        dataType:     'BOOLEAN',
        groupId:      gid,
        order:        1,
        defaultValue: false,
        currentValue: Boolean(r.addToHcu),
      };
      properties[`${gid}_rooms`] = {
        friendlyName: t(lang, 'device.rooms.label'),
        description:  t(lang, 'device.rooms.description'),
        dataType:     'BOOLEAN',
        groupId:      gid,
        order:        2,
        defaultValue: false,
        currentValue: Boolean(r.roomSwitches),
      };
      properties[`${gid}_notify`] = {
        friendlyName: t(lang, 'device.notify.label'),
        description:  t(lang, 'device.notify.description'),
        dataType:     'BOOLEAN',
        groupId:      gid,
        order:        3,
        defaultValue: false,
        currentValue: Boolean(r.notifyCleaning),
      };
      properties[`${gid}_battery`] = {
        friendlyName: t(lang, 'device.battery.label'),
        description:  t(lang, 'device.battery.description'),
        dataType:     'BOOLEAN',
        groupId:      gid,
        order:        5,
        defaultValue: false,
        currentValue: Boolean(r.batteryDevice),
      };
      properties[`${gid}_maint`] = {
        friendlyName: t(lang, 'device.maint.label'),
        description:  t(lang, 'device.maint.description'),
        dataType:     'BOOLEAN',
        groupId:      gid,
        order:        4,
        defaultValue: true,
        currentValue: r.notifyMaintenance !== false,
      };
    });

    // --- Backup & Restore (eine Gruppe, Dropdown-Steuerung) ---
    this._addBackupTemplate(groups, properties);

    // --- Info ---
    groups.info = {
      friendlyName: t(lang, 'group.info.name'),
      description:  t(lang, 'group.info.description'),
      order:        999,
    };
    properties.copyrightInfo = {
      friendlyName: t(lang, 'settings.copyrightinfo.label'),
      description:  t(lang, 'settings.copyrightinfo.description'),
      dataType:     'WEBLINK',
      groupId:      'info',
      order:        1,
      defaultValue: t(lang, 'settings.copyrightinfo.linktitle'),
      currentValue: 'https://www.roborock.com/',
    };
    properties.pluginInfo = {
      friendlyName: t(lang, 'settings.pluginInfo.label'),
      description:  t(lang, 'settings.pluginInfo.description'),
      dataType:     'WEBLINK',
      groupId:      'info',
      order:        2,
      defaultValue: t(lang, 'settings.pluginInfo.linktitle'),
      currentValue: REPO_URL,
    };

    return { groups, properties };
  }

  _connectionText(robot) {
    const lang  = this._lang;
    const local = this._local.get(robot.duid);
    if (local?.connected)            return tr(lang, 'device.conn.local', { ip: local.ip });
    if (this._rt(robot.duid).unreach || (robot.online === false && !this._rt(robot.duid).status)) return t(lang, 'device.conn.none');
    if (this._cloud.healthy)         return t(lang, 'device.conn.cloud');
    return t(lang, 'device.conn.none');
  }

  _statusText() {
    const lang = this._lang;
    if (!this._config.email)          return t(lang, 'settings.status.noemail');
    if (!this._loggedIn()) {
      if (this._api.error === 'auth') return t(lang, 'settings.status.expired');
      if (this._login?.email === this._config.email) return tr(lang, 'settings.status.codesent', { email: this._config.email });
      return t(lang, 'settings.status.loggedout');
    }
    if (this._api.error === 'network') return t(lang, 'settings.status.network');
    const count = this._loadRobots().filter(r => r.available !== false).length;
    const vars  = { email: api.maskEmail(this._config.email), count: String(count) };
    if (this._cloud.healthy) return tr(lang, 'settings.status.ok', vars);
    const cs = this._cloudState;
    // Noch nie verbunden und erst kurz dabei > "wird aufgebaut", sonst Ausfall anzeigen
    if (!cs.everHealthy && (!cs.since || Date.now() - cs.since < 60_000)) return tr(lang, 'settings.status.connecting', vars);
    return tr(lang, 'settings.status.cloudlost', { ...vars, since: formatTime(cs.since ?? Date.now()) });
  }

  _addBackupTemplate(groups, properties) {
    const lang       = this._lang;
    const safeLang   = ['de', 'en'].includes(lang) ? lang : 'de';
    const backupHost = this._backupHost;
    const [backupGroup, restoreGroup] = this._backupManager.getConfigGroups();
    const backupActive  = backupGroup.fields.some(f => f.type !== 'BOOLEAN');
    const restoreActive = restoreGroup.fields.some(f => f.type !== 'BOOLEAN');

    const resolve = (s) => String(s ?? '')
      .replace(/\{\{hostname\}\}/g, backupHost)
      .replace(/\{\{lang\}\}/g, safeLang);

    let description = t(lang, 'group.backup_restore.description');
    if (backupActive)  description = resolve(backupGroup.description?.[safeLang]);
    if (restoreActive) description = resolve(restoreGroup.description?.[safeLang]);

    groups.backup_restore = {
      friendlyName: t(lang, 'group.backup_restore.name'),
      description,
      order:        997,
    };

    if (backupActive || restoreActive) {
      const activeFields = backupActive ? backupGroup.fields : restoreGroup.fields;
      activeFields.forEach((field, i) => {
        if (field.type === 'LINK') {
          properties[`backup_restore_${field.id}`] = {
            friendlyName: field.buttonLabel?.[safeLang] ?? field.label?.[safeLang] ?? '',
            description:  field.label?.[safeLang] ?? '',
            dataType:     'WEBLINK',
            groupId:      'backup_restore',
            order:        i + 2,
            defaultValue: field.buttonLabel?.[safeLang] ?? field.label?.[safeLang] ?? '',
            currentValue: resolve(field.url),
          };
        } else if (field.type === 'STRING') {
          const value = field.readOnly ? resolve(field.value) : (field.value ?? '');
          properties[`backup_restore_${field.id}`] = {
            friendlyName: field.label?.[safeLang] ?? '',
            description:  '',
            dataType:     'STRING',
            groupId:      'backup_restore',
            order:        i + 2,
            defaultValue: value,
            currentValue: value,
          };
        }
      });
    } else {
      properties.backup_restore_action = {
        friendlyName: t(lang, 'settings.backup_restore.action.label'),
        description:  t(lang, 'settings.backup_restore.action.description'),
        dataType:     'ENUM',
        groupId:      'backup_restore',
        order:        1,
        defaultValue: t(lang, 'settings.backup_restore.action.disabled'),
        currentValue: t(lang, 'settings.backup_restore.action.disabled'),
        values: [
          t(lang, 'settings.backup_restore.action.disabled'),
          t(lang, 'settings.backup_restore.action.backup'),
          t(lang, 'settings.backup_restore.action.restore'),
        ],
      };
    }
  }

  _pollIntervalKey() {
    const entry = Object.entries(POLL_OPTIONS).find(([, s]) => s === this._config.pollInterval);
    return entry ? entry[0] : '2min';
  }

  _pollIntervalFromDisplay(displayValue) {
    for (const [key, secs] of Object.entries(POLL_OPTIONS)) {
      for (const lang of ['de', 'en']) {
        if (t(lang, `settings.pollinterval.${key}`) === displayValue) return secs;
      }
    }
    const parsed = parseInt(displayValue, 10);
    return Number.isFinite(parsed) && parsed >= 60 ? parsed : configStore.DEFAULTS.pollInterval;
  }

  // ---------------------------------------------------------------------------
  //  Reconnect mit Exponential Backoff
  // ---------------------------------------------------------------------------

  _scheduleReconnect() {
    log.info(`Wiederverbindung in ${this._reconnectDelay / 1000}s ...`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect();
    }, this._reconnectDelay);
    this._reconnectDelay = Math.min(Math.round(this._reconnectDelay * RECONNECT_FACTOR), RECONNECT_MAX_MS);
  }

  _clearReconnect() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }
}

// ---------------------------------------------------------------------------
//  Hilfsfunktionen
// ---------------------------------------------------------------------------

function toBool(v) { return v === true || v === 'true'; }

/** Modellbezeichnung für Gerätenamen, z. B. "Roborock S6" */
function productLabel(robot) {
  const name = String(robot.productName || robot.model || '').trim();
  if (!name) return 'Roborock';
  return /^roborock\b/i.test(name) ? name : `Roborock ${name}`;
}

/** Eindeutige Kennung des Roborock-Kontos (rruid, sonst uid, sonst E-Mail) */
function accountIdOf(userData, email) {
  return String(userData?.rruid ?? userData?.uid ?? String(email ?? '').trim().toLowerCase());
}

/** Uhrzeit HH:MM in deutscher Zeit (Fallback UTC, falls die Zeitzone fehlt) */
function formatTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' });
  } catch {
    return `${new Date(ts).toISOString().slice(11, 16)} UTC`;
  }
}

/** Übersetzung mit Platzhaltern {name} */
function tr(lang, key, vars = {}) {
  return Object.entries(vars).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), t(lang, key));
}

/** Vergleicht Live-Features mit gespeicherten Features (alle Attribute außer type) */
function hasChanges(stored, live) {
  for (const lf of live) {
    const sf = stored.find(f => f.type === lf.type);
    if (!sf) return true;
    for (const [k, v] of Object.entries(lf)) {
      if (k !== 'type' && sf[k] !== v) return true;
    }
  }
  return false;
}

module.exports = Plugin;
