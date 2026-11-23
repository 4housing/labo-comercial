-- ============================================================================
-- LABO — Fase 1 · Acceso por SECTOR (panel de Usuarios), no por dominio de mail
-- ============================================================================
-- Correr A MANO en el SQL Editor de Supabase (proyecto unificado wcpk…).
-- Orden: PASO 0 (solo lectura) → revisar → PASO 1 (cambio) → PASO 2 (verificación).
-- Idempotente: re-correrlo deja el mismo resultado. Rollback al final.
--
-- PROBLEMA
--   · 6 tablas de LABO (prospectos, bot y crédito) se leían/editaban por dominio:
--     cualquier cuenta @4housing.com.ar, tuviera o no el sector labocomercial.
--   · labocomercial_costos_versiones (historial del maestro de costos; la ÚLTIMA
--     versión es la que carga el cotizador de todos) aceptaba INSERT de CUALQUIER
--     usuario logueado, incluido el vendedor externo: podía cambiar los precios
--     de todo el equipo.
--
-- CAMBIO
--   · Ver   → tiene_sector('labocomercial')         (sector en el panel; dirección siempre)
--   · Editar→ puede_editar_sector('labocomercial')  (sector y cargo distinto de lector)
--   · Se mantienen los MISMOS nombres de política (rollback directo).
--   · costos_versiones: SOLO cambia el INSERT. La lectura queda como está porque
--     el cotizador del vendedor externo la necesita para calcular precios
--     (eso se resuelve en la Fase 2: precio calculado en el servidor).
--
-- POR QUÉ ES SEGURO (lección del incidente 2026-11-22)
--   · Estas 7 tablas NO tienen políticas RESTRICTIVE (verificado en pg_policies
--     el 2026-11-23): todas son PERMISSIVE. Se reemplaza cada una por otra
--     PERMISSIVE equivalente → nadie con el sector se queda sin acceso.
--   · El bot (Edge Function labo-bot) escribe con la service_role key: la RLS no
--     lo afecta.
--   · labocomercial_leads, contadores y el INSERT del vendedor externo (240) NO
--     se tocan: el cotizador externo sigue funcionando igual.
--
-- EFECTO EN USUARIOS
--   · Pierden acceso a prospectos / conversaciones del bot / crédito las cuentas
--     @4housing SIN el sector labocomercial (27 activas al 2026-11-23).
--   · Los lectores de LABO pasan a solo lectura también a nivel base.
--   · Grabar costos queda solo para quien edita LABO (o dirección).
-- ============================================================================


-- ============================================================================
-- PASO 0 · SOLO LECTURA — correr primero y revisar
-- ============================================================================

-- 0.a  Quiénes CONSERVAN el acceso (tienen el sector o son dirección).
--      Si falta alguien que trabaja prospectos/bot/costos, dárselo en el panel
--      de Usuarios ANTES del Paso 1.
select p.email, p.nombre, p.activo,
       case when p.es_direccion then 'direccion' else ps.cargo end as cargo_labo,
       case when p.es_direccion or coalesce(ps.cargo,'') not in ('lector','lectura')
            then 've y edita' else 'solo ve' end as acceso
  from public.perfiles p
  left join public.perfiles_sector ps
         on ps.perfil_id = p.id and ps.sector = 'labocomercial'
 where p.activo and (p.es_direccion or ps.perfil_id is not null)
 order by 5, 1;

-- 0.b  Políticas actuales (deberían ser 13, todas PERMISSIVE).
select tablename, policyname, cmd, permissive
  from pg_policies
 where schemaname = 'public'
   and tablename in ('labocomercial_prospectos','labocomercial_conversaciones',
                     'labocomercial_mensajes','labocomercial_prospecto_credito',
                     'labocomercial_bot_contactos','labocomercial_bot_uso',
                     'labocomercial_costos_versiones')
 order by 1, 2;


-- ============================================================================
-- PASO 1 · CAMBIO (en una transacción: o se aplica todo o nada)
-- ============================================================================
begin;

-- Freno de seguridad: si apareciera alguna política RESTRICTIVE en estas
-- tablas, se aborta todo (reemplazar las permisivas podría dejar a todos sin
-- acceso, como en el incidente 2026-11-22).
do $$
begin
  if exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and permissive <> 'PERMISSIVE'
       and tablename in ('labocomercial_prospectos','labocomercial_conversaciones',
                         'labocomercial_mensajes','labocomercial_prospecto_credito',
                         'labocomercial_bot_contactos','labocomercial_bot_uso',
                         'labocomercial_costos_versiones')
  ) then
    raise exception 'Hay políticas RESTRICTIVE en tablas de LABO: revisar antes de aplicar. No se cambió nada.';
  end if;
end $$;

-- Prospectos ------------------------------------------------------------------
drop policy if exists prospectos_select on public.labocomercial_prospectos;
create policy prospectos_select on public.labocomercial_prospectos
  for select to authenticated
  using (public.tiene_sector('labocomercial'::public.sector_portal));

drop policy if exists prospectos_update on public.labocomercial_prospectos;
create policy prospectos_update on public.labocomercial_prospectos
  for update to authenticated
  using (public.puede_editar_sector('labocomercial'::public.sector_portal))
  with check (public.puede_editar_sector('labocomercial'::public.sector_portal));

drop policy if exists prospectos_insert on public.labocomercial_prospectos;
create policy prospectos_insert on public.labocomercial_prospectos
  for insert to authenticated
  with check (public.puede_editar_sector('labocomercial'::public.sector_portal));

-- Conversaciones del bot -------------------------------------------------------
drop policy if exists conv_select on public.labocomercial_conversaciones;
create policy conv_select on public.labocomercial_conversaciones
  for select to authenticated
  using (public.tiene_sector('labocomercial'::public.sector_portal));

drop policy if exists conv_update on public.labocomercial_conversaciones;
create policy conv_update on public.labocomercial_conversaciones
  for update to authenticated
  using (public.puede_editar_sector('labocomercial'::public.sector_portal))
  with check (public.puede_editar_sector('labocomercial'::public.sector_portal));

-- Mensajes del bot -------------------------------------------------------------
drop policy if exists msg_select on public.labocomercial_mensajes;
create policy msg_select on public.labocomercial_mensajes
  for select to authenticated
  using (public.tiene_sector('labocomercial'::public.sector_portal));

drop policy if exists msg_insert on public.labocomercial_mensajes;
create policy msg_insert on public.labocomercial_mensajes
  for insert to authenticated
  with check (public.puede_editar_sector('labocomercial'::public.sector_portal));

-- Crédito del prospecto --------------------------------------------------------
drop policy if exists credito_select on public.labocomercial_prospecto_credito;
create policy credito_select on public.labocomercial_prospecto_credito
  for select to authenticated
  using (public.tiene_sector('labocomercial'::public.sector_portal));

drop policy if exists credito_update on public.labocomercial_prospecto_credito;
create policy credito_update on public.labocomercial_prospecto_credito
  for update to authenticated
  using (public.puede_editar_sector('labocomercial'::public.sector_portal))
  with check (public.puede_editar_sector('labocomercial'::public.sector_portal));

-- Contactos y uso del bot (solo lectura para el equipo) ------------------------
drop policy if exists bot_contactos_select on public.labocomercial_bot_contactos;
create policy bot_contactos_select on public.labocomercial_bot_contactos
  for select to authenticated
  using (public.tiene_sector('labocomercial'::public.sector_portal));

drop policy if exists bot_uso_select on public.labocomercial_bot_uso;
create policy bot_uso_select on public.labocomercial_bot_uso
  for select to authenticated
  using (public.tiene_sector('labocomercial'::public.sector_portal));

-- Maestro de costos: grabar versiones solo quien edita LABO --------------------
-- (costos_versiones_select NO se toca: el cotizador del vendedor externo la lee.)
drop policy if exists costos_versiones_insert on public.labocomercial_costos_versiones;
create policy costos_versiones_insert on public.labocomercial_costos_versiones
  for insert to authenticated
  with check (public.puede_editar_sector('labocomercial'::public.sector_portal));

commit;


-- ============================================================================
-- PASO 2 · VERIFICACIÓN (solo lectura)
-- ============================================================================
-- Debe listar las 13 políticas, todas PERMISSIVE y para {authenticated}, y
-- ninguna condición con '@4housing.com.ar'. costos_versiones_select sigue en 'true'.
select tablename, policyname, cmd, permissive, roles::text,
       coalesce(qual, '') as using_, coalesce(with_check, '') as with_check_
  from pg_policies
 where schemaname = 'public'
   and tablename in ('labocomercial_prospectos','labocomercial_conversaciones',
                     'labocomercial_mensajes','labocomercial_prospecto_credito',
                     'labocomercial_bot_contactos','labocomercial_bot_uso',
                     'labocomercial_costos_versiones')
 order by 1, 2;
-- Prueba en la app: (1) alguien con el sector ve Prospectos y Conversaciones;
-- (2) alguien @4housing sin el sector ya no los ve; (3) guardar una versión de
-- costos funciona para un editor de LABO; (4) el vendedor externo sigue cotizando.


-- ============================================================================
-- ROLLBACK (solo si hiciera falta volver atrás) — deja exactamente lo anterior
-- ============================================================================
-- begin;
-- drop policy if exists prospectos_select on public.labocomercial_prospectos;
-- create policy prospectos_select on public.labocomercial_prospectos for select to authenticated
--   using (lower(coalesce(auth.jwt() ->> 'email','')) like '%@4housing.com.ar');
-- drop policy if exists prospectos_update on public.labocomercial_prospectos;
-- create policy prospectos_update on public.labocomercial_prospectos for update to authenticated
--   using (lower(coalesce(auth.jwt() ->> 'email','')) like '%@4housing.com.ar')
--   with check (lower(coalesce(auth.jwt() ->> 'email','')) like '%@4housing.com.ar');
-- drop policy if exists prospectos_insert on public.labocomercial_prospectos;
-- create policy prospectos_insert on public.labocomercial_prospectos for insert to authenticated
--   with check (lower(coalesce(auth.jwt() ->> 'email','')) like '%@4housing.com.ar');
-- drop policy if exists conv_select on public.labocomercial_conversaciones;
-- create policy conv_select on public.labocomercial_conversaciones for select to authenticated
--   using (lower(coalesce(auth.jwt() ->> 'email','')) like '%@4housing.com.ar');
-- drop policy if exists conv_update on public.labocomercial_conversaciones;
-- create policy conv_update on public.labocomercial_conversaciones for update to authenticated
--   using (lower(coalesce(auth.jwt() ->> 'email','')) like '%@4housing.com.ar')
--   with check (lower(coalesce(auth.jwt() ->> 'email','')) like '%@4housing.com.ar');
-- drop policy if exists msg_select on public.labocomercial_mensajes;
-- create policy msg_select on public.labocomercial_mensajes for select to authenticated
--   using (lower(coalesce(auth.jwt() ->> 'email','')) like '%@4housing.com.ar');
-- drop policy if exists msg_insert on public.labocomercial_mensajes;
-- create policy msg_insert on public.labocomercial_mensajes for insert to authenticated
--   with check (lower(coalesce(auth.jwt() ->> 'email','')) like '%@4housing.com.ar');
-- drop policy if exists credito_select on public.labocomercial_prospecto_credito;
-- create policy credito_select on public.labocomercial_prospecto_credito for select to authenticated
--   using (lower(coalesce(auth.jwt() ->> 'email','')) like '%@4housing.com.ar');
-- drop policy if exists credito_update on public.labocomercial_prospecto_credito;
-- create policy credito_update on public.labocomercial_prospecto_credito for update to authenticated
--   using (lower(coalesce(auth.jwt() ->> 'email','')) like '%@4housing.com.ar')
--   with check (lower(coalesce(auth.jwt() ->> 'email','')) like '%@4housing.com.ar');
-- drop policy if exists bot_contactos_select on public.labocomercial_bot_contactos;
-- create policy bot_contactos_select on public.labocomercial_bot_contactos for select to authenticated
--   using (lower(coalesce(auth.jwt() ->> 'email','')) like '%@4housing.com.ar');
-- drop policy if exists bot_uso_select on public.labocomercial_bot_uso;
-- create policy bot_uso_select on public.labocomercial_bot_uso for select to authenticated
--   using (lower(coalesce(auth.jwt() ->> 'email','')) like '%@4housing.com.ar');
-- drop policy if exists costos_versiones_insert on public.labocomercial_costos_versiones;
-- create policy costos_versiones_insert on public.labocomercial_costos_versiones for insert to authenticated
--   with check (true);
-- commit;
