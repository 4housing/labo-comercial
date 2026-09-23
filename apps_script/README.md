# Sincronización Google Sheet → CRM LABO

Los leads de Google Ads y Meta caen en el Sheet **“Envíos Formularios - Labo Modular”**.
Este script los manda solos al CRM, a la pestaña **Prospectos**, cada 10 minutos.

El Sheet sigue funcionando igual que siempre: el script sólo **lee** las filas y agrega
una columna `CRM` al final de cada hoja para marcar lo que ya está adentro. No toca
ninguna otra celda y no borra nada.

## Antes que nada: por qué el script no usa la llave maestra

Este Sheet lo administra un proveedor externo. **Cualquiera con acceso de edición al
Sheet puede abrir el editor de Apps Script y leer las credenciales guardadas ahí**, en
texto plano. Por eso el script no usa la `service_role key` de Supabase: esa clave
saltea todas las reglas de seguridad y da control total del proyecto (el pipeline
completo con datos de clientes y montos, el historial de costos con márgenes, y la
administración de usuarios).

En su lugar, **el script no guarda ningún secreto**: usa la clave pública del proyecto
(la misma que ya viaja en el HTML del CRM) y la base le deja una sola puerta, la función
`labocomercial_prospectos_ingest`, que valida y carga prospectos. El script no tiene
ningún permiso sobre la tabla: no puede leer el pipeline, ni los costos, ni modificar o
borrar nada — ni siquiera los prospectos que él mismo carga.

Lo que sí queda expuesto: alguien que encuentre la clave pública podría cargar
prospectos basura en la bandeja. Es visible, se borra, y se corta en el acto quitando
el permiso en Supabase (está al pie de `supabase_prospectos_sync.sql`).

Al pegar este script, además, **se borra sola cualquier credencial que hubieran dejado
las versiones anteriores**, incluida la `service_role key`.

La instalación son **dos pegadas y tres clicks**, y no hace falta saber nada de código.

---

## Paso A — Crear la tabla en Supabase (una sola vez)

1. Entrar al proyecto de Supabase → **SQL Editor** → **New query**.
2. Pegar todo el contenido de `supabase_prospectos.sql` (está en la raíz del repo) y
   darle **Run**.
3. Tiene que decir *Success*. Listo, no se toca más.

## Paso A2 — Permisos y función de carga (una sola vez)

En el **SQL Editor**, ejecutar `supabase_prospectos_sync.sql` (está en la raíz del
repo). Corrige el índice de deduplicación —la primera versión lo creaba parcial y eso
hacía fallar cualquier reenvío con un 409—, crea la función de carga y le da al Sheet
permiso para ejecutarla, nada más. Es idempotente: se puede correr de nuevo sin
problema.

Por qué una función y no un permiso de insert directo: el script deduplica con
`ON CONFLICT`, y para resolver un conflicto Postgres necesita poder **leer** la fila que
ya existe. El rol del Sheet no tiene lectura (a propósito), así que el insert directo
rebotaba con un error de RLS en cuanto llegaba una fila nueva. La función corre con los
permisos de su dueño: deduplica adentro, y el Sheet nunca toca la tabla.

## Paso B — Pegar el script en el Sheet (una sola vez)

1. Abrir el Sheet → **Extensiones → Apps Script**.
2. Borrar lo que haya en `Código.gs` y pegar todo el contenido de `sync_prospectos.gs`.
3. Guardar (el disquete) y **cerrar la pestaña de Apps Script**. No hay que volver.
4. Volver al Sheet y **recargar la página**. Arriba, al lado de *Ayuda*, aparece un
   menú nuevo: **LABO CRM**.

## Paso C — Los dos clicks

Todo desde el menú **LABO CRM** del Sheet, en orden. No hay nada que configurar: el
script no necesita credenciales.

**1 · Subir el histórico**
Manda al CRM todo lo que ya está cargado en Formulario y Brochure, con su etapa, estado,
calidad, responsable y comentarios. Avisa cuántas subió. Es seguro repetirlo: lo que
ya está no se duplica ni se pisa.

**2 · Activar sincronización automática**
Desde ese momento los leads nuevos entran solos cada 10 minutos. La primera vez Google
va a pedir autorizar el script: es de ustedes, aceptar.

El menú tiene además **Sincronizar ahora** (si no querés esperar), **Ver estado**
(cómo terminó la última corrida automática y cuántas filas de cada hoja ya están en el
CRM), **Probar conexión** y **Desactivar sincronización**.

**Ver estado** es el lugar donde mirar cuando algo no aparece en el CRM: si la última
corrida falló, ahí está el error con fecha y hora. El disparador corre sin nadie
mirando, así que un fallo no avisa por sí solo.

---

## Cómo se traduce cada columna

| Google Sheet | CRM |
|---|---|
| Entry ID | clave de deduplicación (nunca entra dos veces) |
| Nombre y Apellido / Teléfono / Correo Electrónico | datos del contacto |
| Modelo / Tipo de proyecto / Comentarios adicional | interés declarado |
| Fecha / URL / Región | origen |
| Etapa (1° contacto, 2° contacto) | `Contactado` + cantidad de contactos |
| Estado (En curso) | `En seguimiento` |
| Estado (No avanza) | `Descartado` |
| Calidad del lead | Bueno / Regular / Malo |
| Contacto (Hector, …) | Responsable |
| Comentarios | Notas |
| ¿Descargó brochure? | marca de brochure |

La hoja **Brochure** entra con `fuente = brochure`. La hoja **Landing Meta** no se
sincroniza: es una tabla de configuración de la agencia, no una fuente de leads.
Cualquier columna que no esté en esta tabla igual se guarda completa en el campo
`raw`, así que nunca se pierde nada.

## Si cambian las columnas del Sheet

El script busca las columnas **por nombre de encabezado**, sin importar el orden, ni
mayúsculas, ni acentos. Si le cambian el nombre a una columna, agregar el nombre nuevo
a la lista `ALIAS` arriba de todo del script. Si agregan una hoja nueva, sumarla al
array `HOJAS`. Si una hoja del array no existe, el script avisa y sigue con las otras.

## Preguntas frecuentes

**¿Qué pasa si alguien edita una fila vieja en el Sheet?**
No vuelve al CRM. Una vez adentro, el registro se trabaja desde el CRM — si no, dos
personas editando en dos lados se pisan. Por eso la idea es que la gestión (etapa,
responsable, notas) pase a hacerse en la pestaña Prospectos.

**¿Y si borro la marca de la columna CRM?**
Esa fila se vuelve a mandar en la próxima corrida. Como la base deduplica por Entry ID,
no se crea un duplicado: sólo se vuelve a marcar.

**¿Se rompe si alguien agrega filas mientras corre?**
No. Cada corrida toma lo que hay en ese momento y lo que quede afuera entra en la
siguiente, diez minutos después.

**¿Se puede apagar?**
Sí, desde el menú: **LABO CRM → Desactivar sincronización**. Y para cortar la carga de
raíz, sin depender del Sheet ni de quien lo administre, desde el SQL Editor:
`revoke execute on function public.labocomercial_prospectos_ingest(jsonb) from anon;`
El CRM y el equipo no se ven afectados.

**¿Qué pasa si alguien de afuera descubre la clave pública?**
Puede cargar prospectos basura en la bandeja y nada más: no puede leer el pipeline, ni
los precios, ni los costos, ni tocar un registro existente. Se ve enseguida, se borran
las filas y se quita el permiso de arriba. El CRM además trata todo lo que llega por
esta vía como contenido no confiable al mostrarlo.
