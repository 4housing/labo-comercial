-- ============================================================================
-- LABO — Fase 2a · Cotizador externo explícito + lista de precios de venta
-- ============================================================================
-- Correr A MANO en el SQL Editor de Supabase (proyecto unificado wcpk…),
-- ANTES de publicar el index.html de la fase 2. Idempotente. Rollback al final.
-- Es ADITIVO: no le quita nada a nadie todavía (eso lo hace la fase 2b).
--
-- QUÉ AGREGA
--   1) labocomercial_cotizadores_externos: lista EXPLÍCITA de vendedores externos
--      (hoy uno). Solo dirección la ve y la edita. Antes, la app trataba como
--      "externo" a CUALQUIER cuenta que no fuera @4housing.
--   2) labocomercial_es_cotizador_externo() y labocomercial_mi_acceso():
--      la app pregunta al entrar si la cuenta es 'interno' (sector LABO en el
--      panel, o dirección), 'externo' (está en la lista) o 'ninguno' (sin acceso).
--   3) labocomercial_lista_precios: PRECIOS DE VENTA ya calculados (sin costos,
--      márgenes ni impuestos). La publica la app cuando un editor de LABO abre el
--      cotizador o guarda una versión de costos. El externo cotiza leyendo solo esto.
--   4) Registrar cotización (INSERT en labocomercial_leads) y pedir número
--      (labocomercial_next_counter): solo internos con sector o externos de la lista.
--      Antes: cualquier usuario logueado.
--
-- NO TOCA: las políticas de lectura/edición del CRM (tiene_sector, 061/065), ni
-- labocomercial_costos_versiones (eso es la fase 2b, después del HTML).
-- ============================================================================


-- ============================================================================
-- 1 · Lista de cotizadores externos
-- ============================================================================
create table if not exists public.labocomercial_cotizadores_externos (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  email      text not null,
  activo     boolean not null default true,
  creado_en  timestamptz not null default now()
);
alter table public.labocomercial_cotizadores_externos enable row level security;
revoke all on public.labocomercial_cotizadores_externos from anon;
grant select, insert, update, delete on public.labocomercial_cotizadores_externos to authenticated;

drop policy if exists cotizadores_externos_direccion on public.labocomercial_cotizadores_externos;
create policy cotizadores_externos_direccion on public.labocomercial_cotizadores_externos
  for all to authenticated
  using (public.es_direccion())
  with check (public.es_direccion());


-- ============================================================================
-- 2 · Helpers de acceso
-- ============================================================================
create or replace function public.labocomercial_es_cotizador_externo()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.labocomercial_cotizadores_externos e
     where e.user_id = (select auth.uid()) and e.activo
  );
$$;
revoke all on function public.labocomercial_es_cotizador_externo() from public, anon;
grant execute on function public.labocomercial_es_cotizador_externo() to authenticated;

create or replace function public.labocomercial_mi_acceso()
returns text
language sql stable security definer
set search_path = public
as $$
  select case
    when public.tiene_sector('labocomercial'::public.sector_portal) then 'interno'
    when public.labocomercial_es_cotizador_externo()                then 'externo'
    else 'ninguno'
  end;
$$;
revoke all on function public.labocomercial_mi_acceso() from public, anon;
grant execute on function public.labocomercial_mi_acceso() to authenticated;


-- ============================================================================
-- 3 · Lista de precios de venta (la publica la app; la lee el cotizador)
-- ============================================================================
create table if not exists public.labocomercial_lista_precios (
  id            bigint generated always as identity primary key,
  created_at    timestamptz not null default now(),
  creado_por    text,
  version_label text,
  data          jsonb not null   -- precios de VENTA por modelo/configuración/opcional (sin costos)
);
create index if not exists idx_lista_precios_created
  on public.labocomercial_lista_precios (created_at desc);

alter table public.labocomercial_lista_precios enable row level security;
revoke all on public.labocomercial_lista_precios from anon;
grant select, insert on public.labocomercial_lista_precios to authenticated;

drop policy if exists lista_precios_select on public.labocomercial_lista_precios;
create policy lista_precios_select on public.labocomercial_lista_precios
  for select to authenticated
  using (public.tiene_sector('labocomercial'::public.sector_portal)
         or public.labocomercial_es_cotizador_externo());

drop policy if exists lista_precios_insert on public.labocomercial_lista_precios;
create policy lista_precios_insert on public.labocomercial_lista_precios
  for insert to authenticated
  with check (public.puede_editar_sector('labocomercial'::public.sector_portal));


-- ============================================================================
-- 4 · Registrar cotización y pedir número: solo quien corresponde
-- ============================================================================
-- labocomercial_leads: la política extra de alta (240) pasaba "with check (true)".
-- Los internos siguen entrando por labocomercial_leads_all (tiene_sector).
drop policy if exists labocomercial_leads_insert_externos on public.labocomercial_leads;
create policy labocomercial_leads_insert_externos on public.labocomercial_leads
  for insert to authenticated
  with check (public.labocomercial_es_cotizador_externo());

-- Contador: misma firma y mismo resultado que en 240, con control de acceso.
create or replace function public.labocomercial_next_counter(counter_name text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare v integer;
begin
  if not (public.tiene_sector('labocomercial'::public.sector_portal)
          or public.labocomercial_es_cotizador_externo()) then
    raise exception 'sin acceso a LABO' using errcode = '42501';
  end if;
  update public.labocomercial_counters
     set value = value + 1
   where name = counter_name
  returning value into v;
  return v;
end;
$$;
revoke all on function public.labocomercial_next_counter(text) from public, anon;
grant execute on function public.labocomercial_next_counter(text) to authenticated, service_role;


-- ============================================================================
-- 5 · Alta del vendedor externo
-- ============================================================================
-- ⚠ Completar el mail A MANO en el SQL Editor. NO commitear mails (repo público).
-- La cuenta tiene que existir en Authentication → Users.
insert into public.labocomercial_cotizadores_externos (user_id, email)
select u.id, lower(u.email)
  from auth.users u
 where lower(u.email) = lower('<MAIL-DEL-VENDEDOR-EXTERNO>')
on conflict (user_id) do update set activo = true, email = excluded.email;


-- ============================================================================
-- 6 · Verificación (solo lectura)
-- ============================================================================
-- Debe listar al vendedor externo (1 fila, activo = true).
select email, activo, creado_en from public.labocomercial_cotizadores_externos;
-- ⚠ Tiene que haber al menos 1 versión de costos guardada: el index.html de la fase 2
-- ya NO trae los costos embebidos y los carga de acá. Si da 0, NO publicar el HTML:
-- primero un editor guarda una versión ("Guardar versión" en Actualizar Costos).
select count(*) as versiones_de_costos, max(created_at) as ultima
  from public.labocomercial_costos_versiones;
-- Políticas nuevas/cambiadas.
select tablename, policyname, cmd, permissive, roles::text,
       coalesce(qual,'') as using_, coalesce(with_check,'') as with_check_
  from pg_policies
 where schemaname = 'public'
   and (tablename in ('labocomercial_cotizadores_externos','labocomercial_lista_precios')
        or policyname = 'labocomercial_leads_insert_externos')
 order by 1, 2;


-- ============================================================================
-- ROLLBACK (deja todo como antes de este archivo)
-- ============================================================================
-- begin;
-- drop policy if exists labocomercial_leads_insert_externos on public.labocomercial_leads;
-- create policy labocomercial_leads_insert_externos on public.labocomercial_leads
--   for insert to authenticated with check (true);
-- create or replace function public.labocomercial_next_counter(counter_name text)
-- returns integer language sql security definer set search_path = public as $f$
--   update public.labocomercial_counters set value = value + 1
--    where name = counter_name returning value;
-- $f$;
-- revoke all on function public.labocomercial_next_counter(text) from public, anon;
-- grant execute on function public.labocomercial_next_counter(text) to authenticated, service_role;
-- drop function if exists public.labocomercial_mi_acceso();
-- drop table if exists public.labocomercial_lista_precios;
-- drop function if exists public.labocomercial_es_cotizador_externo();
-- drop table if exists public.labocomercial_cotizadores_externos;
-- commit;
-- (Si el index.html de la fase 2 ya está publicado, con este rollback la app vuelve
--  sola al comportamiento anterior: si no encuentra labocomercial_mi_acceso ni la
--  lista de precios, usa la lógica vieja.)
