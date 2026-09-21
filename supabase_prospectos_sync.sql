-- LABO — Cuenta de sincronización del Google Sheet (mínimo privilegio)
-- Ejecutar DESPUÉS de supabase_prospectos.sql.
--
-- Por qué existe este archivo
-- ---------------------------
-- El Google Sheet de los leads lo administra un proveedor externo. Cualquiera con
-- acceso de edición a ese Sheet puede abrir el editor de Apps Script y leer las
-- credenciales guardadas ahí. Por eso el script NO puede usar la service_role key:
-- esa clave saltea RLS y da control total del proyecto (leads, costos, usuarios).
--
-- En su lugar el script entra como una cuenta común de Supabase que sólo puede
-- INSERTAR prospectos. Si esa credencial se filtra, lo peor que puede pasar es que
-- alguien cargue prospectos basura: no puede leer el pipeline, ni los costos, ni
-- modificar o borrar nada.
--
-- Paso previo (en el panel de Supabase, no acá):
--   Authentication → Users → Add user → Create new user
--     Email:    sheets-sync@labomodular.com     (cualquier dirección que NO sea
--                                                @4housing.com.ar — ver abajo)
--     Password: una contraseña larga y aleatoria
--     Auto Confirm User: SÍ
--
-- El mail NO tiene que ser @4housing.com.ar a propósito: las políticas del equipo
-- se otorgan por ese dominio, así que una cuenta de servicio con ese dominio
-- heredaría permiso de lectura sobre todos los prospectos. Con otro dominio, queda
-- con lo único que le damos acá: insertar.

-- Si usaste otro mail al crear la cuenta, cambialo en las dos líneas de abajo.
drop policy if exists prospectos_insert_sync on public.labocomercial_prospectos;
create policy prospectos_insert_sync
  on public.labocomercial_prospectos for insert
  to authenticated
  with check (lower(coalesce(auth.jwt() ->> 'email','')) = 'sheets-sync@labomodular.com');

-- Comprobación: esta cuenta no tiene ninguna política de select, update ni delete,
-- ni sobre prospectos ni sobre ninguna otra tabla. Para verlo:
--   select tablename, policyname, cmd, qual, with_check
--     from pg_policies
--    where schemaname = 'public'
--    order by tablename, policyname;
--
-- Para cortarle el acceso en cualquier momento: Authentication → Users → el usuario
-- → Delete user (o cambiarle la contraseña). El CRM y el equipo no se ven afectados.
