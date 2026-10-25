# Basis-Image der HCU (ARM64 – Pflicht für Deployment auf der HCU)
FROM --platform=linux/arm64 ghcr.io/homematicip/alpine-node-simple:0.0.1

WORKDIR /app

# Abhängigkeiten: vorinstallierte node_modules direkt mitkopieren.
# npm install läuft auf dem Build-Rechner (vor docker build),
# nicht im emulierten ARM64-Container via QEMU – das verhindert
# Installationsfehler bei der Cross-Compilation.
COPY package*.json  ./
COPY node_modules/  ./node_modules/

# Quellcode kopieren
COPY src/        ./src/
COPY lang/       ./lang/

# Einstiegspunkt:
#   Argument 1: Plugin-ID
#   Argument 2: HCU-Host (host.containers.internal = HCU selbst)
#   Argument 3: Pfad zur Auth-Token-Datei (von der HCU bereitgestellt unter /TOKEN)
EXPOSE 8747

ENTRYPOINT ["node", "src/index.js", "de.smartmatix.plugin.roborock-connector", "host.containers.internal", "/TOKEN"]

# ---------------------------------------------------------------------------
#  Plugin-Metadaten (PFLICHT für die HCU – exakt dieses Label-Format)
#
#  pluginId      muss identisch mit der ENTRYPOINT-Plugin-ID sein
#  hcuMinVersion 1.7.9
#  scope         CLOUD (Anmeldung und Geräteliste über die Roborock-Cloud; Steuerung lokal mit Cloud-Rückfall)
# ---------------------------------------------------------------------------
LABEL de.eq3.hmip.plugin.metadata='\
{\
  "pluginId": "de.smartmatix.plugin.roborock-connector",\
  "issuer": "Kevin Schipper",\
  "version": "0.3.4",\
  "hcuMinVersion": "1.7.9",\
  "scope": "CLOUD",\
  "settings": [],\
  "friendlyName": {\
    "en": "SmartMatix Roborock Connector",\
    "de": "SmartMatix Roborock Connector"\
  },\
  "description": {\
    "en": "A plugin for controlling your Roborock robot vacuums via the HCU.",\
    "de": "Ein Plugin, um deine Roborock-Saugroboter über die HCU zu steuern."\
  },\
  "image": "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",\
  "logsEnabled": true\
}'
