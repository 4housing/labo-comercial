-- LABO — Ajustes para que el Google Sheet cargue prospectos sin guardar secretos
-- Ejecutar DESPUÉS de supabase_prospectos.sql. Es idempotente: se puede repetir.
--
-- Contexto
-- --------
-- El Google Sheet lo administra un proveedor externo, y cualquiera con acceso de
-- edición puede abrir el editor de Apps Script y leer lo que el script tenga
-- guardado. Por eso el script NO puede guardar la service_role key: esa clave
-- saltea RLS y da control total del proyecto (pipeline, costos, usuarios).
--
-- Solución: el script no guarda ningún secreto. Entra con la clave pública (anon),
-- la misma que ya viaja en el HTML del CRM, y la base le permite UNA sola cosa:
-- insertar prospectos. No puede leer nada — ni los prospectos que carga —, ni
-- modificar, ni borrar.
--
-- Qué se expone con esto: alguien que encuentre la clave pública podría cargar
-- prospectos basura en la bandeja. Es visible, se borra, y se corta en el acto
-- eliminando la política del punto 2. No puede leer ni tocar ningún dato.

-- ── 1) Arreglo del índice de deduplicación ───────────────────────────────────
-- La primera versión creaba este índice como PARCIAL ("where entry_id is not
-- null"). Postgres no acepta un índice parcial como árbitro de "ON CONFLICT DO
-- NOTHING", que es lo que usan el script y el importador de CSV para no duplicar:
-- con el índice parcial, la primera fila repetida hace fallar el lote entero con
-- un 409. Se nota al reenviar el histórico o al resincronizar una hoja.
drop index if exists public.idx_prospectos_dedup;
create unique index if not exists idx_prospectos_dedup
  on public.labocomercial_prospectos (fuente, entry_id);

-- ── 2) Permiso de carga para el Sheet ────────────────────────────────────────
-- Dos capas, y hacen falta las dos: el permiso de tabla (grant) y la política de
-- RLS. Supabase suele dar el grant por defecto, pero si por algún motivo no está,
-- la política sola no alcanza y la carga falla con "permission denied".
grant insert on public.labocomercial_prospectos to anon;
grant select on public.labocomercial_prospectos to anon;   -- sin política de select,
-- RLS igual no devuelve ni una fila: este grant sólo permite que una consulta
-- responda "200 con lista vacía" en vez de un error, que es lo que usa el Sheet
-- como prueba de vida.

-- Insertar, y nada más. No hay política de select, update ni delete para anon,
-- ni en esta tabla ni en ninguna otra: sin política, RLS niega por defecto.
drop policy if exists prospectos_insert_sheet on public.labocomercial_prospectos;
create policy prospectos_insert_sheet
  on public.labocomercial_prospectos for insert
  to anon
  with check (fuente in ('formulario', 'brochure', 'landing_meta'));

-- Para cortar la carga desde el Sheet en cualquier momento, sin tocar el Sheet:
--   drop policy prospectos_insert_sheet on public.labocomercial_prospectos;
-- El CRM y el equipo no se ven afectados.

-- Para revisar qué puede hacer cada quién sobre los prospectos:
--   select policyname, cmd, roles, qual, with_check
--     from pg_policies
--    where schemaname = 'public' and tablename = 'labocomercial_prospectos'
--    order by policyname;
