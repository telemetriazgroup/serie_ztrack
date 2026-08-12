se requiere un api que al ejecutar un metodo get , genere un codigo , segun la estructura  :

ZG(AÑO)(MES)(DIA)(HORA)(MINUTO)(SEGUNDO)(CORRELATIVO)

Si AÑO es 2026 -> se toma 26

Si el MES es 8 -> se toma 08

Si el DIA es 12 -> se toma 12

Si el HORA es 14 -> se toma 14

Si el MINUTO es 53 -> se toma 53

Si el SEGUNDO es 4 -> se toma 04

CORRELATIVO -> en pieza con 0 , si hbiera mas en ese segundo , se coloca +1 ose a1 y luego 2 y asi sucesivamente 

En este caso el codigo seria : ZG2608121453040

EN EL Metodo GET previamnete envia un CODIGO  : IP:PUERTO/serie/generar/SERIE

ejemplo 161.132.53.51:9490/serie/generar/ZG001


Se enetinde que ZG001 es un dispositivo recien grabado , necesita un codigo y se genera el codigo y se devuelve para  ZG2608121453040 que el que consuma la aplicacion spa que codigo es ahora , si vuelve a querer generar  un codigo  

ejemplo 161.132.53.51:9490/serie/generar/ZG2608121453040

no le va crear un codigo nuevo , le va devolver el mismo codigo y le va decir que ya el codigo esta creado y asignado .

luego implementar las rutas para modificar , archivar , el codigo , listar ultimo codigo creado , con la infromacion de cuando fue creado y su historico si hubo modificaciones . listar los ultimos 10 codigos creeados , listar  todo los codigos creados . una ruta que  muestre la estadistica de cuantos  codigos  se crearon el dia de hoy , esta semana , este mes y esta año 


