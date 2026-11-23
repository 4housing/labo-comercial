-- ============================================================================
-- LABO — Fase 2b · El maestro de costos solo lo lee quien tiene el sector LABO
-- ============================================================================
-- Correr A MANO en el SQL Editor de Supabase, ÚLTIMO de la fase 2:
--   1) supabase_labo_fase2a_externos_y_lista.sql  (ya corrido)
--   2) index.html de la fase 2 publicado (GitHub Pages)
--   3) un editor de LABO abrió el cotizador → se publicó la lista de precios
--   4) ESTE archivo
-- Idempotente. Rollback al final.
--
-- CAMBIO: labocomercial_costos_versiones (historial del maestro de costos:
-- materiales, mano de obra, márgenes, impuestos) deja de ser legible por
-- cualquier usuario logueado. Queda para tiene_sector('labocomercial')
-- (sector en el panel de Usuarios; dirección siempre). El vendedor externo
-- cotiza con labocomercial_lista_precios (solo precios de venta).
-- ============================================================================

-- PASO 0 · Solo lectura: tiene que haber al menos una lista publicada.
-- Si da 0 filas, NO seguir: el cotizador externo se quedaría sin precios.
select id, created_at, creado_por, version_label
  from public.labocomercial_lista_precios
 order by created_at desc
 limit 3;

-- PASO 1 · Cambio
begin;
do $$
begin
  if not exists (select 1 from public.labocomercial_lista_precios) then
    raise exception 'No hay lista de precios publicada: abrir el cotizador con un editor de LABO antes de correr esto. No se cambió nada.';
  end if;
  if exists (select 1 from pg_policies
              where schemaname='public' and tablename='labocomercial_costos_versiones'
                and permissive <> 'PERMISSIVE') then
    raise exception 'Hay políticas RESTRICTIVE en labocomercial_costos_versiones: revisar. No se cambió nada.';
  end if;
end $$;

drop policy if exists costos_versiones_select on public.labocomercial_costos_versiones;
create policy costos_versiones_select on public.labocomercial_costos_versiones
  for select to authenticated
  using (public.tiene_sector('labocomercial'::public.sector_portal));
commit;

-- PASO 2 · Verificación (solo lectura)
select policyname, cmd, permissive, roles::text, coalesce(qual,'') as using_, coalesce(with_check,'') as with_check_
  from pg_policies
 where schemaname='public' and tablename='labocomercial_costos_versiones'
 order by 1;
-- Prueba: el vendedor externo sigue cotizando (lee la lista); un editor de LABO
-- sigue viendo y guardando costos.

-- ROLLBACK
-- drop policy if exists costos_versiones_select on public.labocomercial_costos_versiones;
-- create policy costos_versiones_select on public.labocomercial_costos_versiones
--   for select to authenticated using (true);
