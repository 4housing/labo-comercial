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
(la misma que ya viaja en el HTML del CRM) y la base le permite una sola cosa, insertar
prospectos. No puede leer el pipeline, ni los costos, ni modificar o borrar nada — ni
siquiera los prospectos que él mismo carga.

Lo que sí queda expuesto: alguien que encuentre la clave pública podría cargar
prospectos basura en la bandeja. Es visible, se borra, y se corta en el acto quitando
la política en Supabase (está al pie de `supabase_prospectos_sync.sql`).

Al pegar este script, además, **se borra sola cualquier credencial que hubieran dejado
las versiones anteriores**, incluida la `service_role key`.

La instalación son **dos pegadas y tres clicks**, y no hace falta saber nada de código.

---

## Paso A — Crear la tabla en Supabase (una sola vez)

1. Entrar al proyecto de Supabase → **SQL Editor** → **New query**.
2. Pegar todo el contenido de `supabase_prospectos.sql` (está en la raíz del repo) y
   darle **Run**.
3. Tiene que decir *Success*. Listo, no se toca más.

## Paso A2 — Permisos y arreglo del índice (una sola vez)

En el **SQL Editor**, ejecutar `supabase_prospectos_sync.sql` (está en la raíz del
repo). Hace dos cosas: corrige el índice de deduplicación —la primera versión lo creaba
parcial y eso hacía fallar cualquier reenvío con un 409— y le da al Sheet permiso de
insertar prospectos, nada más. Es idempotente: se puede correr de nuevo sin problema.

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
Manda al CRM todo lo que ya está cargado (las ~450 filas), con su etapa, estado,
calidad, responsable y comentarios. Avisa cuántas subió. Es seguro repetirlo: lo que
ya está no se duplica ni se pisa.

**2 · Activar sincronización automática**
Desde ese momento los leads nuevos entran solos cada 10 minutos. La primera vez Google
va a pedir autorizar el script: es de ustedes, aceptar.

El menú tiene además **Sincronizar ahora** (si no querés esperar), **Ver estado**
(cuántas filas de cada hoja ya están en el CRM), **Probar conexión** y **Desactivar
sincronización**.

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

La hoja **Brochure** entra con `fuente = brochure`; la hoja **Landing Meta**, con
origen `Meta`. Cualquier columna que no esté en esta tabla igual se guarda completa en
el campo `raw`, así que nunca se pierde nada.

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
`drop policy prospectos_insert_sheet on public.labocomercial_prospectos;`
El CRM y el equipo no se ven afectados.

**¿Qué pasa si alguien de afuera descubre la clave pública?**
Puede cargar prospectos basura en la bandeja y nada más: no puede leer el pipeline, ni
los precios, ni los costos, ni tocar un registro existente. Se ve enseguida, se borran
las filas y se quita la política de arriba. El CRM además trata todo lo que llega por
esta vía como contenido no confiable al mostrarlo.
