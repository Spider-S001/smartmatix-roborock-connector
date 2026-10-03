'use strict';

/**
 * notifications.js – Wiederverwendbare HCU-Benachrichtigungs-Bibliothek
 *
 * Stellt eine notification()-Funktion bereit, mit der Plugins
 * Nachrichten in der Homematic IP App anzeigen können.
 *
 * Verwendung im Plugin:
 *   const { createNotifier } = require('./notifications');
 *   const { t }              = require('./localization');
 *
 *   // Mit Translator (ermöglicht notify.localized()):
 *   const notify = createNotifier(pluginId, sendFn, t);
 *
 *   // Direkte Strings/Sprachobjekte:
 *   notify('Scan gestartet', 'Suche läuft 5 Minuten.');
 *   notify({ de: 'Fehler', en: 'Error' }, { de: '...', en: '...' }, 'ERROR');
 *
 *   // Localization-Keys (benötigt Translator):
 *   notify.localized('notif.scan.started.title', 'notif.scan.started.message');
 *   notify.localized('notif.api.unavail.title',  'notif.api.unavail.message',
 *                    { suffix: ' (1.2.3.4)' }, 'ERROR', { id: 'api-unavail' });
 *
 *   notify.dismiss('mein-msg-id');
 *
 * messageCategory:
 *   'INFO' | 'WARN' | 'ERROR'
 *   (SUCCESS existiert laut API-Doku nicht – INFO verwenden)
 *
 * behaviorType (Connect API 1.0.1):
 *   'DISMISSIBLE'              – Benutzer kann schließen (kein Ack-Event)
 *   'NOT_DISMISSIBLE'          – Kann nicht geschlossen werden
 *   'ACKNOWLEDGEABLE_BY_OK'    – Bestätigung per OK (Ack-Event folgt)
 *   'ACKNOWLEDGEABLE_BY_YES_NO'– Bestätigung per Ja/Nein (Ack-Event folgt)
 */

const { v4: uuidv4 } = require('uuid');
const log            = require('./logger');

// Gültige BehaviorType-Werte
const VALID_BEHAVIOR_TYPES = new Set([
  'DISMISSIBLE',
  'NOT_DISMISSIBLE',
  'ACKNOWLEDGEABLE_BY_OK',
  'ACKNOWLEDGEABLE_BY_YES_NO',
]);

// Gültige MessageCategory-Werte der Connect API: ERROR, INFO, WARN
// ('WARNING' lehnt die HCU ab – wird zur Kompatibilität auf WARN abgebildet)
const VALID_CATEGORIES = new Set(['INFO', 'WARN', 'ERROR']);
const CATEGORY_ALIASES = { WARNING: 'WARN' };

// Sprachen die in lokalisierten Nachrichten erzeugt werden
const SUPPORTED_LANGUAGES = ['de', 'en'];

/**
 * Erstellt einen Notifier der an einen bestimmten Plugin-WebSocket gebunden ist
 *
 * @param {string}   pluginId       – Plugin-ID
 * @param {Function} sendFn         – plugin._send Funktion
 * @param {Function} [translator]   – Optionale Übersetzungsfunktion: (lang, key) => string
 *                                    Wird benötigt für notify.localized().
 * @returns {Function} notify(title, message, category, opts)
 *                     + notify.localized(titleKey, messageKey, vars, category, opts)
 *                     + notify.dismiss(id)
 */
function createNotifier(pluginId, sendFn, translator = null) {

  /**
   * Sendet eine Benachrichtigung an die HCU
   *
   * @param {string|{de:string,en:string}} title    – Titel
   * @param {string|{de:string,en:string}} message  – Nachrichtentext
   * @param {string} [category]    – 'INFO' | 'WARN' | 'ERROR' (Standard: 'INFO')
   * @param {object} [opts]
   * @param {string} [opts.id]           – Feste Message-ID für späteres Dismiss/Replace
   * @param {string} [opts.behaviorType] – Standard: 'DISMISSIBLE'
   * @returns {string} Die verwendete Message-ID
   */
  function notification(title, message, category = 'INFO', opts = {}) {
    const msgId = opts.id ?? uuidv4();

    // Kategorie validieren und ggf. auf INFO fallen
    category = CATEGORY_ALIASES[category] ?? category;
    const msgCategory = VALID_CATEGORIES.has(category) ? category : 'INFO';
    if (!VALID_CATEGORIES.has(category)) {
      log.warn(`Notification: Ungueltige messageCategory "${category}" > INFO`);
    }

    // BehaviorType validieren
    const behaviorType = VALID_BEHAVIOR_TYPES.has(opts.behaviorType)
      ? opts.behaviorType
      : 'DISMISSIBLE';
    if (opts.behaviorType && !VALID_BEHAVIOR_TYPES.has(opts.behaviorType)) {
      log.warn(`Notification: Ungueltiger behaviorType "${opts.behaviorType}" > DISMISSIBLE`);
    }

    // Titel/Nachricht normalisieren: String > { de, en }
    const titleObj   = typeof title   === 'string' ? { de: title,   en: title   } : title;
    const messageObj = typeof message === 'string' ? { de: message, en: message } : message;

    log.info(`Notification [${msgCategory}/${behaviorType}] "${titleObj.de ?? titleObj.en}"`);

    sendFn({
      id:       uuidv4(),
      pluginId,
      type:     'CREATE_USER_MESSAGE_REQUEST',
      body: {
        userMessageId:   msgId,
        messageCategory: msgCategory,
        behaviorType,
        timestamp:       Date.now(),
        title:           titleObj,
        message:         messageObj,
      },
    });

    return msgId;
  }

  /**
   * Erzeugt ein { de, en } Sprachobjekt aus einem Localization-Key
   * Platzhalter wie {ip} oder {count} werden via vars-Map ersetzt
   *
   * @param {string} key    – Localization-Key (z.B. 'notification.api.unavailable.title')
   * @param {object} [vars] – Map mit Platzhalter-Werten
   * @returns {{ de: string, en: string }}
   */
  function buildLocalized(key, vars = {}) {
    if (!translator) {
      throw new Error('notify.localized() benoetigt einen Translator (3. Argument von createNotifier).');
    }
    const result = {};
    for (const lang of SUPPORTED_LANGUAGES) {
      let text = translator(lang, key);
      for (const [k, v] of Object.entries(vars)) {
        text = text.replaceAll(`{${k}}`, String(v));
      }
      result[lang] = text;
    }
    return result;
  }

  /**
   * Sendet eine Benachrichtigung mit Localization-Keys statt Text-Strings
   * Setzt voraus, dass createNotifier mit einer Übersetzungsfunktion initialisiert wurde
   *
   * @param {string} titleKey   – Localization-Key für den Titel
   * @param {string} messageKey – Localization-Key für die Nachricht
   * @param {object} [vars]     – Platzhalter-Map für titleKey UND messageKey
   * @param {string} [category] – 'INFO' | 'WARN' | 'ERROR'
   * @param {object} [opts]     – Wie in notification()
   * @returns {string} Die verwendete Message-ID
   */
  notification.localized = function localized(titleKey, messageKey, vars = {}, category = 'INFO', opts = {}) {
    return notification(
      buildLocalized(titleKey, vars),
      buildLocalized(messageKey, vars),
      category,
      opts,
    );
  };

  /**
   * Löscht eine bestehende Benachrichtigung anhand ihrer ID
   * @param {string} msgId
   */
  notification.dismiss = function dismiss(msgId) {
    if (!msgId) return;
    log.debug(`Notification dismiss: ${msgId}`);
    sendFn({
      id:       uuidv4(),
      pluginId,
      type:     'DELETE_USER_MESSAGE_REQUEST',
      body:     { userMessageId: msgId },
    });
  };

  return notification;
}

module.exports = { createNotifier };
