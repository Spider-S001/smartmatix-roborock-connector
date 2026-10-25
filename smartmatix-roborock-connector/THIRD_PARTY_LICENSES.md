# Third-Party Licenses

SmartMatix Roborock Connector makes use of the following open source packages and resources.
All licenses are reproduced below as required by their respective terms.

---

## ws (v8.22.0)

WebSocket client and server for Node.js.  
https://github.com/websockets/ws

```
Copyright (c) 2011 Einar Otto Stangvik <einaros@gmail.com>
Copyright (c) 2013 Arnout Kazemier and contributors
Copyright (c) 2016 Luigi Pinca and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

---

## uuid (v11.x)

RFC-compliant UUID generation for Node.js and browser.  
https://github.com/uuidjs/uuid

```
The MIT License (MIT)

Copyright (c) 2010-2020 Robert Kieffer and other contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## mqtt (v5.16.0)

MQTT.js – MQTT client for Node.js, used for the connection to the Roborock cloud.  
https://github.com/mqttjs/MQTT.js

```
The MIT License (MIT)
=====================

Copyright (c) 2015-2016 MQTT.js contributors
---------------------------------------

*MQTT.js contributors listed at <https://github.com/mqttjs/MQTT.js#contributors>*

Copyright 2011-2014 by Adam Rudd

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

Installing `mqtt` also installs its own dependencies into `node_modules`; their
license files are contained in the respective package folders.

---

## Homematic IP Connect API

Node.js example plugins and API documentation by eQ-3 AG.  
This plugin is based in part on the official Node.js example code from:  
https://github.com/homematicip/connect-api

```
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   Copyright 2024 eQ-3 AG

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

Homematic IP is a trademark of eQ-3 AG.

---

## python-roborock

The Roborock cloud protocol (sign-in, Hawk request signing, MQTT message
format and encryption, V1 commands) was ported to JavaScript based on the
python-roborock library, which is also used by the Home Assistant Roborock
integration:  
https://github.com/Python-roborock/python-roborock

```
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   Copyright python-roborock contributors

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

Changes: reimplemented in Node.js; only the parts needed for sign-in by
e-mail code, home data, rooms, the V1 ("1.0") vacuum commands and the local
connection (TCP 58867, protocols "1.0" and "L01") were ported.

---

## Roborock cloud

This plugin communicates with Roborock robot vacuums via the Roborock cloud
using the user's own Roborock account. No Roborock source code is included in
this plugin. The credentials are used exclusively to read the user's device
list, rooms and device states and to send cleaning commands to the user's own
robot vacuums.

Roborock is a trademark of Beijing Roborock Technology Co., Ltd.

---

## Node.js Built-in Modules

This software uses the following modules that are part of the Node.js standard
library and are not separately installed npm packages:

- **`fs`** – File system access (reading and writing JSON data files)
- **`path`** – File path utilities
- **`https`** – HTTPS client (Backup & Restore, update check)
- **`http`** – Temporary local web server for Backup & Restore
- **`events`** – Event emitter for the Roborock connections
- **`net`** – TCP client for the local connection to the robot vacuums
- **`crypto`** – Random token generation (Backup & Restore) and the AES/MD5/HMAC functions of the Roborock protocol

These modules are distributed as part of Node.js (https://nodejs.org), which
is licensed under the MIT License. Node.js itself is not bundled with this
software.
