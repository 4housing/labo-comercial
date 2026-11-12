-- LABO — Bot asistente comercial (atención automática de leads)
-- Ejecutar DESPUÉS de supabase_prospectos.sql. Es idempotente: se puede repetir.
--
-- Qué agrega
-- ----------
-- El bot NO reinventa el embudo: sigue alimentando labocomercial_prospectos (la
-- bandeja de entrada que ya existe). Lo nuevo es el HILO DE CHAT colgado de cada
-- prospecto, más dos tablas de control para que las conversaciones no cuesten una
-- barbaridad (rate-limit / anti-abuso) y para medir el gasto.
--
--   labocomercial_prospectos            (YA EXISTE — la bandeja)
--      └─ labocomercial_conversaciones  (un hilo por canal)
--           └─ labocomercial_mensajes   (cada mensaje)
--      └─ labocomercial_prospecto_credito  (CUIL, aislado — dato sensible)
--   labocomercial_bot_contactos  (rate-limit / reincidencia por identidad de canal)
--   labocomercial_bot_uso        (contador diario: tokens, costo, kill switch)
--
-- Quién escribe / quién lee
-- -------------------------
-- El edge function `labo-bot` escribe con la SERVICE_ROLE key (server-side, en los
-- Edge Function Secrets, NUNCA en el HTML público): saltea RLS. Las policies de acá
-- protegen la LECTURA desde el CRM: sólo el equipo interno (login Microsoft
-- @4housing.com.ar) ve y trabaja los chats, igual que hoy con los prospectos.
--
-- ⚠️ NOTA SOBRE RLS (validar con Pablo): se usa el MISMO predicado que
-- labocomercial_prospectos — email que termina en @4housing.com.ar — para que quien
-- ve la bandeja vea exactamente los chats. Esto se desvía de la regla 4 del CLAUDE.md
-- (que pide tiene_sector('labocomercial')). Si se prefiere la regla literal, cambiar
-- el `using (...)` por `using (public.tiene_sector('labocomercial'::public.sector_portal))`.

-- ════════════════════════════════════════════════════════════════════════════
-- Helper: predicado de acceso del equipo interno (idéntico a prospectos)
-- ════════════════════════════════════════════════════════════════════════════
-- Se repite el literal en cada policy (Postgres no deja parametrizar policies con
-- una expresión reutilizable sin una función). Para cambiar el criterio de acceso,
-- buscar y reemplazar la línea en las policies de abajo.

-- ════════════════════════════════════════════════════════════════════════════
-- 1) CONVERSACIONES — el hilo de chat, uno por canal, colgado del prospecto
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists public.labocomercial_conversaciones (
  id             bigint generated always as identity primary key,
  prospecto_id   bigint not null
                 references public.labocomercial_prospectos(id) on delete cascade,

  canal          text not null,          -- 'web' | 'whatsapp' | 'instagram'
  canal_user_id  text,                   -- wa_id / ig id / session web → rutea el entrante

  -- Estado del bot sobre este hilo
  estado         text not null default 'activa',  -- activa | en_espera | derivada | cerrada

  -- Señales duras que va capturando el bot (base del gate del CUIL y del resumen):
  -- {terreno, zona, presupuesto, plazo, modelo, tipo_proyecto, banco}
  senales        jsonb not null default '{}'::jsonb,

  resumen        text,                   -- lo que el bot deja escrito para el asesor
  clasif_sugerida text,                  -- mapea a los 7 estados del embudo (clasificacion)

  -- Derivación a humano
  derivada_a     text,                   -- responsable asignado al pasar a humano
  derivada_at    timestamptz,

  -- WhatsApp: ventana de servicio de 24h (fase WhatsApp). Si ya expiró y hay que
  -- reabrir, el bot debe usar un template aprobado, no texto libre.
  ventana_expira_at timestamptz,

  ultimo_msg_at  timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint labocomercial_conversaciones_canal_chk
    check (canal in ('web','whatsapp','instagram')),
  constraint labocomercial_conversaciones_estado_chk
    check (estado in ('activa','en_espera','derivada','cerrada'))
);

create index if not exists idx_conv_prospecto on public.labocomercial_conversaciones (prospecto_id);
create index if not exists idx_conv_canal_user on public.labocomercial_conversaciones (canal, canal_user_id);
create index if not exists idx_conv_estado    on public.labocomercial_conversaciones (estado);
create index if not exists idx_conv_ultimo    on public.labocomercial_conversaciones (ultimo_msg_at desc);

alter table public.labocomercial_conversaciones enable row level security;
revoke all on public.labocomercial_conversaciones from anon;

drop policy if exists conv_select on public.labocomercial_conversaciones;
create policy conv_select on public.labocomercial_conversaciones for select
  to authenticated
  using (lower(coalesce(auth.jwt() ->> 'email','')) like '%@4housing.com.ar');

drop policy if exists conv_update on public.labocomercial_conversaciones;
create policy conv_update on public.labocomercial_conversaciones for update
  to authenticated
  using (lower(coalesce(auth.jwt() ->> 'email','')) like '%@4housing.com.ar')
  with check (lower(coalesce(auth.jwt() ->> 'email','')) like '%@4housing.com.ar');

-- Insert/delete quedan para el edge function (service_role). El equipo lee y, a lo
-- sumo, corrige estado/clasificación/derivación (update). No crea hilos a mano.

-- ════════════════════════════════════════════════════════════════════════════
-- 2) MENSAJES — cada mensaje del hilo (inmutable: no se edita)
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists public.labocomercial_mensajes (
  id             bigint generated always as identity primary key,
  conversacion_id bigint not null
                 references public.labocomercial_conversaciones(id) on delete cascade,

  rol            text not null,          -- 'lead' | 'bot' | 'asesor' | 'sistema'
  texto          text,
  adjunto        jsonb,                  -- {tipo, url} si manda imagen/audio (no se descarga)

  -- Id del mensaje en Meta → dedup: un mismo webhook no se procesa dos veces.
  canal_msg_id   text,

  -- Medición de costo (sólo mensajes que pasan por Claude)
  tokens_in      int,
  tokens_out     int,

  created_at     timestamptz not null default now(),

  constraint labocomercial_mensajes_rol_chk
    check (rol in ('lead','bot','asesor','sistema'))
);

create index if not exists idx_msg_conv on public.labocomercial_mensajes (conversacion_id, created_at);
-- Dedup de webhooks: único cuando hay id de canal (texto libre web no lo trae).
create unique index if not exists idx_msg_canal_msg
  on public.labocomercial_mensajes (canal_msg_id) where canal_msg_id is not null;

alter table public.labocomercial_mensajes enable row level security;
revoke all on public.labocomercial_mensajes from anon;

drop policy if exists msg_select on public.labocomercial_mensajes;
create policy msg_select on public.labocomercial_mensajes for select
  to authenticated
  using (lower(coalesce(auth.jwt() ->> 'email','')) like '%@4housing.com.ar');

-- El asesor puede escribir desde la bandeja (rol='asesor'); el bot/sistema escriben
-- con service_role. Se permite insert del equipo para la respuesta manual.
drop policy if exists msg_insert on public.labocomercial_mensajes;
create policy msg_insert on public.labocomercial_mensajes for insert
  to authenticated
  with check (lower(coalesce(auth.jwt() ->> 'email','')) like '%@4housing.com.ar');

-- ════════════════════════════════════════════════════════════════════════════
-- 3) PROSPECTO_CREDITO — el CUIL para la simulación de Provincia (DATO SENSIBLE)
-- ════════════════════════════════════════════════════════════════════════════
-- Aislado del historial de chat, a propósito. Lo guarda el bot SOLO cuando el lead
-- ya cumple las condiciones duras (gate validado server-side en el edge function) o
-- cuando lo ofrece sin que se lo pidan. El asesor humano corre la simulación.
-- RLS estricto; nunca anon; nunca va al repo público.
create table if not exists public.labocomercial_prospecto_credito (
  id             bigint generated always as identity primary key,
  prospecto_id   bigint not null
                 references public.labocomercial_prospectos(id) on delete cascade,
  conversacion_id bigint
                 references public.labocomercial_conversaciones(id) on delete set null,

  banco          text not null default 'provincia',
  titulares      jsonb not null,         -- [{nombre, cuil}] — soporta co-titulares
  estado         text not null default 'pendiente_simulacion',
  capturado_por  text,                   -- 'bot' | email del asesor
  capturado_at   timestamptz not null default now()
);

-- Uno por prospecto.
create unique index if not exists idx_credito_prospecto
  on public.labocomercial_prospecto_credito (prospecto_id);

alter table public.labocomercial_prospecto_credito enable row level security;
revoke all on public.labocomercial_prospecto_credito from anon;

drop policy if exists credito_select on public.labocomercial_prospecto_credito;
create policy credito_select on public.labocomercial_prospecto_credito for select
  to authenticated
  using (lower(coalesce(auth.jwt() ->> 'email','')) like '%@4housing.com.ar');

drop policy if exists credito_update on public.labocomercial_prospecto_credito;
create policy credito_update on public.labocomercial_prospecto_credito for update
  to authenticated
  using (lower(coalesce(auth.jwt() ->> 'email','')) like '%@4housing.com.ar')
  with check (lower(coalesce(auth.jwt() ->> 'email','')) like '%@4housing.com.ar');

-- ════════════════════════════════════════════════════════════════════════════
-- 4) BOT_CONTACTOS — rate-limit / anti-abuso por identidad de canal
-- ════════════════════════════════════════════════════════════════════════════
-- El edge function lee/incrementa estos contadores ANTES de llamar a Claude. Si el
-- contacto superó el rate o está bloqueado, se corta sin gastar tokens. También
-- recuerda a los reincidentes de spam.
create table if not exists public.labocomercial_bot_contactos (
  canal           text not null,         -- 'web' | 'whatsapp' | 'instagram'
  canal_user_id   text not null,

  -- Ventanas de rate (las resetea el edge function cuando cambia la referencia)
  msgs_hora       int  not null default 0,
  hora_ref        timestamptz,
  msgs_dia        int  not null default 0,
  dia_ref         date,

  bloqueado_hasta timestamptz,           -- si está seteado y es futuro → se ignora
  spam_hits       int  not null default 0,

  -- Acumulados (métrica / auditoría)
  msgs_total      bigint not null default 0,
  tokens_total    bigint not null default 0,

  primer_contacto timestamptz not null default now(),
  ultimo_contacto timestamptz,

  primary key (canal, canal_user_id)
);

alter table public.labocomercial_bot_contactos enable row level security;
revoke all on public.labocomercial_bot_contactos from anon;

-- Sólo lectura para el equipo (ver quién está bloqueado / reincidente). La escritura
-- la hace el edge function con service_role.
drop policy if exists bot_contactos_select on public.labocomercial_bot_contactos;
create policy bot_contactos_select on public.labocomercial_bot_contactos for select
  to authenticated
  using (lower(coalesce(auth.jwt() ->> 'email','')) like '%@4housing.com.ar');

-- ════════════════════════════════════════════════════════════════════════════
-- 5) BOT_USO — contador diario: tokens, costo estimado, kill switch
-- ════════════════════════════════════════════════════════════════════════════
-- Una fila por día. El edge function la incrementa; el kill switch (budget diario)
-- la lee antes de responder. Alimenta el indicador de costo del CRM.
create table if not exists public.labocomercial_bot_uso (
  fecha               date primary key,
  mensajes            int    not null default 0,
  tokens_in           bigint not null default 0,
  tokens_out          bigint not null default 0,
  costo_usd_estimado  numeric(12,4) not null default 0,  -- Claude (Haiku)
  templates_enviados  int    not null default 0,         -- WhatsApp proactivo (costo Meta)
  updated_at          timestamptz not null default now()
);

alter table public.labocomercial_bot_uso enable row level security;
revoke all on public.labocomercial_bot_uso from anon;

drop policy if exists bot_uso_select on public.labocomercial_bot_uso;
create policy bot_uso_select on public.labocomercial_bot_uso for select
  to authenticated
  using (lower(coalesce(auth.jwt() ->> 'email','')) like '%@4housing.com.ar');

-- ════════════════════════════════════════════════════════════════════════════
-- 6) updated_at automático (conversaciones + bot_uso)
-- ════════════════════════════════════════════════════════════════════════════
-- Reusa la función de prospectos si ya existe; si no, la crea.
create or replace function public.labocomercial_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_conv_touch on public.labocomercial_conversaciones;
create trigger trg_conv_touch
  before update on public.labocomercial_conversaciones
  for each row execute function public.labocomercial_touch_updated_at();

drop trigger if exists trg_bot_uso_touch on public.labocomercial_bot_uso;
create trigger trg_bot_uso_touch
  before update on public.labocomercial_bot_uso
  for each row execute function public.labocomercial_touch_updated_at();

-- ════════════════════════════════════════════════════════════════════════════
-- Verificación rápida (opcional, para correr a mano después)
-- ════════════════════════════════════════════════════════════════════════════
--   select table_name from information_schema.tables
--    where table_schema='public' and table_name like 'labocomercial_%'
--    order by table_name;
--
--   select policyname, cmd, roles::text from pg_policies
--    where schemaname='public'
--      and tablename in ('labocomercial_conversaciones','labocomercial_mensajes',
--                        'labocomercial_prospecto_credito','labocomercial_bot_contactos',
--                        'labocomercial_bot_uso')
--    order by tablename, policyname;
