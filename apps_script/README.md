# Sincronización Google Sheet → CRM LABO

Los leads de Google Ads y Meta caen en el Sheet **“Envíos Formularios - Labo Modular”**.
Este script los manda solos al CRM, a la pestaña **Prospectos**, cada 10 minutos.

El Sheet sigue funcionando igual que siempre: el script sólo **lee** las filas y agrega
una columna `CRM` al final de cada hoja para marcar lo que ya está adentro. No toca
ninguna otra celda y no borra nada.

---

## 1. Crear la tabla en Supabase (una sola vez)

1. Entrar al proyecto de Supabase → **SQL Editor**.
2. Pegar y ejecutar el contenido de `supabase_prospectos.sql` (está en la raíz del repo).

## 2. Instalar el script en el Sheet (una sola vez)

1. Abrir el Sheet → **Extensiones → Apps Script**.
2. Borrar el contenido de `Código.gs` y pegar el de `sync_prospectos.gs`.
3. **Configuración del proyecto** (el engranaje de la izquierda) → bajar hasta
   **Propiedades del script** → **Agregar propiedad**, dos veces:

   | Propiedad | Valor |
   |---|---|
   | `SUPABASE_URL` | `https://wcpkpwxhqdcdljfwzcmy.supabase.co` |
   | `SUPABASE_SERVICE_KEY` | la **service_role key** del proyecto (Supabase → Project Settings → API) |

   > ⚠️ La `service_role key` es la llave maestra de la base. Va **solamente acá**,
   > nunca en el HTML del CRM, nunca en el repo, nunca en un mail o un chat.
   > Apps Script corre en los servidores de Google: la clave no queda expuesta al
   > navegador de nadie.

4. Arriba, elegir la función **`verificarConexion`** y darle **Ejecutar**.
   La primera vez Google pide autorizar el script (es de ustedes, aceptar).
   En el registro tiene que decir `✓ Conexión OK con Supabase`.

## 3. Subir el histórico (una sola vez)

Elegir la función **`sincronizarTodoElHistorico`** y **Ejecutar**.
Sube las ~450 filas que ya están cargadas, con su etapa, estado, calidad, responsable
y comentarios. Es seguro repetirlo: lo que ya está no se duplica ni se pisa.

## 4. Dejarlo automático

Elegir la función **`instalarDisparador`** y **Ejecutar**.
Desde ahí corre solo cada 10 minutos. Para ver cómo viene: en el menú de la izquierda,
**Ejecuciones**.

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

La hoja **Brochure** entra con `fuente = brochure` y el resto igual; la hoja
**Landing Meta** entra con origen `Meta`. Cualquier columna que no esté en esta tabla
igual se guarda completa en el campo `raw`, así que nunca se pierde nada.

## Si cambian las columnas del Sheet

El script busca las columnas **por nombre de encabezado**, sin importar el orden, ni
mayúsculas, ni acentos. Si le cambian el nombre a una columna, agregar el nombre nuevo
a la lista `ALIAS` arriba de todo del script. Si agregan una hoja nueva, sumarla al
array `HOJAS`.

## Preguntas frecuentes

**¿Qué pasa si alguien edita una fila vieja en el Sheet?**
No vuelve al CRM. Una vez adentro, el registro se trabaja desde el CRM — si no, dos
personas editando en dos lados se pisan. Por eso la idea es que la gestión (etapa,
responsable, notas) pase a hacerse en la pestaña Prospectos.

**¿Y si borro la marca de la columna CRM?**
Esa fila se vuelve a mandar en la próxima corrida. Como la base deduplica por Entry ID,
no se crea un duplicado: sólo se vuelve a marcar.

**¿Se puede apagar?**
Sí: Apps Script → **Disparadores** → borrar el de `sincronizarProspectos`.
