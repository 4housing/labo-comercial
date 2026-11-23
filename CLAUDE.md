# labo-comercial — Contexto del proyecto

CRM y cotizador de la línea **LABO** de 4housing. Parte del portal unificado.

## Stack

- **Frontend:** un solo `index.html` (HTML/CSS/JS vanilla). Acceso a datos por **REST crudo**
  (wrappers propios, no query builder). Renombrar tablas = buscar strings de URL.
- **Hosting:** GitHub Pages, org `4housing`, repo `labo-comercial`. URL: https://4housing.github.io/labo-comercial/
- **Backend:** Supabase unificado → proyecto `wcpkpwxhqdcdljfwzcmy` (wcpk). Login Microsoft (Azure).
- **PDFs:** se guardan en SharePoint vía Microsoft Graph (MSAL), no en Supabase.

## Datos y acceso

- Tablas con prefijo **`labocomercial_`** (`labocomercial_leads`, `labocomercial_counters`,
  `labocomercial_contactos_web`) + vista de agencia + RPCs `labocomercial_next_counter` /
  `ingest_contacto_web`. RLS por sector `labocomercial`.
- **Acceso (fase 2, nov 2026):** al entrar, la app pregunta `labocomercial_mi_acceso()`:
  `interno` = sector `labocomercial` en el panel de Usuarios (o dirección); `externo` = está en
  `labocomercial_cotizadores_externos` (lista explícita, la maneja dirección); `ninguno` = afuera.
- **Vendedor externo:** entra por email/contraseña, solo cotizador. **Nunca recibe costos:**
  cotiza con `labocomercial_lista_precios` (precios de venta que genera el mismo motor y publica
  la app cuando un editor de LABO abre el cotizador o guarda costos). Registra su cotización
  vía política INSERT-only en leads.
- **Maestro de costos:** solo en `labocomercial_costos_versiones` (RLS: sector LABO). NO volver a
  embeberlo en `index.html` ni subir JSON de costos al repo (es público).

## Reglas de trabajo — NO NEGOCIABLES

> **Criterio, no candado.** Estas reglas son el default. Se pueden saltar si el dueño
> de la decisión (Pablo) lo resuelve explícitamente — pero Claude debe **advertir ANTES**,
> con claridad, que la acción incumple tal regla y qué riesgo tiene, y esperar el OK.
> Claude nunca rompe una regla por su cuenta ni en silencio.

1. **No romper lo que ya funciona.** Preferí agregar antes que modificar; `grep` de los
   usos antes de tocar código compartido; probá lo que tocaste, no solo lo que agregaste.
2. **SQL nunca se ejecuta solo.** Se entrega como `.sql` y lo corre una persona a mano en Supabase.
3. **Orden de deploy:** primero el SQL (si agrega tablas/columnas), después el HTML.
4. **RLS siempre `authenticated`, nunca `anon`** + compuerta de sector (`tiene_sector('...')`).
5. **Secretos nunca en `index.html`** (público). anon/publishable es pública; tokens/service keys no.
6. **Validá el JS con `node --check`** antes de terminar.
7. **Cambios incrementales y aditivos:** una feature por PR, chico y reversible.
8. **Decisiones estructurales se cierran antes de codear.**
9. **Git:** `git pull` antes; ramas por feature + PR o coordinar; commits chicos, en español;
   tras `stash pop`/merge chequeá marcadores de conflicto (`<<<<<<<`) antes de commitear.
10. **Prefijos de tabla por sector:** `labocomercial_` acá; resto `fhcomercial_`, `diseno_`,
    `planificacion_`, `compras_`, `eerr_`, `logistica_`. `core_` reservado.
11. **Datos de negocio nunca al repo público** (dumps `.sql` gitignoreados).
12. **Diagnosticar con evidencia** (`grep`/`diff`), no adivinar. Reportar con fidelidad.

## Cómo entregar
- HTML/JS: archivo completo, validado con `node --check`. SQL: archivo `.sql` aparte, corrido a mano.
