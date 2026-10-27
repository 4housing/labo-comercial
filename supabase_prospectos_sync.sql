-- LABO — Carga de prospectos desde el Google Sheet, sin secretos y sin lectura
-- Ejecutar DESPUÉS de supabase_prospectos.sql. Es idempotente: se puede repetir.
--
-- Contexto
-- --------
-- El Google Sheet lo administra un proveedor externo, y cualquiera con acceso de
-- edición puede abrir el editor de Apps Script y leer lo que el script tenga
-- guardado. Por eso el script NO puede guardar la service_role key: esa clave
-- saltea RLS y da control total del proyecto (pipeline, costos, usuarios).
--
-- Solución: el script no guarda ningún secreto. Entra con la clave pública (anon)
-- y la base le deja UNA sola puerta: la función labocomercial_prospectos_ingest.
-- No tiene permisos sobre la tabla — ni insert, ni select, ni update, ni delete.
--
-- Por qué una función y no una política de insert (incidente del 23/09/2026)
-- -------------------------------------------------------------------------
-- La primera versión le daba al rol anónimo permiso de INSERT sobre la tabla, con
-- una política de RLS que sólo aceptaba las fuentes conocidas. Andaba en las
-- pruebas y fallaba con datos reales, siempre con el mismo error:
--
--   42501: new row violates row-level security policy for table
--          "labocomercial_prospectos"
--
-- La causa: el script inserta con "ON CONFLICT DO NOTHING" para no duplicar, y
-- para resolver ese conflicto Postgres necesita poder LEER la fila que ya existe.
-- El rol anónimo no tiene lectura sobre prospectos (a propósito: no queremos que
-- el Sheet pueda listar los leads), así que el insert entero rebotaba. Insert y
-- deduplicación por separado funcionan; juntos, con un rol sin lectura, no.
--
-- No se resuelve dándole lectura al Sheet. Se resuelve moviendo la carga adentro
-- de una función SECURITY DEFINER: la deduplicación ocurre del lado de la base,
-- con los permisos del dueño de la tabla, y el Sheet nunca toca la tabla.
--
-- Qué se expone con esto: alguien que encuentre la clave pública podría llamar a
-- la función y cargar prospectos basura en la bandeja. Son visibles, se borran, y
-- se corta en el acto revocando el execute del punto 3. No puede leer ni tocar
-- ningún dato existente.

-- ── 1) Índice de deduplicación ───────────────────────────────────────────────
-- El índice NO puede ser parcial (un "where entry_id is not null"): Postgres sólo
-- acepta como árbitro de "ON CONFLICT DO NOTHING" a un índice único completo.
drop index if exists public.idx_prospectos_dedup;
create unique index if not exists idx_prospectos_dedup
  on public.labocomercial_prospectos (fuente, entry_id);

-- ── 2) La puerta de entrada del Sheet ────────────────────────────────────────
-- Recibe el lote completo como un arreglo JSON y devuelve cuántas filas entraron
-- (las repetidas no cuentan: ya estaban). Valida la fuente antes de tocar nada.
create or replace function public.labocomercial_prospectos_ingest(filas jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  insertadas integer;
begin
  if filas is null or jsonb_typeof(filas) <> 'array' then
    raise exception 'Se esperaba un arreglo de filas en el parámetro "filas".';
  end if;

  if jsonb_array_length(filas) = 0 then
    return 0;                      -- lote vacío: es la prueba de conexión del menú
  end if;

  if jsonb_array_length(filas) > 500 then
    raise exception 'Máximo 500 filas por envío (llegaron %).', jsonb_array_length(filas);
  end if;

  -- Una fila con una fuente desconocida corta el envío en vez de entrar de
  -- contrabando o desaparecer en silencio: si mañana se agrega una hoja al script,
  -- el error avisa que hay que habilitarla acá.
  if exists (
    select 1 from jsonb_array_elements(filas) f
     where coalesce(f ->> 'fuente', '') not in ('formulario', 'brochure', 'landing_meta')
  ) then
    raise exception 'Hay filas con una fuente no permitida. Fuentes válidas: formulario, brochure, landing_meta.';
  end if;

  with datos as (
    select * from jsonb_to_recordset(filas) as x(
      fuente            text,
      entry_id          text,
      origen            text,
      campania          text,
      fecha             timestamptz,
      url               text,
      nombre            text,
      email             text,
      telefono          text,
      region            text,
      modelo            text,
      tipo_proyecto     text,
      comentario        text,
      etapa             text,
      contactos         integer,
      calidad           text,
      responsable       text,
      notas             text,
      descargo_brochure boolean,
      raw               jsonb
    )
  ), ins as (
    insert into public.labocomercial_prospectos (
      fuente, entry_id, origen, campania, fecha, url, nombre, email, telefono,
      region, modelo, tipo_proyecto, comentario, etapa, contactos, calidad,
      responsable, notas, descargo_brochure, raw
    )
    select
      fuente, entry_id, origen, campania, fecha, url, nombre, email, telefono,
      region, modelo, tipo_proyecto, comentario,
      coalesce(etapa, 'Nuevo'), coalesce(contactos, 0), calidad,
      responsable, notas, coalesce(descargo_brochure, false), raw
      from datos
    -- Acá sí funciona la deduplicación: la función corre con los permisos de su
    -- dueño, que puede leer la tabla para resolver el conflicto.
    on conflict (fuente, entry_id) do nothing
    returning 1
  )
  select count(*) into insertadas from ins;

  return insertadas;
end $$;

-- ── 3) Permisos: sólo la función, y nada más ─────────────────────────────────
-- Se revoca todo lo que la versión anterior le había dado al rol anónimo sobre la
-- tabla. Si este archivo se corre sobre una base que nunca tuvo esos permisos, los
-- revoke no hacen nada.
drop policy if exists prospectos_insert_sheet on public.labocomercial_prospectos;
revoke all on public.labocomercial_prospectos from anon;

revoke all on function public.labocomercial_prospectos_ingest(jsonb) from public;
grant execute on function public.labocomercial_prospectos_ingest(jsonb) to anon;
grant execute on function public.labocomercial_prospectos_ingest(jsonb) to authenticated;

-- Para cortar la carga desde el Sheet en cualquier momento, sin tocar el Sheet:
--   revoke execute on function public.labocomercial_prospectos_ingest(jsonb) from anon;
-- El CRM y el equipo no se ven afectados.

-- Para revisar qué puede hacer cada quién sobre los prospectos:
--   select policyname, cmd, permissive, roles::text, with_check
--     from pg_policies
--    where schemaname = 'public' and tablename = 'labocomercial_prospectos'
--    order by policyname;
--
--   select grantee, privilege_type
--     from information_schema.role_table_grants
--    where table_schema = 'public' and table_name = 'labocomercial_prospectos'
--    order by grantee, privilege_type;
