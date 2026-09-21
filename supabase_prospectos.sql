-- LABO — Prospectos (leads de marketing: Google Ads / Meta → Google Sheet → CRM)
-- Ejecutar una vez en el proyecto Supabase (SQL Editor).
--
-- Esta tabla es la BANDEJA DE ENTRADA comercial: todo lo que hoy se trabaja a mano
-- en el Google Sheet "Envíos Formularios - Labo Modular". Es intencionalmente
-- distinta de labocomercial_leads: ahí un registro nace recién cuando existe una
-- cotización. Cuando un prospecto se cotiza, queda enlazado por lead_id y se marca
-- etapa='Convertido' (ver convertirProspecto() en index.html).

create table if not exists public.labocomercial_prospectos (
  id            bigint generated always as identity primary key,

  -- ── Origen (lo que llega del formulario / la campaña) ──────────────────────
  fuente        text not null,                   -- 'formulario' | 'brochure' | 'landing_meta'
  entry_id      text,                            -- "Entry ID" de la hoja (clave de deduplicación)
  origen        text,                            -- 'Google Ads' | 'Meta' | 'Orgánico' | …
  campania      text,
  fecha         timestamptz,                     -- fecha del envío (columna "Fecha")
  url           text,                            -- landing donde completó

  -- ── Datos del contacto ─────────────────────────────────────────────────────
  nombre        text,
  email         text,
  telefono      text,
  region        text,
  modelo        text,                            -- modelo de interés declarado
  tipo_proyecto text,                            -- Vivienda / Hotelería / Otro …
  comentario    text,                            -- "Comentarios adicional" del cliente

  -- ── Gestión comercial (lo que hoy se completa a mano en el Sheet) ──────────
  etapa             text not null default 'Nuevo',  -- Nuevo | Contactado | En seguimiento | Convertido | Descartado
  contactos         int  not null default 0,        -- 1° contacto / 2° contacto → 1 / 2
  calidad           text,                           -- Bueno | Regular | Malo
  responsable       text,                           -- vendedor asignado
  notas             text,
  descargo_brochure boolean not null default false, -- el mismo contacto además bajó el brochure
  actividad         jsonb not null default '[]'::jsonb,

  -- ── Conversión ─────────────────────────────────────────────────────────────
  lead_id       text,                            -- id en labocomercial_leads al cotizar
  convertido_at timestamptz,

  raw           jsonb,                           -- fila original completa (nada se pierde)
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Deduplicación: la misma fila del Sheet nunca entra dos veces, aunque el script
-- de sincronización se ejecute de nuevo sobre filas ya enviadas.
--
-- El índice NO puede ser parcial (un "where entry_id is not null"): Postgres sólo
-- acepta como árbitro de "ON CONFLICT DO NOTHING" a un índice único completo, y el
-- insert de PostgREST no puede repetir el predicado. Con un índice parcial, la
-- segunda vez que llega una fila ya cargada el lote entero falla con un 409.
-- Tanto el script del Sheet como el importador de CSV siempre completan entry_id
-- (si el Sheet no lo trae, arman uno con la hoja y el número de fila).
create unique index if not exists idx_prospectos_dedup
  on public.labocomercial_prospectos (fuente, entry_id);

-- Búsqueda del mismo contacto por mail/teléfono (formulario + brochure = una persona).
create index if not exists idx_prospectos_email on public.labocomercial_prospectos (lower(email));
create index if not exists idx_prospectos_tel   on public.labocomercial_prospectos (telefono);
create index if not exists idx_prospectos_fecha on public.labocomercial_prospectos (fecha desc);
create index if not exists idx_prospectos_etapa on public.labocomercial_prospectos (etapa);

alter table public.labocomercial_prospectos enable row level security;

-- Sólo el equipo interno (login Microsoft @4housing.com.ar) ve y trabaja prospectos.
-- Los vendedores externos entran con cuentas de otro dominio y quedan afuera, igual
-- que hoy quedan afuera del CRM (ver aplicarModoExterno() en index.html).
drop policy if exists prospectos_select on public.labocomercial_prospectos;
create policy prospectos_select
  on public.labocomercial_prospectos for select
  to authenticated
  using (lower(coalesce(auth.jwt() ->> 'email','')) like '%@4housing.com.ar');

drop policy if exists prospectos_update on public.labocomercial_prospectos;
create policy prospectos_update
  on public.labocomercial_prospectos for update
  to authenticated
  using (lower(coalesce(auth.jwt() ->> 'email','')) like '%@4housing.com.ar')
  with check (lower(coalesce(auth.jwt() ->> 'email','')) like '%@4housing.com.ar');

drop policy if exists prospectos_insert on public.labocomercial_prospectos;
create policy prospectos_insert
  on public.labocomercial_prospectos for insert
  to authenticated
  with check (lower(coalesce(auth.jwt() ->> 'email','')) like '%@4housing.com.ar');

-- NOTA: el Apps Script que sincroniza el Google Sheet escribe con la service_role
-- key (guardada en las Propiedades del Script, nunca en este repo ni en el HTML),
-- que no pasa por RLS. Ver apps_script/README.md.

-- updated_at automático
create or replace function public.labocomercial_prospectos_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_prospectos_touch on public.labocomercial_prospectos;
create trigger trg_prospectos_touch
  before update on public.labocomercial_prospectos
  for each row execute function public.labocomercial_prospectos_touch();
