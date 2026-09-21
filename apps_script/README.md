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

En su lugar, el script entra con una **cuenta de servicio que sólo puede insertar
prospectos**. No puede leer el pipeline, ni los costos, ni modificar o borrar nada —
ni siquiera los prospectos que ella misma cargó. Si esa credencial se filtra, lo peor
que puede pasar es que alguien cargue prospectos basura, y se corta borrando la cuenta
en Supabase.

La instalación son **dos pegadas y tres clicks**, y no hace falta saber nada de código.

---

## Paso A — Crear la tabla en Supabase (una sola vez)

1. Entrar al proyecto de Supabase → **SQL Editor** → **New query**.
2. Pegar todo el contenido de `supabase_prospectos.sql` (está en la raíz del repo) y
   darle **Run**.
3. Tiene que decir *Success*. Listo, no se toca más.

## Paso A2 — Crear la cuenta de sincronización (una sola vez)

1. En Supabase → **Authentication** → **Users** → **Add user** → *Create new user*.
   - **Email:** `sheets-sync@labomodular.com` (cualquier dirección sirve, pero **no**
     una `@4housing.com.ar`: los permisos del equipo se dan por ese dominio y la
     cuenta heredaría permisos que no queremos que tenga).
   - **Password:** una contraseña larga y aleatoria.
   - **Auto Confirm User:** sí.
2. Volver al **SQL Editor** y ejecutar `supabase_prospectos_sync.sql` (está en la raíz
   del repo). Es la política que le da a esa cuenta permiso de insertar prospectos, y
   nada más. Si usaste otro mail, cambialo en las dos líneas que indica el archivo.

## Paso B — Pegar el script en el Sheet (una sola vez)

1. Abrir el Sheet → **Extensiones → Apps Script**.
2. Borrar lo que haya en `Código.gs` y pegar todo el contenido de `sync_prospectos.gs`.
3. Guardar (el disquete) y **cerrar la pestaña de Apps Script**. No hay que volver.
4. Volver al Sheet y **recargar la página**. Arriba, al lado de *Ayuda*, aparece un
   menú nuevo: **LABO CRM**.

## Paso C — Los tres clicks

Todo desde el menú **LABO CRM** del Sheet, en orden:

**1 · Conectar con el CRM**
Pide tres cosas: la URL del proyecto (ya viene puesta, dale Aceptar), y el **mail y la
contraseña de la cuenta de sincronización** creada en el paso A2. La primera vez Google
va a pedir autorizar el script: es de ustedes, aceptar. Si todo está bien, contesta
*✓ Conectado*.

> Esa contraseña queda guardada en el Sheet y el proveedor que lo administra podría
> leerla. Está bien que así sea: esa cuenta no puede hacer nada más que cargar
> prospectos. Lo que **nunca** va ahí es la `service_role key` del proyecto.

**2 · Subir el histórico**
Manda al CRM todo lo que ya está cargado (las ~450 filas), con su etapa, estado,
calidad, responsable y comentarios. Avisa cuántas subió. Es seguro repetirlo: lo que
ya está no se duplica ni se pisa.

**3 · Activar sincronización automática**
Desde ese momento los leads nuevos entran solos cada 10 minutos.

El menú tiene además **Sincronizar ahora** (si no querés esperar), **Ver estado**
(cuántas filas de cada hoja ya están en el CRM) y **Desactivar sincronización**.

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
Sí, desde el menú: **LABO CRM → Desactivar sincronización**. Y para cortar el acceso de
raíz, sin depender del Sheet: Supabase → *Authentication* → *Users* → borrar la cuenta
de sincronización (o cambiarle la contraseña). El CRM y el equipo no se ven afectados.

**¿Qué pasa si el proveedor lee la contraseña guardada en el script?**
Puede cargar prospectos en el CRM y nada más. No puede leer el pipeline, ni los
precios, ni los costos, ni tocar un registro existente. Si pasara, se borra la cuenta y
listo.
