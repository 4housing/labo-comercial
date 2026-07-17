-- ═══════════════════════════════════════════════════════════════════════════
-- Contactos Web — leads de la campaña de Google Ads cargados por la agencia
-- ═══════════════════════════════════════════════════════════════════════════
-- Correr una sola vez en el SQL Editor de Supabase (proyecto rhajlvmneyvgqlyeyjsd,
-- el mismo que usa labo para labo_leads). Este script:
--   1) Crea la tabla labo_contactos_web.
--   2) Da acceso total a usuarios autenticados (equipo interno de labo).
--   3) Crea una función RPC que el Apps Script de la agencia usa para AGREGAR
--      contactos nuevos — nunca puede leer ni modificar los que ya existen.
--   4) Crea una vista pública acotada (sin nombre/teléfono/email) para que el
--      mismo Apps Script lea etapa/estado/calidad/comentarios y los escriba de
--      vuelta en la planilla de la agencia.
--
-- Si las políticas de labo_leads en tu proyecto son distintas a "authenticated
-- con acceso total", ajustá la policy de más abajo para que coincida.

create table if not exists public.labo_contactos_web (
  id uuid primary key default gen_random_uuid(),
  entry_id text unique not null,
  fecha date,
  nombre text,
  telefono text,
  email text,
  modelo text,
  tipo_proyecto text,
  comentario_form text,          -- mensaje que dejó el lead en el formulario web
  url text,                      -- link a su cotización online
  etapa text not null default '1er contacto',
  estado text not null default 'En curso',
  calidad text,
  comentarios jsonb not null default '[]'::jsonb,  -- [{fecha, texto}, ...]
  lead_id text,                  -- id del lead en labo_leads, si se convirtió en oportunidad
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_labo_contactos_web_entry_id on public.labo_contactos_web(entry_id);

alter table public.labo_contactos_web enable row level security;

drop policy if exists "authenticated_full_access" on public.labo_contactos_web;
create policy "authenticated_full_access" on public.labo_contactos_web
  for all
  to authenticated
  using (true)
  with check (true);

-- ── Ingesta (Sheet → labo): solo agrega, nunca pisa lo que ya está cargado ──────
create or replace function public.ingest_contacto_web(
  p_entry_id text,
  p_fecha date,
  p_nombre text,
  p_telefono text,
  p_email text,
  p_modelo text,
  p_tipo_proyecto text,
  p_comentario_form text,
  p_url text
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.labo_contactos_web
    (entry_id, fecha, nombre, telefono, email, modelo, tipo_proyecto, comentario_form, url)
  values
    (p_entry_id, p_fecha, p_nombre, p_telefono, p_email, p_modelo, p_tipo_proyecto, p_comentario_form, p_url)
  on conflict (entry_id) do nothing;
end;
$$;

grant execute on function public.ingest_contacto_web(
  text, date, text, text, text, text, text, text, text
) to anon;

-- ── Devolución de estado (labo → Sheet): solo lo que necesita ver la agencia ────
create or replace view public.contactos_web_agencia as
  select entry_id, etapa, estado, calidad, comentarios
  from public.labo_contactos_web;

grant select on public.contactos_web_agencia to anon;
