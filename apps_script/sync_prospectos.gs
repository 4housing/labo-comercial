/**
 * LABO — Sincronización Google Sheet → CRM (Supabase)
 * ---------------------------------------------------
 * Se pega en el editor de Apps Script del Sheet "Envíos Formularios - Labo Modular"
 * (Extensiones → Apps Script). Lee las filas nuevas de cada hoja y las manda a la
 * tabla labocomercial_prospectos de Supabase, que es la bandeja de entrada del CRM.
 *
 * Ver apps_script/README.md para la instalación paso a paso.
 *
 * Reglas de oro:
 *  - La clave (service_role) NO va en este archivo: va en Propiedades del Script.
 *  - Nada se duplica: cada fila viaja con su Entry ID y la base tiene índice único.
 *  - Nada se pisa: si la fila ya existe, el CRM manda (etapa, responsable y notas se
 *    trabajan del lado del CRM, no se sobrescriben desde el Sheet).
 *  - Cada fila enviada queda marcada en la columna "CRM" de la propia hoja, así el
 *    equipo que sigue mirando el Sheet ve qué ya está adentro.
 */

// ── Hojas a sincronizar ───────────────────────────────────────────────────────
// 'hoja' tiene que coincidir con el nombre de la pestaña del Sheet.
var HOJAS = [
  { hoja: 'Formulario',   fuente: 'formulario',   origen: 'Google Ads' },
  { hoja: 'Brochure',     fuente: 'brochure',     origen: 'Google Ads' },
  { hoja: 'Landing Meta', fuente: 'landing_meta', origen: 'Meta' }
];

var COL_MARCA = 'CRM';   // columna que agrega el script para marcar lo ya sincronizado
var LOTE      = 200;     // filas por request

// ── Punto de entrada: esto es lo que corre el disparador cada 10 minutos ──────
function sincronizarProspectos() {
  var total = 0;
  HOJAS.forEach(function (cfg) {
    try {
      total += _sincronizarHoja(cfg, false);
    } catch (e) {
      Logger.log('Error en hoja "' + cfg.hoja + '": ' + e);
    }
  });
  Logger.log('Sincronización terminada. Filas nuevas enviadas: ' + total);
  return total;
}

/**
 * Carga histórica: reenvía TODAS las filas, incluso las ya marcadas.
 * Se corre una sola vez, a mano, para subir el histórico del Sheet al CRM.
 * Es seguro repetirlo: lo que ya está en la base no se duplica ni se pisa.
 */
function sincronizarTodoElHistorico() {
  var total = 0;
  HOJAS.forEach(function (cfg) {
    try {
      total += _sincronizarHoja(cfg, true);
    } catch (e) {
      Logger.log('Error en hoja "' + cfg.hoja + '": ' + e);
    }
  });
  Logger.log('Carga histórica terminada. Filas enviadas: ' + total);
  return total;
}

/** Instala el disparador cada 10 minutos (correr una sola vez). */
function instalarDisparador() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sincronizarProspectos') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sincronizarProspectos').timeBased().everyMinutes(10).create();
  Logger.log('Disparador instalado: sincronizarProspectos cada 10 minutos.');
}

/** Chequeo rápido de configuración y conectividad (correr después de instalar). */
function verificarConexion() {
  var cfg = _config();
  var resp = UrlFetchApp.fetch(
    cfg.url + '/rest/v1/labocomercial_prospectos?select=id&limit=1',
    { method: 'get', headers: _headers(cfg), muteHttpExceptions: true }
  );
  var code = resp.getResponseCode();
  Logger.log(code === 200
    ? '✓ Conexión OK con Supabase.'
    : '✗ Error ' + code + ': ' + resp.getContentText());
  return code === 200;
}

// ── Motor ─────────────────────────────────────────────────────────────────────

function _sincronizarHoja(cfg, incluirYaMarcadas) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(cfg.hoja);
  if (!sh) { Logger.log('Hoja no encontrada: ' + cfg.hoja); return 0; }

  var ultimaFila = sh.getLastRow();
  if (ultimaFila < 2) return 0;

  var anchoOriginal = sh.getLastColumn();
  var encabezados = sh.getRange(1, 1, 1, anchoOriginal).getValues()[0];
  var mapa = _mapearColumnas(encabezados);
  var colMarca = _asegurarColumnaMarca(sh, encabezados, anchoOriginal);

  var datos = sh.getRange(2, 1, ultimaFila - 1, Math.max(anchoOriginal, colMarca)).getValues();
  var supa = _config();

  var pendientes = [];   // { fila: <nro de fila real>, payload: {...} }
  datos.forEach(function (fila, i) {
    var nroFila = i + 2;
    var marca = String(fila[colMarca - 1] || '').trim();
    if (marca && !incluirYaMarcadas) return;                 // ya está en el CRM
    if (_filaVacia(fila, mapa)) return;                      // fila en blanco
    pendientes.push({ fila: nroFila, payload: _filaAProspecto(fila, mapa, cfg, nroFila, encabezados) });
  });

  if (!pendientes.length) return 0;

  var enviadas = 0;
  for (var d = 0; d < pendientes.length; d += LOTE) {
    var lote = pendientes.slice(d, d + LOTE);
    var insertados = _postProspectos(supa, lote.map(function (p) { return p.payload; }));
    if (insertados === null) break;                          // error de red/API: se reintenta en la próxima corrida

    // Mapa entry_id → id de la base, para marcar cada fila con su id del CRM.
    var porEntry = {};
    insertados.forEach(function (row) { if (row && row.entry_id) porEntry[String(row.entry_id)] = row.id; });

    lote.forEach(function (p) {
      var id = porEntry[String(p.payload.entry_id)];
      sh.getRange(p.fila, colMarca).setValue(id ? ('✓ ' + id) : '✓ ya estaba');
    });
    enviadas += lote.length;
    SpreadsheetApp.flush();
  }
  Logger.log('Hoja "' + cfg.hoja + '": ' + enviadas + ' filas enviadas.');
  return enviadas;
}

function _postProspectos(supa, filas) {
  var resp = UrlFetchApp.fetch(supa.url + '/rest/v1/labocomercial_prospectos', {
    method: 'post',
    contentType: 'application/json',
    headers: _headers(supa, 'resolution=ignore-duplicates,return=representation'),
    payload: JSON.stringify(filas),
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  if (code < 200 || code >= 300) {
    Logger.log('Supabase respondió ' + code + ': ' + resp.getContentText());
    return null;
  }
  try { return JSON.parse(resp.getContentText() || '[]'); } catch (e) { return []; }
}

// ── Armado del registro ───────────────────────────────────────────────────────

function _filaAProspecto(fila, mapa, cfg, nroFila, encabezados) {
  function v(campo) {
    var idx = mapa[campo];
    return (idx === undefined) ? '' : fila[idx];
  }
  // Sin Entry ID usamos una clave estable por hoja+fila, para que una resincronización
  // tampoco duplique esas filas.
  var entryId = _txt(v('entry_id')) || (cfg.fuente + '-r' + nroFila);

  return {
    fuente:        cfg.fuente,
    entry_id:      entryId,
    origen:        cfg.origen,
    fecha:         _fecha(v('fecha')),
    url:           _txt(v('url')),
    nombre:        _txt(v('nombre')),
    email:         _txt(v('email')).toLowerCase(),
    telefono:      _tel(v('telefono')),
    region:        _txt(v('region')),
    modelo:        _txt(v('modelo')),
    tipo_proyecto: _txt(v('tipo_proyecto')),
    comentario:    _txt(v('comentario')),

    etapa:             _etapa(v('etapa_sheet'), v('estado_sheet')),
    contactos:         _contactos(v('etapa_sheet')),
    calidad:           _calidad(v('calidad')),
    responsable:       _txt(v('responsable')),
    notas:             _txt(v('notas')),
    descargo_brochure: cfg.fuente === 'brochure' ? true : _siNo(v('descargo_brochure')),

    raw: _raw(fila, encabezados)
  };
}

/** Fila original completa, por si alguna columna del Sheet no está mapeada. */
function _raw(fila, encabezados) {
  var o = {};
  encabezados.forEach(function (h, i) {
    var k = String(h || '').trim();
    if (!k) return;
    var val = fila[i];
    if (val === '' || val === null || val === undefined) return;
    o[k] = (val instanceof Date) ? val.toISOString() : String(val);
  });
  return o;
}

// ── Mapeo de columnas (por nombre de encabezado, tolerante a acentos y mayúsculas) ──

var ALIAS = {
  entry_id:          ['entryid', 'id', 'identry'],
  nombre:            ['nombreyapellido', 'nombre', 'nombreapellido', 'nombrecompleto', 'apellidoynombre'],
  telefono:          ['telefono', 'tel', 'celular', 'whatsapp', 'movil'],
  email:             ['correoelectronico', 'email', 'mail', 'correo', 'e-mail'],
  modelo:            ['modelo', 'modelodeinteres'],
  tipo_proyecto:     ['tipodeproyecto', 'tipoproyecto', 'proyecto'],
  comentario:        ['comentariosadicional', 'comentariosadicionales', 'comentarioadicional', 'mensaje', 'consulta'],
  fecha:             ['fecha', 'fechadeenvio', 'timestamp', 'marcatemporal'],
  url:               ['url', 'link', 'pagina'],
  region:            ['region', 'provincia', 'zona', 'ubicacion'],
  etapa_sheet:       ['etapa'],
  estado_sheet:      ['estado'],
  calidad:           ['calidaddellead', 'calidad', 'calidadlead'],
  responsable:       ['contacto', 'responsable', 'vendedor', 'asignadoa'],
  notas:             ['comentarios', 'observaciones', 'notas'],
  descargo_brochure: ['descargobrochure', 'descargobrochures', 'brochure']
};

function _mapearColumnas(encabezados) {
  var norm = encabezados.map(function (h) { return _norm(h); });
  var mapa = {}, usadas = {};
  Object.keys(ALIAS).forEach(function (campo) {
    for (var a = 0; a < ALIAS[campo].length; a++) {
      var idx = norm.indexOf(ALIAS[campo][a]);
      if (idx >= 0 && !usadas[idx]) { mapa[campo] = idx; usadas[idx] = true; return; }
    }
  });
  return mapa;
}

/** Busca la columna "CRM"; si no existe, la agrega al final. Devuelve su número (1-based). */
function _asegurarColumnaMarca(sh, encabezados, anchoOriginal) {
  for (var i = 0; i < encabezados.length; i++) {
    if (_norm(encabezados[i]) === _norm(COL_MARCA)) return i + 1;
  }
  var col = anchoOriginal + 1;
  if (col > sh.getMaxColumns()) sh.insertColumnsAfter(sh.getMaxColumns(), col - sh.getMaxColumns());
  sh.getRange(1, col).setValue(COL_MARCA);
  return col;
}

// ── Normalizadores ────────────────────────────────────────────────────────────

function _norm(s) {
  return String(s === null || s === undefined ? '' : s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // saca acentos
    .toLowerCase().replace(/[^a-z0-9]/g, '');           // saca espacios, ¿?, °, etc.
}
function _txt(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  return String(v).trim();
}
function _tel(v) {
  if (v === null || v === undefined || v === '') return '';
  // Los teléfonos vienen como número: sin esto se guardarían como 1.15E+10.
  if (typeof v === 'number') return String(Math.round(v));
  return String(v).trim();
}
function _fecha(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  var s = String(v).trim();
  var m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);   // d/m/aaaa
  if (m) {
    var anio = m[3].length === 2 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10);
    var d = new Date(anio, parseInt(m[2], 10) - 1, parseInt(m[1], 10), 12, 0, 0);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  var d2 = new Date(s);
  return isNaN(d2.getTime()) ? null : d2.toISOString();
}
/** Etapa del Sheet ("1° contacto") + Estado ("En curso" / "No avanza") → etapa del CRM. */
function _etapa(etapaSheet, estadoSheet) {
  var est = _norm(estadoSheet), et = _norm(etapaSheet);
  if (est.indexOf('noavanza') >= 0 || est.indexOf('perdido') >= 0 || est.indexOf('descart') >= 0) return 'Descartado';
  if (est.indexOf('cotiz') >= 0 || est.indexOf('ganado') >= 0 || est.indexOf('convert') >= 0) return 'Convertido';
  if (est.indexOf('encurso') >= 0 || est.indexOf('seguimiento') >= 0) return 'En seguimiento';
  if (et) return 'Contactado';
  return 'Nuevo';
}
function _contactos(etapaSheet) {
  var m = String(etapaSheet || '').match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}
function _calidad(v) {
  var n = _norm(v);
  if (!n || n === 'na') return null;
  if (n.indexOf('buen') >= 0) return 'Bueno';
  if (n.indexOf('regular') >= 0 || n.indexOf('medio') >= 0) return 'Regular';
  if (n.indexOf('mal') >= 0 || n.indexOf('bajo') >= 0) return 'Malo';
  return _txt(v);
}
function _siNo(v) {
  var n = _norm(v);
  if (!n) return false;
  if (n === 'no' || n === 'false' || n === '0') return false;
  return true;   // "Sí", "true", o el mail pegado en la columna: descargó
}
function _filaVacia(fila, mapa) {
  return !_txt(fila[mapa.nombre]) && !_txt(fila[mapa.email]) && !_tel(fila[mapa.telefono]);
}

// ── Configuración (Propiedades del Script) ────────────────────────────────────

function _config() {
  var p = PropertiesService.getScriptProperties();
  var url = (p.getProperty('SUPABASE_URL') || '').replace(/\/+$/, '');
  var key = p.getProperty('SUPABASE_SERVICE_KEY') || '';
  if (!url || !key) {
    throw new Error('Falta configurar SUPABASE_URL y SUPABASE_SERVICE_KEY en ' +
                    'Configuración del proyecto → Propiedades del script.');
  }
  return { url: url, key: key };
}

function _headers(cfg, prefer) {
  var h = { 'apikey': cfg.key, 'Authorization': 'Bearer ' + cfg.key };
  if (prefer) h['Prefer'] = prefer;
  return h;
}
