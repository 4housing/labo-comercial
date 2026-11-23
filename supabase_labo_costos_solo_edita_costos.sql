-- ============================================================================
-- LABO — Leer el maestro de costos (y Análisis) solo con "Edita costos"
-- ============================================================================
-- Correr A MANO en el SQL Editor de Supabase, DESPUÉS de publicar el index.html
-- que acompaña este cambio (con ese HTML, quien no tiene el permiso cotiza con
-- la lista de precios y no necesita leer costos). Idempotente. Rollback al final.
--
-- ANTES: labocomercial_costos_versiones la leía todo el sector LABO, así que
-- cualquiera del equipo descargaba el maestro de costos (y veía Análisis:
-- costos y márgenes), aunque la pantalla pidiera contraseña.
-- AHORA: la lee solo quien tiene "Edita costos" en el panel de Usuarios
-- (labocomercial_edita_costos()). El resto del equipo cotiza igual, con la
-- lista de precios de venta (mismos precios).
-- ⚠ Dirección NO lo tiene por ser dirección: hay que tildarlo en el panel.
-- ============================================================================

-- PASO 0 · Solo lectura: quién conserva el acceso a costos.
select p.email, ps.cargo
  from public.perfiles p
  join public.perfiles_sector ps on ps.perfil_id = p.id
 where p.activo and ps.sector = 'labocomercial'
   and coalesce((ps.permisos ->> 'edita_costos')::boolean, false);

-- PASO 1 · Cambio
begin;
do $$
begin
  if not exists (select 1 from public.labocomercial_lista_precios) then
    raise exception 'No hay lista de precios publicada: el equipo se quedaría sin precios. No se cambió nada.';
  end if;
  if not exists (
    select 1 from public.perfiles p
      join public.perfiles_sector ps on ps.perfil_id = p.id
     where p.activo and ps.sector = 'labocomercial'
       and coalesce((ps.permisos ->> 'edita_costos')::boolean, false)
  ) then
    raise exception 'Nadie tiene "Edita costos": nadie podría mantener los costos. No se cambió nada.';
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
  using (public.labocomercial_edita_costos());
commit;

-- PASO 2 · Verificación (solo lectura)
select policyname, cmd, coalesce(qual,'') as using_, coalesce(with_check,'') as with_check_
  from pg_policies
 where schemaname='public' and tablename='labocomercial_costos_versiones'
 order by 1;

-- ROLLBACK (vuelve a "todo el sector LABO")
-- drop policy if exists costos_versiones_select on public.labocomercial_costos_versiones;
-- create policy costos_versiones_select on public.labocomercial_costos_versiones
--   for select to authenticated
--   using (public.tiene_sector('labocomercial'::public.sector_portal));
