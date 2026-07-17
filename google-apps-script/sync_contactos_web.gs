/**
 * Sincroniza la planilla "Envíos Formularios - Labo Modular" con la herramienta
 * labo (Supabase), en las dos direcciones, sin dar acceso a la agencia a labo:
 *
 *   1) INGESTA (Sheet → labo): cada fila nueva (por Entry ID) se manda a labo
 *      vía la función RPC ingest_contacto_web. Esa función solo AGREGA — nunca
 *      lee ni pisa lo que el equipo comercial ya cargó para ese contacto.
 *
 *   2) DEVOLUCIÓN DE ESTADO (labo → Sheet): trae Etapa/Estado/Calidad/Comentarios
 *      desde la vista pública contactos_web_agencia (no expone nombre/teléfono/
 *      email) y los escribe en esta misma hoja, para que la agencia los vea sin
 *      necesidad de entrar a labo.
 *
 * INSTALACIÓN
 *  1. Abrí la planilla → Extensiones → Apps Script.
 *  2. Pegá este archivo completo (reemplazando el contenido de Code.gs).
 *  3. Revisá SHEET_NAME más abajo (el nombre exacto de la pestaña con los leads).
 *  4. Dejá DRY_RUN = true y ejecutá una vez syncContactosWeb() manualmente
 *     (▶ en la barra de herramientas, elegí la función syncContactosWeb).
 *     Te va a pedir autorización la primera vez — es normal, es tu propio script.
 *  5. Abrí Ver → Registros de ejecución y revisá "Columnas detectadas": tienen
 *     que aparecer entryId, etapa, estado, calidad con un número (no null).
 *     Si alguna da null, el encabezado de esa columna no matcheó — avisame el
 *     nombre exacto que tiene en la fila 1 y ajusto detectColumns_().
 *  6. Una vez que el mapeo esté bien, cambiá DRY_RUN a false y ejecutá
 *     crearTrigger() una sola vez (queda corriendo sola cada 15 minutos).
 */

var SUPABASE_URL = 'https://rhajlvmneyvgqlyeyjsd.supabase.co';
// Mismo anon key público que usa la herramienta labo (visible en su index.html;
// no es secreto — el acceso real lo controla RLS en Supabase, no este key).
var SUPABASE_ANON_KEY = 'PEGAR_AQUI_EL_ANON_KEY_DE_SUPABASE';
var SHEET_NAME = 'Formulario';
var DRY_RUN = true;

function crearTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncContactosWeb') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncContactosWeb').timeBased().everyMinutes(15).create();
  Logger.log('Trigger creado: syncContactosWeb cada 15 minutos.');
}

function syncContactosWeb() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet) { Logger.log('No se encontró la hoja "' + SHEET_NAME + '".'); return; }
  var lastRow = sheet.getLastRow(), lastCol = sheet.getLastColumn();
  if (lastRow < 2) { Logger.log('Sin filas de datos.'); return; }

  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var cols = detectColumns_(headers);
  Logger.log('Columnas detectadas: ' + JSON.stringify(cols));
  if (cols.entryId == null || cols.etapa == null || cols.estado == null || cols.calidad == null) {
    Logger.log('Faltan columnas clave (entryId/etapa/estado/calidad). Revisá los encabezados de la fila 1 antes de continuar.');
    return;
  }

  var data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  ingestNuevos_(data, cols);
  escribirEstado_(sheet, data, cols);
}

// Detecta columnas por el texto del encabezado (no por letra fija), para no
// depender de que nadie reordene columnas en la planilla de la agencia.
function detectColumns_(headers) {
  function norm(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  }
  var n = headers.map(norm);
  function find(aliases) {
    for (var i = 0; i < n.length; i++) {
      for (var a = 0; a < aliases.length; a++) {
        if (n[i].indexOf(aliases[a]) > -1) return i;
      }
    }
    return null;
  }
  var etapaIdx = find(['etapa']);
  var estadoIdx = find(['estado']);
  var calidadIdx = find(['calidad']);

  // Puede haber dos columnas "comentario*": la del formulario (antes de Etapa)
  // y la de seguimiento comercial (después de Calidad). Se resuelven por posición.
  var comentarioIdxs = [];
  for (var i = 0; i < n.length; i++) { if (n[i].indexOf('comentario') > -1) comentarioIdxs.push(i); }
  var comentarioForm = null, comentarioSeguimiento = null;
  comentarioIdxs.forEach(function (i) {
    if (etapaIdx != null && i < etapaIdx) comentarioForm = i;
    else comentarioSeguimiento = i;
  });

  return {
    entryId: find(['entry id', 'entryid']),
    nombre: find(['nombre']),
    telefono: find(['telefono', 'tel']),
    email: find(['correo', 'email']),
    modelo: find(['modelo']),
    tipoProyecto: find(['tipo de proyecto']),
    fecha: find(['fecha']),
    url: find(['url']),
    comentarioForm: comentarioForm,
    etapa: etapaIdx,
    estado: estadoIdx,
    calidad: calidadIdx,
    comentarioSeguimiento: comentarioSeguimiento
  };
}

// Manda a labo las filas que todavía no se hayan ingerido (por número de fila
// procesada, guardado en Script Properties — evita re-mandar 1000+ filas cada
// corrida y quedarse sin cuota de UrlFetch).
function ingestNuevos_(data, cols) {
  var props = PropertiesService.getScriptProperties();
  var lastSynced = parseInt(props.getProperty('lastSyncedDataRow') || '0', 10); // índice dentro de `data`
  var nuevas = 0;

  for (var r = lastSynced; r < data.length; r++) {
    var row = data[r];
    var entryId = row[cols.entryId];
    if (!entryId) continue;

    var payload = {
      p_entry_id: String(entryId),
      p_fecha: _fmtFecha(cols.fecha != null ? row[cols.fecha] : null),
      p_nombre: cols.nombre != null ? String(row[cols.nombre] || '') : '',
      p_telefono: cols.telefono != null ? String(row[cols.telefono] || '') : '',
      p_email: cols.email != null ? String(row[cols.email] || '') : '',
      p_modelo: cols.modelo != null ? String(row[cols.modelo] || '') : '',
      p_tipo_proyecto: cols.tipoProyecto != null ? String(row[cols.tipoProyecto] || '') : '',
      p_comentario_form: cols.comentarioForm != null ? String(row[cols.comentarioForm] || '') : '',
      p_url: cols.url != null ? String(row[cols.url] || '') : ''
    };
    nuevas++;
    if (DRY_RUN) { Logger.log('[DRY RUN] ingest_contacto_web ' + JSON.stringify(payload)); continue; }

    var res = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/rpc/ingest_contacto_web', {
      method: 'post',
      contentType: 'application/json',
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    if (res.getResponseCode() >= 300) Logger.log('Error ingest ' + entryId + ': ' + res.getContentText());
  }

  Logger.log(nuevas + ' fila(s) nueva(s) procesada(s).');
  if (!DRY_RUN) props.setProperty('lastSyncedDataRow', String(data.length));
}

// Trae el estado de seguimiento desde labo (una sola llamada) y lo escribe en
// la planilla con 4 escrituras por columna (no una por fila), para que esto
// funcione igual de rápido con 100 o con 10.000 filas.
function escribirEstado_(sheet, data, cols) {
  var res = UrlFetchApp.fetch(SUPABASE_URL + '/rest/v1/contactos_web_agencia?select=*', {
    method: 'get',
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 300) { Logger.log('Error leyendo estado: ' + res.getContentText()); return; }

  var estados = {};
  JSON.parse(res.getContentText()).forEach(function (r) { estados[String(r.entry_id)] = r; });

  var etapaCol = [], estadoCol = [], calidadCol = [], comentCol = [];
  var cambios = 0;
  for (var r = 0; r < data.length; r++) {
    var row = data[r];
    var entryId = String(row[cols.entryId] || '');
    var est = estados[entryId];
    var comentarioActual = cols.comentarioSeguimiento != null ? (row[cols.comentarioSeguimiento] || '') : '';
    var comentTexto = (est && est.comentarios && est.comentarios.length)
      ? est.comentarios[est.comentarios.length - 1].texto
      : comentarioActual;

    etapaCol.push([est ? (est.etapa || '') : (row[cols.etapa] || '')]);
    estadoCol.push([est ? (est.estado || '') : (row[cols.estado] || '')]);
    calidadCol.push([est ? (est.calidad || '') : (row[cols.calidad] || '')]);
    comentCol.push([comentTexto]);
    if (est) cambios++;
  }

  if (DRY_RUN) { Logger.log('[DRY RUN] Se actualizarían ' + cambios + ' fila(s) con su estado de seguimiento.'); return; }

  if (cols.etapa != null) sheet.getRange(2, cols.etapa + 1, etapaCol.length, 1).setValues(etapaCol);
  if (cols.estado != null) sheet.getRange(2, cols.estado + 1, estadoCol.length, 1).setValues(estadoCol);
  if (cols.calidad != null) sheet.getRange(2, cols.calidad + 1, calidadCol.length, 1).setValues(calidadCol);
  if (cols.comentarioSeguimiento != null) sheet.getRange(2, cols.comentarioSeguimiento + 1, comentCol.length, 1).setValues(comentCol);

  Logger.log(cambios + ' fila(s) actualizada(s) con su estado de seguimiento.');
}

function _fmtFecha(v) {
  if (!v) return null;
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return String(v);
}
