-- LABO — Calificación de prospectos (criterio del equipo comercial)
-- Ejecutar una vez en el SQL Editor de Supabase. Es idempotente.
--
-- El equipo califica cada prospecto con una de siete lecturas, que son las siete
-- combinaciones válidas de Estado × Calidad que ya usaban en el Google Sheet:
--
--   sin_interaccion  Sin respuesta · Malo   → Sin interacción
--   no_continua      No avanza     · Malo   → Responde, pero no continúa
--   sin_calidad      En curso      · N/A    → Aún no sabemos la calidad
--   orientado        En curso      · Medio  → Interactúa y está orientado
--   califica         En curso      · Bueno  → Interactúa y cumple con requisitos
--   cotizado         Cotizado      · Bueno  → Cotización realizada
--   venta            Venta         · Bueno  → Compra de casa modular
--
-- Se guarda la clave, no el texto: el texto se puede reescribir en el CRM sin
-- tocar la base ni invalidar lo ya cargado.
--
-- La etapa no desaparece: la calificación la mueve sola (ver PROS_CALIF en
-- index.html), para que el equipo tenga un solo lugar donde tocar y el embudo,
-- los indicadores y los filtros sigan funcionando igual.
--
-- Los prospectos que ya estaban cargados quedan sin calificar, a propósito: se
-- califican a medida que se trabajan.

alter table public.labocomercial_prospectos
  add column if not exists clasificacion text;

comment on column public.labocomercial_prospectos.clasificacion is
  'Calificación comercial: sin_interaccion | no_continua | sin_calidad | orientado | califica | cotizado | venta';

create index if not exists idx_prospectos_clasificacion
  on public.labocomercial_prospectos (clasificacion);
