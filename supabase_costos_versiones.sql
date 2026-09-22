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

-- Lectura: sólo usuarios con sesión.
--
-- Esta política era "using (true)" sin rol, o sea PUBLIC, o sea que cualquiera con
-- la clave pública del proyecto —que va escrita en el HTML de varias apps— podía
-- leer toda la estructura de costos: materiales, mano de obra, márgenes y precios
-- de proveedores. Era la única tabla del proyecto abierta de esa forma.
--
-- El cotizador lee los costos desde initApp(), que corre después del login (tanto
-- para el equipo como para los vendedores externos), así que exigir sesión no le
-- quita nada a nadie.
drop policy if exists costos_versiones_select on public.labocomercial_costos_versiones;
create policy costos_versiones_select
  on public.labocomercial_costos_versiones for select
  to authenticated
  using (true);

-- Alta: sólo usuarios autenticados (equipo, login Microsoft/Supabase)
drop policy if exists costos_versiones_insert on public.labocomercial_costos_versiones;
create policy costos_versiones_insert
  on public.labocomercial_costos_versiones for insert
  to authenticated
  with check (true);
