/*
  Ejemplo mínimo para probar ZTrack Serial Web.
  - Al arrancar imprime la serie actual
  - SERIE?        → responde con el código
  - SET_SERIE xxx → guarda en RAM (añade EEPROM/NVS en producción)
*/

String serie = "ZG001";

void setup() {
  Serial.begin(115200);
  while (!Serial) { ; }
  delay(200);
  Serial.println(serie);
  Serial.println("ZTrack listo. Comandos: SERIE? | SET_SERIE <codigo>");
}

void loop() {
  if (!Serial.available()) return;

  String line = Serial.readStringUntil('\n');
  line.trim();
  if (line.length() == 0) return;

  if (line.equalsIgnoreCase("SERIE?") || line.equalsIgnoreCase("GET_SERIE")) {
    Serial.println(serie);
    return;
  }

  if (line.startsWith("SET_SERIE ")) {
    String nuevo = line.substring(10);
    nuevo.trim();
    if (nuevo.startsWith("ZG") && nuevo.length() >= 5) {
      serie = nuevo;
      Serial.print("OK ");
      Serial.println(serie);
    } else {
      Serial.println("ERR codigo invalido");
    }
    return;
  }

  Serial.println("ERR comando desconocido");
}
