# SmartMatix Roborock Connector

![Das Plugin-Icon von SmartMatix Roborock Connector](/Screenshots/Roborock-Connector-Header.png "Plugin-Icon")

Ein Plugin für die **Homematic IP Home Control Unit (HCU)**, das Roborock-Saugroboter in das Homematic IP System einbindet – über die [Connect API 1.0.1](https://github.com/homematicip/connect-api).

> Entwickelt von **Kevin Schipper** · Plugin-ID: `de.smartmatix.plugin.roborock-connector`

---

## Einsatzmöglichkeiten

Mit dem **SmartMatix Roborock Connector** startest und stoppst du deine Roborock-Saugroboter direkt über deine **Homematic IP** Zentrale (ganze Wohnung oder einzelne Räume) und nutzt sie in Homematic-IP-Automatisierungen (z. B. "Reinigen, wenn alle das Haus verlassen haben").

![So siehst du deine Roborock-Geräte in der Homematic IP App](/Screenshots/Schalter-des-Roborock-Connectors-in-der-Homematic-IP-App.jpg "Darstellung der Roborock-Saugroboter in der Homematic IP App")

![Hinweise zur Reinigung in der Homematic IP App](/Screenshots/Reinigungsbenachrichtigung-des-Roborock-Connectors-in-der-Homematic-IP-App.jpg "Während der Reinigung wird in der Homematic IP App ein Hinweis angezeigt")

---

## Features

- **Anmeldung per E-Mail-Code** – wie in der Roborock-App, kein Passwort nötig
- **Schalter "Reinigen (Gerätename)"** je Saugroboter – an: Reinigung der ganzen Wohnung, aus: Stopp und zurück zur Station
- **Optional ein Schalter je Raum** "Reinige &lt;Raum&gt; (Gerätename)" für alle Räume der aktiven Karte; Räume, die innerhalb von 3 Sekunden eingeschaltet werden, reinigt der Sauger in einem Durchgang
- **Schalter zeigen den echten Zustand** – sie gehen von selbst auf "Aus", sobald die Reinigung beendet ist
- **Störungen** – meldet der Sauger einen Fehler (z. B. "Roboter steckt fest", "Hauptbürste blockiert"), erscheint sofort eine schließbare Nachricht in der App und der Hauptschalter "Reinigen" zeigt Sabotage (`maintenance.sabotage`, nutzbar in HmIP-Automationen). Ist die Störung behoben, verschwindet beides automatisch. Raumschalter melden keine Sabotage.
- **Wartungshinweise** – ist die Laufzeit von Hauptbürste (300 h), Seitenbürste (200 h), Filter (150 h) oder Sensoren (30 h) erreicht oder meldet die Station etwas (z. B. "Schmutzwassertank voll"), erscheint eine schließbare Nachricht. Sie bleibt stehen – auch nach der Reinigung –, bis die Wartung erledigt und der Zähler in der Roborock-App zurückgesetzt ist. Abgefragt wird nach jeder Reinigung und einmal täglich.
- **Optionaler Hinweis in der App** – Nachricht, solange gereinigt wird, mit der Angabe "ganze Wohnung" oder welche Räume
- **Optional als Fahrzeug** – der Saugroboter zusätzlich als `VEHICLE`, z. B. "Staubi (Roborock S6 Saugroboter)", mit dem Akkustand des Saugers (`batteryState`); bei 20 % oder weniger setzt es `maintenance.lowBat`, z. B. für Automationen
- **Auswahl per Haken** – nur Sauger mit gesetztem Haken "Zu Homematic IP hinzufügen" werden eingebunden
- **Neue Geräte automatisch hinzufügen** – vor der Anmeldung gesetzt: alle Sauger; nachträglich gesetzt: nur wirklich neue
- **Reinkludieren** – in der App gelöschte Schalter werden beim nächsten Speichern oder Plugin-Start (HCU Neustart) erneut hinzugefügt, solange der Haken gesetzt ist
- **Erreichbarkeit** – offline-Sauger werden in der App als nicht erreichbar angezeigt (`maintenance.unreach`)
- **Persistenz** – alle Geräte und Konfigurationsdaten liegen in `/data` und überleben Updates und Neustarts
- **Lokale Steuerung** – Befehle und Status laufen direkt im Heimnetz; die Roborock-Cloud ist nur Rückfall
- **Automatische Wiederverbindung** – zur HCU (Exponential Backoff), zu den Saugern und zur Roborock-Cloud (inkl. Neuaufbau "stummer" Cloud-Verbindungen)
- **Backup & Restore** – alle Plugin-Daten lassen sich als JSON-Datei exportieren und wiederherstellen

![Die Einrichtung des Plugins](/Screenshots/Einstellungen-des-Roborock-Connectors-in-der-HCU-1.jpg "Konfigurationsmöglichkeiten im Roborock Plugin")

![Wartungshinweise für die Roboter in der Homematic IP App](/Screenshots/Wartungshinweis-des-Roborock-Connectors-in-der-Homematic-IP-App.jpg "Wartungshinweise für die Roboter in der Homematic IP App")

---

## Unterstützte Geräte

Alle Roborock-Saugroboter, die das Roborock-Protokoll **1.0** sprechen – u. a. die Serien S4–S8, Q5, Q8, Qrevo und Saros (z. B. S5, S6, S7 MaxV, S8 Pro Ultra).

Sauger mit den neueren Protokollen **A01/B01** (z. B. die Q7-/Q10-Serie) erscheinen in den Einstellungen als "nicht unterstützt". Nass-Trocken-Sauger, Waschmaschinen und Mähroboter werden nicht angezeigt.

| Roborock | Homematic IP | Funktion |
|---|---|---|
| Saugroboter | `SWITCH` "Reinigen (Gerätename)" | Ein = Reinigung starten, Aus = Stopp + zur Station |
| je Raum (optional) | `SWITCH` "Reinige &lt;Raum&gt; (Gerätename)" | Ein = Raumreinigung, Aus = Stopp + zur Station |
| Fahrzeug (optional) | `VEHICLE` "Gerätename (Roborock Modell Saugroboter)" | Akkustand des Saugers (0–100 %), `lowBat` bei ≤ 20 % |

Alle Geräte haben den Modelltyp `roborock-vacuum-robot`.

---

## Voraussetzungen

| Voraussetzung | Version |
|---|---|
| Node.js | ≥ 18 |
| HCU-Firmware | ≥ 1.7.9 |
| Roborock-Konto | Anmeldung in der Roborock-App (nicht Mi Home / Xiaomi Home) |
| Internetzugang der HCU | für Anmeldung, Geräteliste und Raumnamen; Steuerung läuft lokal, die Cloud dient als Rückfall |
| Entwicklermodus | aktiviert (HCUweb) |

---

## Projektstruktur

```
smartmatix-roborock-connector/
├── Dockerfile                        ← Deployment auf der HCU (ARM64)
├── package.json
├── README.md
├── THIRD_PARTY_LICENSES.md
├── data/
│   ├── config.json                   ← E-Mail, Zugangsdaten, Auto-Add, Intervall
│   ├── devices.json                  ← HCU-Schalter mit Roborock-Verknüpfung
│   └── roborock.json                 ← Sauger-Cache inkl. Haken und Räumen
├── lang/
│   └── localization.json             ← Plugin-Übersetzungen (de/en)
└── src/
    ├── index.js                      ← Einstiegspunkt
    ├── plugin.js                     ← WebSocket, Protokoll, Einstellungsmenü, Polling
    ├── roborockApi.js                ← REST: Anmeldung, Geräte, Räume
    ├── roborockLocal.js              ← lokale Verbindung zum Sauger (TCP 58867)
    ├── roborockMqtt.js               ← MQTT-Verbindung zur Roborock-Cloud (Rückfall)
    ├── roborockProtocol.js           ← Nachrichtenformat und Verschlüsselung (Protokoll 1.0)
    ├── roborockVacuum.js             ← Befehle und Zustände der Sauger
    ├── devices.js                    ← Verwaltung der HCU-Schalter
    ├── devicesStore.js               ← Persistenz für Geräte & Roborock-Daten
    ├── configStore.js                ← Persistenz für Konfiguration
    ├── backup-plugin-data.js         ← Bibliothek: Backup & Restore (nicht verändern)
    ├── localization.js               ← Übersetzungen ausgeben
    ├── logger.js                     ← Konsolenlogger
    └── notifications.js              ← HCU-Benachrichtigungen
```

---

## Ersteinrichtung in der HCUweb

Die Einstellungsseite der HCU kann nichts nachladen – deshalb erfolgt die Anmeldung in zwei Speicher-Schritten:

1. Plugin-Einstellungen öffnen (`Plugins → SmartMatix Roborock Connector → Einstellungen`)
2. Im Tab **Allgemein** die E-Mail-Adresse deines Roborock-Kontos eintragen und **speichern** – Roborock schickt dir einen Code per E-Mail
3. Den Code im Feld **"Code aus der E-Mail"** eintragen und erneut **speichern**
4. Optional vorher: **"Neue Saugroboter automatisch hinzufügen"** setzen – dann werden sofort alle Sauger eingebunden
5. Danach erscheint für jeden Saugroboter ein eigener Tab: Haken **"Zu Homematic IP hinzufügen"** und bei Bedarf **"Schalter für jeden Raum anlegen"** setzen und speichern
6. Die Schalter im Posteingang der Homematic IP App bestätigen

---

## Einstellungen in der HCUweb

### Allgemein

| Einstellung | Beschreibung | Standard |
|---|---|---|
| **E-Mail-Adresse** | Roborock-Konto. Leeren und speichern = abmelden | – |
| **Code aus der E-Mail** | Nur sichtbar, solange das Plugin nicht angemeldet ist. Leer lassen und speichern = neuen Code anfordern | – |
| **Verbindungsstatus** | Angemeldet / Code gesendet / Anmeldung abgelaufen / Cloud nicht erreichbar | – |
| **Neue Saugroboter automatisch hinzufügen** | Vor der Anmeldung: alle Sauger; nachträglich: nur neue Sauger | Nein |
| **Status-Abfrageintervall** | 1, 2, 5 oder 10 min | 2 min |

### Je Saugroboter

| Einstellung | Beschreibung |
|---|---|
| **Zu Homematic IP hinzufügen** | Schalter "Reinigen" anlegen. Haken entfernen = Schalter werden nicht mehr bedient, Hinweis in der App zum Löschen |
| **Schalter für jeden Raum anlegen** | Zusätzlich je Raum der aktiven Karte ein Schalter. Der Sauger muss beim Speichern online sein |
| **Hinweis in der App bei laufender Reinigung** | Schließbare Nachricht in der Homematic IP App, solange der Sauger reinigt – "ganze Wohnung", die Namen der Räume (bei Start über das Plugin), "einzelne Räume" (bei Start in der Roborock-App) oder "Zone". Verschwindet nach Ende der Reinigung automatisch |
| **Wartungshinweise in der App** | Nachricht, wenn Hauptbürste, Seitenbürste, Filter oder Sensoren fällig sind oder die Station etwas meldet. Standard: an |
| **Saugroboter als Fahrzeug anlegen** | Zusätzlich ein Gerät "Gerätename (Roborock Modell Saugroboter)" vom Typ Fahrzeug (`VEHICLE`), das den Akkustand anzeigt und bei ≤ 20 % "Batterie schwach" (`lowBat`) meldet. Standard: aus |

---

## Verhalten der Schalter

- **Einschalten "Reinigen"** startet die Reinigung der ganzen Wohnung (`app_start`).
- **Einschalten eines Raums** startet die Raumreinigung (`app_segment_clean`). Werden mehrere Räume innerhalb von 3 Sekunden eingeschaltet (z. B. per Automation), reinigt der Sauger sie in einem Durchgang. Ein neuer Raumbefehl ersetzt eine laufende Reinigung.
- **Ausschalten** (Hauptschalter oder Raum) beendet die Reinigung und schickt den Sauger zur Station (`app_charge`, wie "Zur Station" in der Roborock-App). Fährt er nach 8 Sekunden nicht los, sendet das Plugin den Befehl einmal erneut.
- **Status:** Der Hauptschalter ist an, solange der Sauger reinigt (auch in Pausen und beim Mopp-Waschen). Ein Raumschalter ist an, solange eine über das Plugin gestartete Raumreinigung dieses Raums läuft. Wird eine Raumreinigung in der Roborock-App gestartet, geht nur der Hauptschalter an.
- **Abgleich:** Zustandswechsel, die der Sauger selbst meldet, kommen sofort an; zusätzlich fragt das Plugin im eingestellten Intervall ab (Standard 2 min).
- **Räume und Karten:** Es werden die Räume der aktiven Karte verwendet. Wechselt die aktive Karte, bleiben die Schalter der anderen Karte erhalten, sind aber ohne Funktion. Haken "Schalter für jeden Raum" aus- und wieder einschalten liest die Räume neu ein.

---

## Geräte löschen und reinkludieren

- **In der Homematic IP App gelöscht:** Das Plugin bedient den Schalter nicht mehr (`EXCLUSION_EVENT`). Ist der Haken weiterhin gesetzt, wird er beim **nächsten Speichern** der Plugin-Einstellungen **oder beim nächsten Plugin-Start** mit derselben Geräte-ID wieder hinzugefügt.
- **Roborock-Konto gewechselt:** Meldest du dich mit einem anderen Roborock-Konto an, entfernt das Plugin alle Sauger und Schalter des bisherigen Kontos. Bereits eingebundene Schalter werden nicht mehr bedient, und in der App erscheint ein Hinweis, sie dort zu löschen. Abmelden und erneutes Anmelden mit demselben Konto behält die Geräte.
- **Haken entfernt:** Die Connect API erlaubt dem Plugin nicht, Geräte in der HCU zu löschen. Das Plugin bedient die Schalter deshalb nicht mehr und zeigt in der App einen Hinweis, sie dort zu löschen.

---

## Verbindung zu den Saugern

Die Anbindung folgt der Home-Assistant-Integration bzw. der Bibliothek [python-roborock](https://github.com/Python-roborock/python-roborock):

- **Anmeldung:** E-Mail-Code über die Roborock-Cloud (`/api/v4/email/code/send`, `/api/v4/auth/email/login/code`), Region wird über den EU-Server ermittelt
- **Geräte und Räume:** REST (`/v3/user/homes/{id}`, Hawk-signiert) – Roborock begrenzt diese Abfrage auf ca. 40 pro Tag, das Plugin lädt die Liste deshalb höchstens stündlich bzw. beim Öffnen der Einstellungen (max. alle 10 min)
- **Befehle und Status – lokal zuerst:** Das Plugin fragt die IP-Adresse jedes eingebundenen Saugers einmal über die Cloud ab (`get_network_info`), speichert sie und verbindet sich dann direkt per TCP auf Port **58867** (Protokoll `1.0`, bei neuerer Firmware `L01`). Ping alle 10 s; bricht die Verbindung ab, baut das Plugin sie selbst wieder auf (10 s bis 5 min Abstand). Ist der Sauger mehrfach nicht erreichbar, wird die IP-Adresse neu abgefragt (höchstens alle 10 min).
- **Rückfall Cloud:** Ohne lokale Verbindung laufen Befehle über MQTT/TLS (`rr/m/i/…` / `rr/m/o/…`). Die Roborock-Cloud hält Verbindungen manchmal scheinbar offen, stellt aber keine Nachrichten mehr zu. Bleibt eine Anfrage unbeantwortet, baut das Plugin die MQTT-Verbindung deshalb neu auf und prüft sie mit einer Anfrage – in wachsenden Abständen (20 s, 2, 5, 15, 30, 60 min), bis wieder eine Antwort kommt.
- **Cloud-Ausfall:** Ist die Cloud gar nicht verbunden oder scheitert auch die Prüfung nach dem Neuaufbau, erscheint in der App eine schließbare Nachricht "Roborock-Cloud nicht erreichbar" (mit dem Hinweis, ob die Sauger weiterhin lokal gesteuert werden). Sie verschwindet, sobald wieder etwas über die Cloud ankommt. Ein Sauger, der nur kurz nicht erreichbar war, löst so keinen Hinweis aus. Im Normalbetrieb gibt es keine Testanfragen – solange alles lokal läuft, fällt ein Cloud-Ausfall erst beim nächsten Cloud-Befehl auf. Der Verbindungsstatus in den Einstellungen zeigt dann "Roborock-Cloud nicht erreichbar seit …".
- **Status im Tab:** Die Beschreibung jedes Saugers zeigt "lokal verbunden (IP)", "über die Roborock-Cloud verbunden" oder "nicht erreichbar".
- **Log:** Verbindungsabbrüche, Neuaufbau und der Grund für "nicht erreichbar" werden als INFO/WARN protokolliert.

> **Tipp:** Vergib dem Sauger im Router eine feste IP-Adresse. Ändert sie sich doch, findet das Plugin die neue Adresse über die Cloud.

---

## Backup & Restore

**Backup erstellen:**
1. Unter "Backup & Wiederherstellung" die Aktion **Backup starten** wählen und speichern
2. Einstellungen erneut öffnen → Button zum Herunterladen erscheint
3. Die Backup-Datei einmalig herunterladen – danach verfällt der Link automatisch

**Backup wiederherstellen:**
1. Aktion **Wiederherstellung starten** wählen und speichern
2. Einstellungen erneut öffnen → Sicherheits-Token und Link zur Restore-Seite erscheinen
3. Restore-Seite öffnen, Token eingeben und Backup-Datei hochladen
4. Das Plugin startet nach erfolgreicher Wiederherstellung automatisch neu

> **Hinweis:** Der temporäre Backup-/Restore-Server lauscht auf Port **8747** (`BACKUP_PORT` in `plugin.js`, passend zu `EXPOSE` im Dockerfile), damit er nicht mit anderen SmartMatix-Plugins (8743) kollidiert.

> **Hinweis:** Ein Backup einer neueren Hauptversion kann nicht in eine ältere Hauptversion eingespielt werden.

---

## Lokale Entwicklung

```bash
git clone https://github.com/Spider-S001/smartmatix-roborock-connector.git
cd smartmatix-roborock-connector
npm install
echo "DEIN-AUTHTOKEN" > authtoken.txt
node src/index.js de.smartmatix.plugin.roborock-connector hcu1-XXXX.local authtoken.txt
```

Mit Debug-Logging:

```bash
LOG_LEVEL=debug node src/index.js de.smartmatix.plugin.roborock-connector hcu1-XXXX.local authtoken.txt
```

---

## Deployment auf der HCU

```bash
npm install --omit=dev
docker buildx build --platform linux/arm64 -t smartmatix-roborock-connector:0.1.0 .
docker save smartmatix-roborock-connector:0.1.0 | gzip > smartmatix-roborock-connector-0.1.0.tar.gz
```

HCUweb öffnen → **Plugins** → `.tar.gz`-Datei hochladen.

---

## Protokollablauf

```
Plugin                                    HCU                      Roborock-Cloud / Sauger
  │── PLUGIN_STATE_RESPONSE ─────────────►│  CONFIG_REQUIRED
  │◄── CONFIG_UPDATE_REQUEST ─────────────│  E-Mail gespeichert
  │── [REST: Code anfordern] ─────────────┼───────────────────────►│
  │◄── CONFIG_UPDATE_REQUEST ─────────────│  Code gespeichert
  │── [REST: Login, Home-Daten] ──────────┼───────────────────────►│
  │── [MQTT: verbinden, abonnieren] ──────┼───────────────────────►│
  │── PLUGIN_STATE_RESPONSE READY ───────►│  triggert Discover
  │◄── DISCOVER_REQUEST ──────────────────│
  │── DISCOVER_RESPONSE ─────────────────►│  angehakte Schalter
  │◄── CONTROL_REQUEST ───────────────────│
  │── [lokal TCP 58867, sonst MQTT: app_start / app_segment_clean / app_charge] ►│
  │── CONTROL_RESPONSE + STATUS_EVENT ───►│
  │◄──────────────────────────────────────┼── [lokal/MQTT: Push Zustand]│
  │── STATUS_EVENT (bei Änderung) ───────►│
  │   [Intervall] get_status (lokal, sonst MQTT)
```

---

## Datenhaltung

| Datei | Inhalt |
|---|---|
| `config.json` | E-Mail, Zugangsdaten der Roborock-Cloud, Auto-Add, Polling-Intervall |
| `devices.json` | HCU-Schalter mit Roborock-Verknüpfung und Aufnahme-Status |
| `roborock.json` | Sauger-Cache (Modell, localKey, Räume) und Haken je Sauger |

> **Sicherheitshinweis:** Die Zugangsdaten der Roborock-Cloud und die `localKey`s der Sauger werden im Klartext in `/data` gespeichert. Der Zugriff auf `/data` ist durch die Container-Isolierung der HCU geschützt. Backups enthalten diese Daten ebenfalls.

---

## Lizenz

Siehe [LICENSE](./LICENSE).  
Copyright © 2026 Kevin Schipper
