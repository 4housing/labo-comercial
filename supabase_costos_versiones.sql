-- LABO — Historial de versiones de costos (línea Modular)
-- Ejecutar una vez en el proyecto Supabase (SQL Editor).
create table if not exists public.labocomercial_costos_versiones (
  id            bigint generated always as identity primary key,
  created_at    timestamptz not null default now(),
  usuario       text,
  version_label text,
  tc            numeric,
  nota          text,
  source        text,            -- 'app' | 'excel'
  data          jsonb not null   -- snapshot completo del modelo de costos (LABO_DATA)
);

create index if not exists idx_costos_versiones_created
  on public.labocomercial_costos_versiones (created_at desc);

alter table public.labocomercial_costos_versiones enable row level security;

-- Lectura: cualquiera con la anon key (el cotizador necesita leer los costos vigentes)
drop policy if exists costos_versiones_select on public.labocomercial_costos_versiones;
create policy costos_versiones_select
  on public.labocomercial_costos_versiones for select
  using (true);

-- Alta: sólo usuarios autenticados (equipo, login Microsoft/Supabase)
drop policy if exists costos_versiones_insert on public.labocomercial_costos_versiones;
create policy costos_versiones_insert
  on public.labocomercial_costos_versiones for insert
  to authenticated
  with check (true);
