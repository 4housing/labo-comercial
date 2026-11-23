-- ============================================================================
-- LABO — Autoguardado del maestro de costos
-- ============================================================================
-- Correr A MANO en el SQL Editor de Supabase, ANTES de publicar el index.html
-- que acompaña este cambio. Idempotente. Rollback al final.
--
-- PROBLEMA
--   El editor de costos autoguarda: la primera vez inserta una fila
--   (source = 'app-auto') y los cambios siguientes la ACTUALIZAN (PATCH).
--   labocomercial_costos_versiones no tenía ninguna política de UPDATE, así que
--   esos PATCH afectaban 0 filas y Supabase respondía OK igual: la app mostraba
--   "✓ Autoguardado" sin haber guardado nada después del primer cambio.
--
-- CAMBIO
--   · Nueva política de UPDATE, acotada: solo editores de LABO
--     (puede_editar_sector), solo filas de autoguardado (source = 'app-auto') y
--     solo las propias (usuario = mail de la sesión). Las versiones guardadas a
--     propósito ("Guardar versión", 'app' / 'excel' / 'migracion') no se pueden
--     modificar: el historial queda intacto.
--   · Se le quitan a anon los permisos de tabla (la RLS ya lo bloqueaba; es
--     prolijidad, regla "RLS siempre authenticated, nunca anon").
-- ============================================================================

begin;

do $$
begin
  if exists (select 1 from pg_policies
              where schemaname='public' and tablename='labocomercial_costos_versiones'
                and permissive <> 'PERMISSIVE') then
    raise exception 'Hay políticas RESTRICTIVE en labocomercial_costos_versiones: revisar. No se cambió nada.';
  end if;
end $$;

drop policy if exists costos_versiones_update_autoguardado on public.labocomercial_costos_versiones;
create policy costos_versiones_update_autoguardado on public.labocomercial_costos_versiones
  for update to authenticated
  using (public.puede_editar_sector('labocomercial'::public.sector_portal)
         and source = 'app-auto'
         and lower(coalesce(usuario,'')) = lower(coalesce(auth.jwt() ->> 'email','')))
  with check (public.puede_editar_sector('labocomercial'::public.sector_portal)
              and source = 'app-auto'
              and lower(coalesce(usuario,'')) = lower(coalesce(auth.jwt() ->> 'email','')));

revoke all on public.labocomercial_costos_versiones from anon;

commit;

-- Verificación (solo lectura): 3 políticas (insert, select, update_autoguardado)
-- y anon sin privilegios.
select policyname, cmd, permissive, roles::text, coalesce(qual,'') as using_, coalesce(with_check,'') as with_check_
  from pg_policies
 where schemaname='public' and tablename='labocomercial_costos_versiones'
 order by 1;
select grantee, string_agg(privilege_type, ',' order by privilege_type) as privilegios
  from information_schema.role_table_grants
 where table_schema='public' and table_name='labocomercial_costos_versiones'
   and grantee in ('anon','authenticated')
 group by grantee;

-- ROLLBACK
-- drop policy if exists costos_versiones_update_autoguardado on public.labocomercial_costos_versiones;
-- grant select, insert, update, delete, truncate, references, trigger
--   on public.labocomercial_costos_versiones to anon;
