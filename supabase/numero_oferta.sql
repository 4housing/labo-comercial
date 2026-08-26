-- ═══════════════════════════════════════════════════════════════════════════
-- Número de oferta fijo por cliente
-- ═══════════════════════════════════════════════════════════════════════════
-- Correr una sola vez en el SQL Editor de Supabase (mismo proyecto que
-- labo_leads). Agrega la columna donde se guarda el número de oferta que un
-- cliente conserva en TODAS sus cotizaciones (la versión se distingue con
-- VER01, VER02, ... en el nombre del PDF, no con un número nuevo).
--
-- Los leads que ya existan sin este dato se completan solos (backfill) la
-- próxima vez que se les genere una cotización nueva — no hace falta
-- correr nada más a mano.

alter table public.labo_leads
  add column if not exists numero_oferta text;
