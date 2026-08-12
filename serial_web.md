# Monitor serial web multiplataforma
## Documentación de portabilidad, detección de dispositivos y recepción de datos en Windows, Linux y macOS

---

## 1. El problema real

Un monitor serial web tiene tres capas y cada una se rompe distinto en cada sistema operativo:

```
[ dispositivo ] --USB--> [ driver del SO ] --> [ nodo/puerto ] --> [ API ] --> [ UI web ]
   Arduino Uno            usbser / cdc_acm      COM3                Web Serial   navegador
   ESP32 (CP2102)         cp210x / AppleUSB…    /dev/ttyUSB0        o agente
   clon CH340             ch341 / usbserial     /dev/cu.usbserial-…
```

**La capa web es la única que es igual en los tres sistemas.** Todo el trabajo de portabilidad está en las dos capas de abajo: qué driver reclama el chip, cómo se llama el nodo resultante, y quién tiene permiso para abrirlo.

---

## 2. Cómo aparece un dispositivo serial en cada sistema

| | Windows | Linux | macOS |
|---|---|---|---|
| **Nombre del nodo** | `COM3`, `COM17` | `/dev/ttyACM0` (CDC), `/dev/ttyUSB0` (conversores) | `/dev/cu.usbmodem14201` (CDC), `/dev/cu.usbserial-A50285BI` |
| **Nombre estable** | No garantizado; cambia por puerto físico si el dispositivo no tiene número de serie | `/dev/serial/by-id/usb-Arduino__www.arduino.cc__0043_75432…-if00` | No hay; el sufijo incluye el Location ID del puerto USB |
| **>9 puertos** | Hay que abrir `\\.\COM10`, no `COM10` | Sin problema | Sin problema |
| **Permisos** | Ninguno especial | **El usuario debe pertenecer a `dialout`** (o regla udev) | Ninguno especial |
| **Enumeración nativa** | SetupAPI / registro `HKLM\SYSTEM\CurrentControlSet\Enum\USB` | sysfs `/sys/class/tty/*/device` | IOKit (`IOSerialBSDClient`) |
| **Exclusividad** | El SO abre el puerto en exclusiva por defecto | Avisoria: `TIOCEXCL` + lock files `/var/lock/LCK..ttyUSB0` | `TIOCEXCL` |

### 2.1 `cu.*` vs `tty.*` en macOS — error clásico

macOS crea **dos nodos por puerto**:

- `/dev/tty.usbserial-XXXX` → modo *callin*: `open()` **se bloquea** hasta que aparezca portadora (DCD). Con un Arduino se queda colgado para siempre.
- `/dev/cu.usbserial-XXXX` → modo *callout*: abre de inmediato.

**Usa siempre `cu.*` y filtra los `tty.*` de la lista.** También filtra `/dev/cu.Bluetooth-Incoming-Port` y `/dev/cu.debug-console`, que aparecen siempre y no son nada.

### 2.2 Drivers por chip conversor

| Chip | Windows | Linux (kernel) | macOS |
|---|---|---|---|
| CDC-ACM nativo (Uno R3, Leonardo, STM32 USB, Pico) | `usbser.sys` (INF a veces requerido en Win7/8) | `cdc_acm` — incluido | `AppleUSBACM` — incluido |
| FTDI FT232/FT2232 | Driver FTDI (Windows Update lo instala) | `ftdi_sio` — incluido | Incluido desde 10.9 |
| Silicon Labs CP210x | Driver SiLabs | `cp210x` — incluido | Incluido en macOS moderno |
| WCH CH340/CH341 | Driver WCH (los clones baratos casi siempre lo piden) | `ch341` — incluido | Incluido desde Mojave 10.14 |
| Prolific PL2303 | Driver Prolific; los clones falsificados son bloqueados adrede por el driver oficial | `pl2303` — incluido | Incluido para chips modernos |

Trampas conocidas que vas a encontrar en soporte:

- **macOS + CH340:** si el usuario instaló el kext de WCH *además* del driver de Apple, aparecen **dos puertos fantasma en conflicto** y ninguno funciona. La solución es desinstalar el kext OEM. Con el driver de Apple, mantén el baudrate en **460 800 o menos**; por encima se degrada.
- **Ubuntu + CH340:** el paquete `brltty` (soporte braille) reclama el VID/PID `1a86:7523` y se queda con el puerto ~5 s después de conectarlo, o directamente lo secuestra. `sudo apt remove brltty` o una regla udev que lo excluya.
- **Linux + CDC-ACM:** `ModemManager` sondea todo `/dev/ttyACM*` durante ~10 s al conectar, enviando comandos AT a tu dispositivo. Se ve como basura en el RX y como "puerto ocupado".
- **Windows:** el número de COM se asigna por (VID, PID, número de serie). Un ESP32 sin número de serie recibe **un COM distinto por cada puerto USB físico** que uses, y el registro acumula decenas de COM "en uso" fantasma.

### 2.3 Reglas udev necesarias en Linux

`/etc/udev/rules.d/99-serial.rules`:

```udev
# Acceso al usuario de la sesión física (mejor que meter a todos en dialout)
SUBSYSTEM=="tty", ATTRS{idVendor}=="1a86", TAG+="uaccess"
SUBSYSTEM=="tty", ATTRS{idVendor}=="10c4", TAG+="uaccess"
SUBSYSTEM=="tty", ATTRS{idVendor}=="0403", TAG+="uaccess"
SUBSYSTEM=="tty", ATTRS{idVendor}=="2341", TAG+="uaccess"

# Que ModemManager no toque nuestros equipos
SUBSYSTEM=="tty", ATTRS{idVendor}=="2341", ENV{ID_MM_DEVICE_IGNORE}="1"
SUBSYSTEM=="tty", ATTRS{idVendor}=="1a86", ENV{ID_MM_DEVICE_IGNORE}="1"

# Que brltty no secuestre el CH340
SUBSYSTEM=="usb", ATTRS{idVendor}=="1a86", ATTRS{idProduct}=="7523", ENV{BRLTTY_BRAILLE_DRIVER}="", ENV{BRLTTY_NO_PROBE}="1"

# Nombre estable propio, independiente del orden de conexión
SUBSYSTEM=="tty", ATTRS{idVendor}=="0403", ATTRS{serial}=="A50285BI", SYMLINK+="ztrack/gateway0"
```

```bash
sudo udevadm control --reload-rules && sudo udevadm trigger
```

`TAG+="uaccess"` es preferible a `usermod -aG dialout $USER`: da acceso solo al usuario que tiene la sesión gráfica activa, no requiere cerrar sesión, y no abre el puerto a cuentas de servicio.

---

## 3. Capa web: qué te da y qué te niega la Web Serial API

### 3.1 Soporte de navegadores (agosto 2026)

| Navegador | Estado |
|---|---|
| Chrome / Edge / Opera escritorio | Soportado desde la versión 89 (2021) en Windows, macOS, Linux y ChromeOS |
| Firefox escritorio | <cite index="16-1">Soportado desde Firefox 151 (mayo 2026); Firefox en Android todavía no</cite> |
| Chrome Android | <cite index="4-1">Añadido en la beta de Chrome 148, abril 2026</cite> |
| Safari / iOS / iPadOS | No soportado |

Dos implicancias nuevas por el lado de Firefox:

- <cite index="9-1">Firefox usa "add-on gating": la primera vez que un sitio pide acceso a un puerto aparece un aviso de permiso de sitio *antes* del selector de puertos</cite>. Tu UI debe tolerar que el usuario tarde varios segundos o rechace ese primer paso sin que quede en estado inconsistente.
- <cite index="9-1">Bajo políticas empresariales de Firefox la API viene deshabilitada por defecto y el administrador la habilita con `DefaultSerialGuardSetting`</cite>. En Chrome/Edge el equivalente es `SerialAskForUrls` / `SerialBlockedForUrls`. **En una empresa con equipos administrados esto es lo primero que hay que pedirle a TI.**

### 3.2 La limitación central: no hay enumeración

<cite index="14-1">La API obliga a que el sitio llame a `navigator.serial.requestPort()`, donde el usuario elige qué puerto permitir. El sitio no recibe la lista de dispositivos conectados</cite> — es una decisión de diseño anti-fingerprinting, no un bug que se pueda rodear.

Consecuencias prácticas:

- **No puedes mostrar "COM3" ni "/dev/ttyUSB0"** en tu UI. El nombre del nodo nunca cruza al JavaScript en ningún sistema operativo.
- **No puedes auto-conectar al arrancar** salvo con puertos ya autorizados antes.
- **Todo `requestPort()` necesita un gesto del usuario** (click). No sirve llamarlo desde un `setInterval` de reconexión.

Lo único que sí obtienes:

```js
const port = await navigator.serial.requestPort({
  filters: [                       // acota el selector; opcional
    { usbVendorId: 0x2341 },       // Arduino
    { usbVendorId: 0x1a86, usbProductId: 0x7523 }, // CH340
    { usbVendorId: 0x10c4 },       // Silicon Labs
    { usbVendorId: 0x0403 },       // FTDI
  ]
});
const { usbVendorId, usbProductId } = port.getInfo();  // eso es todo
```

Y los puertos ya autorizados:

```js
const puertos = await navigator.serial.getPorts();  // sin diálogo, permiso persistido por origen
```

El permiso se guarda **por origen y por puerto**, así que un `https://serial.ztrack.app` recuerda los puertos entre sesiones; un `file://` local normalmente no. Esa sola diferencia justifica servir la herramienta por HTTPS aunque sea desde la LAN.

### 3.3 Sustituto de la enumeración: catálogo VID/PID + etiqueta del usuario

Como el SO no te da nombres, constrúyelos tú:

```js
const CATALOGO = {
  '2341': { marca: 'Arduino', modelos: { '0043': 'Uno R3', '0001': 'Uno', '8036': 'Leonardo', '0042': 'Mega 2560' } },
  '1a86': { marca: 'WCH',     modelos: { '7523': 'CH340 (clon Uno/Nano)', '55d4': 'CH9102' } },
  '10c4': { marca: 'Silicon Labs', modelos: { 'ea60': 'CP2102 (ESP32 DevKit)' } },
  '0403': { marca: 'FTDI',    modelos: { '6001': 'FT232R', '6015': 'FT231X' } },
  '303a': { marca: 'Espressif', modelos: { '1001': 'ESP32-S3 USB-CDC' } },
  '0483': { marca: 'STMicro', modelos: { '5740': 'STM32 CDC', '374b': 'ST-Link V3' } },
};

function etiqueta(info) {
  const vid = info.usbVendorId?.toString(16).padStart(4, '0');
  const pid = info.usbProductId?.toString(16).padStart(4, '0');
  const e = CATALOGO[vid];
  return e ? `${e.marca} ${e.modelos[pid] ?? pid}` : `Dispositivo ${vid}:${pid}`;
}
```

Complétalo con un alias que el usuario escriba y guardes en `IndexedDB`, indexado por VID+PID (y por el objeto `SerialPort`, que es comparable por identidad con `===` entre los resultados de `getPorts()`).

### 3.4 Reconexión y desconexión física

Estos eventos sí son multiplataforma y son la única "detección de dispositivos" que tienes:

```js
navigator.serial.addEventListener('connect', e => {
  // e.target es un puerto YA autorizado que se acaba de enchufar
  reconectar(e.target);              // no requiere gesto del usuario
});
navigator.serial.addEventListener('disconnect', e => {
  if (e.target === puertoActual) cerrarLimpio();
});
```

Diferencias de comportamiento al desconectar en caliente:

- **Windows:** `reader.read()` rechaza con `NetworkError`; el objeto `port` queda inservible.
- **Linux:** el nodo `/dev/ttyUSB0` desaparece de inmediato; suele llegar primero un `done: true`.
- **macOS:** puede tardar 1–2 s en emitir el evento; conviene un watchdog por inactividad además del evento.

### 3.5 Errores del stream: obligatorio en Linux y con cables largos

La lectura no falla "una vez"; **el `ReadableStream` se cierra con error** ante `BreakError`, `FramingError`, `ParityError` o `BufferOverrunError`, y hay que volver a tomar el reader. Por eso el bucle correcto es doble:

```js
while (port.readable && seguirLeyendo) {          // ← reengancha tras un error
  const reader = port.readable.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      procesar(value);
    }
  } catch (e) {
    registrar(`Error de trama/paridad: ${e.name}`); // no es fatal: sigue el while externo
  } finally {
    reader.releaseLock();
  }
}
```

Un bucle simple funciona en el escritorio limpio del desarrollador y falla en planta con un RS485 de 200 m.

### 3.6 Otras implicancias transversales

- **Contexto seguro obligatorio:** HTTPS, `localhost` o `file://` en Chrome. HTTP plano en una IP de LAN **no sirve**. Para un despliegue interno: certificado propio o `mkcert`.
- **Iframes:** requiere `allow="serial"` en el iframe padre. Es la razón por la que un monitor serial no funciona embebido dentro de otra aplicación web sin cooperación del contenedor.
- **Baudios no estándar (250000 de Marlin, 76800):** Windows y macOS los aceptan; en Linux dependen de que el driver soporte `BOTHER`/`termios2`. Pruébalo con el hardware real antes de prometerlo.
- **DTR/RTS:** `port.setSignals({dataTerminalReady, requestToSend, break})` y `port.getSignals()` (CTS, DCD, DSR, RI). En **Linux y macOS, abrir el puerto asierta DTR** y reinicia una placa tipo Arduino; en Windows depende del driver. Tu UI debe advertirlo, no ocultarlo.
- **RS485 half-duplex:** `setSignals()` es asíncrono y pasa por IPC del navegador — decenas de milisegundos. **No sirve para conmutar DE/RE por trama.** Con Web Serial necesitas adaptadores de dirección automática. Esto es una restricción dura, no un detalle de implementación.
- **Un puerto, un consumidor:** si el IDE de Arduino, `screen` o tu propio agente tienen el puerto abierto, `open()` falla. En Linux la exclusión es *avisoria*: dos procesos pueden abrirlo y corromperse los datos mutuamente si ninguno usa `TIOCEXCL`.

---

## 4. Capa agente: lo que hay que construir cuando Web Serial no alcanza

Necesitas agente si requieres **nombres reales de puerto, lista automática de dispositivos, acceso remoto, log persistente, RS485 con control de dirección o varios observadores del mismo puerto**. Es decir: prácticamente cualquier uso industrial.

### 4.1 Enumeración real y normalizada

`pyserial` ya abstrae los tres backends (SetupAPI en Windows, sysfs en Linux, IOKit en macOS):

```python
import sys
from serial.tools import list_ports

RUIDO = ('Bluetooth-Incoming-Port', 'debug-console', 'wlan-debug')

def listar():
    salida = []
    for p in list_ports.comports():
        if sys.platform == 'darwin':
            if not p.device.startswith('/dev/cu.'):   # descarta los tty.* bloqueantes
                continue
            if any(r in p.device for r in RUIDO):
                continue
        if sys.platform.startswith('linux') and p.device.startswith('/dev/ttyS'):
            if not p.vid:                              # UART legacy inexistente
                continue
        salida.append({
            'ruta':        p.device,          # COM3 | /dev/ttyUSB0 | /dev/cu.usbserial-A5
            'estable':     estable(p),        # /dev/serial/by-id/... en Linux
            'descripcion': p.description,     # "USB-SERIAL CH340 (COM3)"
            'fabricante':  p.manufacturer,
            'vid':         p.vid, 'pid': p.pid,
            'serie':       p.serial_number,   # ancla la identidad del equipo
            'ubicacion':   p.location,        # bus-puerto físico USB
        })
    return salida

def estable(p):
    import glob, os
    if sys.platform.startswith('linux'):
        for enlace in glob.glob('/dev/serial/by-id/*'):
            if os.path.realpath(enlace) == p.device:
                return enlace
    return p.device
```

**Identifica los equipos por `serial_number`, nunca por `COM3` ni por `/dev/ttyUSB0`.** Esos nombres cambian entre reinicios, entre puertos USB y entre sistemas operativos; el número de serie no.

### 4.2 Hot-plug multiplataforma

Nativo: `WM_DEVICECHANGE` en Windows, `pyudev` en Linux, notificaciones IOKit en macOS. Tres implementaciones distintas y frágiles. **En la práctica un sondeo de `comports()` cada 1–2 s y un diff contra el estado anterior es suficiente**, cuesta menos de 10 ms y es idéntico en los tres sistemas. Emítelo al navegador por WebSocket:

```json
{"evt":"puertos","alta":[{"ruta":"COM7","serie":"75432333438351A0B1C2"}],"baja":["COM3"]}
```

### 4.3 Apertura correcta por sistema

```python
ser = serial.Serial()
ser.port = ruta
ser.baudrate = 115200
ser.timeout = 0.05
ser.exclusive = True          # POSIX: TIOCEXCL. Sin esto, dos clientes se pisan.
ser.dsrdtr = False            # evita el reset automático al abrir
ser.rtscts = False
ser.open()
```

- **Evitar el reset del Arduino al abrir:** en Linux `stty -F /dev/ttyUSB0 -hupcl` antes de abrir, o mantener el puerto abierto permanentemente. En macOS es inevitable con `cu.*` salvo hardware que no cablee DTR al reset.
- **Latencia FTDI:** el *latency timer* por defecto es de 16 ms y arruina protocolos de petición/respuesta. Linux: `echo 1 | sudo tee /sys/bus/usb-serial/devices/ttyUSB0/latency_timer`. Windows: propiedades avanzadas del puerto COM. macOS: no es configurable con el driver de Apple.
- **Lectura:** nunca en el loop async directo. `await loop.run_in_executor(None, ser.read, max(1, ser.in_waiting))` o un hilo dedicado que empuje a una `asyncio.Queue`.

### 4.4 Instalación y firma — el costo oculto de "multiplataforma"

| | Windows | Linux | macOS |
|---|---|---|---|
| Arranque | Servicio (`sc create`) o tarea al iniciar sesión | unidad `systemd --user` | `launchd` LaunchAgent |
| Empaquetado | MSI/EXE, PyInstaller | `.deb`/`.rpm`/AppImage | `.pkg` o `.app` |
| Firma | Certificado de firma de código (SmartScreen bloquea sin él) | No requerida | **Firma Apple Developer ID + notarización**, si no Gatekeeper lo bloquea |
| Permisos | Ninguno | Reglas udev (§2.3) | Ninguno para el puerto |

Presupuesta la firma en macOS y Windows desde el principio: un agente sin firmar hace que la instalación en un cliente sea imposible en la práctica.

### 4.5 Seguridad — no negociable

Un agente que expone puertos serie es un ejecutor remoto de comandos sobre hardware físico.

- Escuchar en `127.0.0.1` únicamente. Si hace falta remoto, que sea el agente quien establezca la conexión saliente hacia tu backend (WebSocket cliente), nunca un puerto abierto en la máquina del cliente.
- Token por instalación en el handshake del WebSocket, y `Origin` validado contra una lista blanca. Sin esto, **cualquier página web abierta en ese equipo puede leer y escribir en tus puertos serie**, que es exactamente la clase de ataque que el modelo de permisos de Web Serial existe para evitar.
- Rate limit en TX y tope de tamaño de trama: evita que un cliente comprometido meta al dispositivo en modo bootloader.

---

## 5. Arquitectura recomendada: transporte conmutable

Una sola UI, dos backends detrás de la misma interfaz:

```js
class Transporte {
  async listar() {}            // agente: nombres reales | web serial: puertos autorizados
  async abrir(id, config) {}
  async escribir(bytes) {}
  onDatos(cb) {}
  async señales(s) {}
  async cerrar() {}
}
```

Resolución en el arranque:

1. Intentar `GET http://127.0.0.1:8765/salud` con timeout de 300 ms → si responde, `TransporteAgente`.
2. Si no y existe `navigator.serial` → `TransporteWebSerial` (modo reducido: sin nombres de puerto, sin RS485 dirigido).
3. Si no → pantalla que explica qué navegador usar y ofrece el instalador del agente para el SO detectado.

El punto 3 importa: con Safari y iOS fuera de la ecuación de forma permanente, la web tiene que degradar de forma explicativa, no fallar en silencio.

---

## 6. Matriz mínima de pruebas antes de liberar

| Escenario | Win 11 | Ubuntu 24.04 | macOS 14+ |
|---|---|---|---|
| Arduino Uno original (CDC) a 115200 | | | |
| Clon con CH340 a 115200 | | | |
| ESP32 con CP2102 a 921600 | | | |
| Adaptador FTDI RS485 a 9600, 8N1 | | | |
| Desconexión física durante RX activo | | | |
| Reconexión: ¿reaparece sin recargar la página? | | | |
| Puerto ya ocupado por el IDE de Arduino: ¿mensaje claro? | | | |
| Baudrate no estándar (250000) | | | |
| Ráfaga de 1 MB continuos: ¿la UI sigue respondiendo? | | | |
| Pulso DTR: ¿reinicia la placa? ¿se ve el `setup()`? | | | |
| Bytes con paridad errónea: ¿reengancha el reader? | | | |
| Sin sesión previa: ¿el permiso persiste tras reiniciar el navegador? | | | |

Las tres filas de errores (desconexión, puerto ocupado, paridad) son las que separan una demo de una herramienta que se usa en planta.

---

## 7. Resumen de decisiones

1. **Web Serial nunca te dará el nombre del puerto ni la lista de dispositivos, en ningún sistema operativo.** Si eso es requisito, el agente local no es opcional.
2. **Linux es el único de los tres que requiere configuración previa del sistema** (grupo/udev, ModemManager, brltty). Documéntalo como paso de instalación, con un script que lo aplique.
3. **macOS es el que más falla por drivers de terceros mal instalados** (CH340 duplicado) y el que exige notarización si distribuyes agente.
4. **Windows es el más fácil para el usuario y el más frágil para la identidad del puerto**: numeración de COM inestable, `\\.\COM10`.
5. **Identifica siempre por VID/PID + número de serie**, jamás por la ruta del puerto.
6. **El bucle de lectura debe reengancharse tras errores de stream**, y el renderizado debe desacoplarse del RX con `requestAnimationFrame` y tope de líneas.