-- ============================================================================
-- LABO — Permiso explícito "Edita costos"
-- ============================================================================
-- Correr A MANO en el SQL Editor de Supabase. Idempotente. Rollback al final.
-- Se puede correr antes o después de publicar el admin.html / index.html que
-- acompañan este cambio (la base es la que decide; las apps solo lo muestran).
--
-- PROBLEMA
--   La contraseña de "Actualizar Costos" es solo de pantalla: la base no la
--   conoce. Cualquier editor de LABO (6 cuentas) podía grabar costos o publicar
--   la lista de precios que usa el vendedor externo, con o sin la contraseña.
--
-- CAMBIO
--   · labocomercial_edita_costos(): true solo si la cuenta puede editar LABO
--     (sector + cargo distinto de lector) Y tiene tildado el permiso
--     "edita_costos" en el panel de Usuarios (perfiles_sector.permisos).
--     NO viene con ser dirección: se tilda a mano.
--   · Grabar versiones de costos, actualizar el autoguardado y publicar la
--     lista de precios pasan a exigir ese permiso.
--   · Leer costos y cotizar NO cambia: el equipo sigue igual.
--   · La contraseña de la pantalla se mantiene (freno adicional).
-- ============================================================================


-- ============================================================================
-- 1 · Función
-- ============================================================================
create or replace function public.labocomercial_edita_costos()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select public.puede_editar_sector('labocomercial'::public.sector_portal)
     and exists (
       select 1
         from public.perfiles p
         join public.perfiles_sector ps on ps.perfil_id = p.id
        where p.id = (select auth.uid())
          and p.activo
          and ps.sector = 'labocomercial'
          and coalesce((ps.permisos ->> 'edita_costos')::boolean, false)
     );
$$;
revoke all on function public.labocomercial_edita_costos() from public, anon;
grant execute on function public.labocomercial_edita_costos() to authenticated;


-- ============================================================================
-- 2 · Dar el permiso a quien hoy mantiene los costos
-- ============================================================================
-- ⚠ Completar el mail A MANO en el SQL Editor. NO commitear mails (repo público).
-- Si la cuenta no tiene todavía la app LABO en el panel, se le agrega.
insert into public.perfiles_sector (perfil_id, sector, cargo, permisos)
select p.id, 'labocomercial'::public.sector_portal, 'admin', '{"edita_costos": true}'::jsonb
  from public.perfiles p
 where lower(p.email) = lower('<MAIL-DE-QUIEN-MANTIENE-LOS-COSTOS>')
on conflict (perfil_id, sector) do update
   set permisos = coalesce(public.perfiles_sector.permisos, '{}'::jsonb) || '{"edita_costos": true}'::jsonb;


-- ============================================================================
-- 3 · Políticas (en una transacción, con frenos)
-- ============================================================================
begin;

do $$
begin
  -- Freno 1: tiene que quedar al menos una cuenta activa con el permiso.
  if not exists (
    select 1 from public.perfiles p
      join public.perfiles_sector ps on ps.perfil_id = p.id
     where p.activo and ps.sector = 'labocomercial'
       and coalesce((ps.permisos ->> 'edita_costos')::boolean, false)
  ) then
    raise exception 'Nadie tiene el permiso edita_costos: completar el paso 2 antes. No se cambió nada.';
  end if;
  -- Freno 2: sin políticas RESTRICTIVE en estas tablas.
  if exists (select 1 from pg_policies
              where schemaname='public'
                and tablename in ('labocomercial_costos_versiones','labocomercial_lista_precios')
                and permissive <> 'PERMISSIVE') then
    raise exception 'Hay políticas RESTRICTIVE en costos/lista: revisar. No se cambió nada.';
  end if;
end $$;

drop policy if exists costos_versiones_insert on public.labocomercial_costos_versiones;
create policy costos_versiones_insert on public.labocomercial_costos_versiones
  for insert to authenticated
  with check (public.labocomercial_edita_costos());

drop policy if exists costos_versiones_update_autoguardado on public.labocomercial_costos_versiones;
create policy costos_versiones_update_autoguardado on public.labocomercial_costos_versiones
  for update to authenticated
  using (public.labocomercial_edita_costos()
         and source = 'app-auto'
         and lower(coalesce(usuario,'')) = lower(coalesce(auth.jwt() ->> 'email','')))
  with check (public.labocomercial_edita_costos()
              and source = 'app-auto'
              and lower(coalesce(usuario,'')) = lower(coalesce(auth.jwt() ->> 'email','')));

drop policy if exists lista_precios_insert on public.labocomercial_lista_precios;
create policy lista_precios_insert on public.labocomercial_lista_precios
  for insert to authenticated
  with check (public.labocomercial_edita_costos());

commit;


-- ============================================================================
-- 4 · Verificación (solo lectura)
-- ============================================================================
-- Quién tiene el permiso (debería ser solo quien se cargó en el paso 2).
select p.email, p.activo, ps.cargo, ps.permisos ->> 'edita_costos' as edita_costos
  from public.perfiles p
  join public.perfiles_sector ps on ps.perfil_id = p.id
 where ps.sector = 'labocomercial'
   and coalesce((ps.permisos ->> 'edita_costos')::boolean, false);
select tablename, policyname, cmd, coalesce(qual,'') as using_, coalesce(with_check,'') as with_check_
  from pg_policies
 where schemaname='public' and tablename in ('labocomercial_costos_versiones','labocomercial_lista_precios')
 order by 1, 2;


-- ============================================================================
-- ROLLBACK (vuelve a "cualquier editor de LABO"; el permiso tildado queda guardado, sin efecto)
-- ============================================================================
-- begin;
-- drop policy if exists costos_versiones_insert on public.labocomercial_costos_versiones;
-- create policy costos_versiones_insert on public.labocomercial_costos_versiones
--   for insert to authenticated
--   with check (public.puede_editar_sector('labocomercial'::public.sector_portal));
-- drop policy if exists costos_versiones_update_autoguardado on public.labocomercial_costos_versiones;
-- create policy costos_versiones_update_autoguardado on public.labocomercial_costos_versiones
--   for update to authenticated
--   using (public.puede_editar_sector('labocomercial'::public.sector_portal)
--          and source = 'app-auto'
--          and lower(coalesce(usuario,'')) = lower(coalesce(auth.jwt() ->> 'email','')))
--   with check (public.puede_editar_sector('labocomercial'::public.sector_portal)
--               and source = 'app-auto'
--               and lower(coalesce(usuario,'')) = lower(coalesce(auth.jwt() ->> 'email','')));
-- drop policy if exists lista_precios_insert on public.labocomercial_lista_precios;
-- create policy lista_precios_insert on public.labocomercial_lista_precios
--   for insert to authenticated
--   with check (public.puede_editar_sector('labocomercial'::public.sector_portal));
-- commit;
