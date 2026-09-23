/**
 * LABO — Sincronización Google Sheet → CRM (Supabase)
 * ---------------------------------------------------
 * Se pega en el editor de Apps Script del Sheet "Envíos Formularios - Labo Modular"
 * (Extensiones → Apps Script). Lee las filas nuevas de cada hoja y las manda a la
 * tabla labocomercial_prospectos de Supabase, que es la bandeja de entrada del CRM.
 *
 * Ver apps_script/README.md para la instalación paso a paso.
 *
 * Todo se maneja desde el menú "LABO CRM" que aparece en la barra del Sheet.
 *
 * Seguridad: este Sheet lo administra un proveedor externo, y cualquiera con
 * acceso de edición puede leer lo que el script tenga guardado. Por eso el script
 * NO guarda ningún secreto: usa la clave pública del proyecto (la misma que viaja
 * en el HTML del CRM) y la base le permite una sola cosa, insertar prospectos.
 * No puede leer el pipeline, ni los costos, ni modificar o borrar nada.
 * Ver supabase_prospectos_sync.sql.
 *
 * Reglas de oro:
 *  - Acá no hay contraseñas ni claves privadas, y no hay nada que configurar.
 *  - Nada se duplica: cada fila viaja con su Entry ID y la base tiene índice único.
 *  - Nada se pisa: si la fila ya existe, el CRM manda (etapa, responsable y notas se
 *    trabajan del lado del CRM, no se sobrescriben desde el Sheet).
 *  - Cada fila enviada queda marcada en la columna "CRM" de la propia hoja, así el
 *    equipo que sigue mirando el Sheet ve qué ya está adentro.
 */

// ── Hojas a sincronizar ───────────────────────────────────────────────────────
// 'hoja' tiene que coincidir con el nombre de la pestaña del Sheet.
// "Landing Meta" NO va: es una tabla de configuración de la agencia, no una
// fuente de leads. Si algún día hay una hoja de Meta con contactos, se agrega acá.
var HOJAS = [
  { hoja: 'Formulario', fuente: 'formulario', origen: 'Google Ads' },
  { hoja: 'Brochure',   fuente: 'brochure',   origen: 'Google Ads' }
];

var _ULTIMO_ERROR = '';  // último rechazo del CRM, para poder mostrarlo en pantalla

// Resultado de la última corrida automática. Se guarda en las propiedades del
// script porque el disparador corre sin nadie mirando: sin este registro, un
// error se pierde en el log y la sincronización queda muerta en silencio durante
// días. "Ver estado" lo muestra.
var PROP_ULTIMA_CORRIDA = 'ULTIMA_CORRIDA';

var COL_MARCA = 'CRM';   // columna que agrega el script para marcar lo ya sincronizado
var LOTE      = 200;     // filas por request

// Proyecto Supabase del CRM. Se puede pisar desde el menú si alguna vez cambia.
var SUPABASE_URL_DEFAULT = 'https://wcpkpwxhqdcdljfwzcmy.supabase.co';

// Clave pública del proyecto (publishable), la misma que usa el HTML del CRM. No
// es un secreto: por sí sola no da acceso a nada — todo pasa por las políticas de
// la base, que a este script sólo le permiten insertar prospectos.
var SUPABASE_PUBLIC_KEY = 'sb_publishable_08decRYdCRUdtO5zogvJVg_VEBCN9pf';

// ── Menú dentro del Sheet ─────────────────────────────────────────────────────
// Toda la operación se hace desde acá: no hace falta volver a abrir el editor.
function onOpen() {
  SpreadsheetApp.getUi().createMenu('LABO CRM')
    .addItem('1 · Subir el histórico', 'menuHistorico')
    .addItem('2 · Activar sincronización automática', 'menuActivar')
    .addSeparator()
    .addItem('Sincronizar ahora', 'menuSincronizar')
    .addItem('Ver estado', 'menuEstado')
    .addItem('Probar conexión', 'menuProbar')
    .addItem('Desactivar sincronización', 'menuDesactivar')
    .addToUi();
  _limpiarCredencialesViejas();
}

/**
 * Borra las credenciales que guardaban las versiones anteriores del script. La
 * más importante es la service_role key: mientras siga ahí, cualquiera que pueda
 * editar este Sheet la puede leer. Se ejecuta sola al abrir el Sheet y en cada
 * sincronización, así que con pegar este archivo alcanza para limpiarla.
 */
function _limpiarCredencialesViejas() {
  try {
    var p = PropertiesService.getScriptProperties();
    ['SUPABASE_SERVICE_KEY', 'SYNC_EMAIL', 'SYNC_PASSWORD'].forEach(function (k) {
      if (p.getProperty(k)) { p.deleteProperty(k); Logger.log('Credencial vieja borrada: ' + k); }
    });
  } catch (e) { Logger.log('No se pudieron limpiar las credenciales viejas: ' + e); }
}

/**
 * Prueba que el Sheet pueda hablar con el CRM, y dice QUÉ falla. Un mensaje de
 * error que no se puede accionar obliga a ir a buscar el log: el código y el
 * detalle que devuelve la base van acá adentro.
 */
function menuProbar() {
  var ui = SpreadsheetApp.getUi();
  var r;
  try {
    r = _probarCRM();
  } catch (e) {
    ui.alert('No se pudo conectar',
      'No hubo respuesta del CRM. Puede ser la URL o un problema de red.\n\n' + e,
      ui.ButtonSet.OK);
    return;
  }
  if (r.code === 200) {
    ui.alert('✓ Conectado',
      'El Sheet llega al CRM y la carga de prospectos funciona.\n\n' +
      'Esta prueba usa el mismo camino que la sincronización real, con un lote ' +
      'vacío: si pasa, los leads entran.', ui.ButtonSet.OK);
    return;
  }
  var pista;
  if (r.code === 404) {
    pista = 'La función de carga no existe en este proyecto.\n' +
            'Falta correr supabase_prospectos_sync.sql en el SQL Editor de Supabase, ' +
            'o el proyecto configurado no es el del CRM.';
  } else if (r.code === 401 || r.code === 403) {
    pista = 'El CRM rechazó la clave pública. Puede que la hayan rotado o ' +
            'desactivado las claves legacy en Supabase.';
  } else {
    pista = 'Respuesta inesperada del CRM.';
  }
  ui.alert('No se pudo conectar',
    'El CRM respondió ' + r.code + '.\n\n' + pista + '\n\nDetalle:\n' + r.body,
    ui.ButtonSet.OK);
}

/**
 * Prueba de vida: llama a la función de carga con un lote VACÍO. Devuelve 0 y no
 * escribe nada, pero recorre exactamente el mismo camino que la sincronización de
 * verdad: URL, clave, existencia de la función y permiso para ejecutarla.
 *
 * La versión anterior probaba con una lectura (GET) y daba "conectado" aunque la
 * carga estuviera rota. Eso fue justamente lo que pasó: la prueba pasaba, y los
 * leads nuevos rebotaban sin que nadie se enterara. Una prueba tiene que ejercitar
 * el camino real o no prueba nada.
 */
function _probarCRM() {
  var cfg = _config();
  var resp = UrlFetchApp.fetch(cfg.url + '/rest/v1/rpc/labocomercial_prospectos_ingest', {
    method: 'post',
    contentType: 'application/json',
    headers: _headers(cfg),
    payload: JSON.stringify({ filas: [] }),
    muteHttpExceptions: true
  });
  return { code: resp.getResponseCode(), body: String(resp.getContentText() || '').slice(0, 400) };
}

/** Paso 1 del menú: sube todo lo que ya está cargado en el Sheet. */
function menuHistorico() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.alert('Subir el histórico',
    'Manda al CRM todas las filas de las hojas Formulario y Brochure.\n\n' +
    'Es seguro repetirlo: lo que ya está no se duplica ni se pisa.\n\n¿Seguimos?',
    ui.ButtonSet.YES_NO);
  if (r !== ui.Button.YES) return;
  _menuCorrer(function () { return sincronizarTodoElHistorico(); }, 'Histórico subido');
}

/** Paso 2 del menú: deja la sincronización corriendo sola. */
function menuActivar() {
  var ui = SpreadsheetApp.getUi();
  try {
    instalarDisparador();
    ui.alert('✓ Sincronización activada',
      'De acá en más los leads nuevos entran solos al CRM, cada 10 minutos.', ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('No se pudo activar', String(e), ui.ButtonSet.OK);
  }
}

function menuSincronizar() {
  _menuCorrer(function () { return sincronizarProspectos(); }, 'Sincronización lista');
}

function menuDesactivar() {
  var ui = SpreadsheetApp.getUi();
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sincronizarProspectos') { ScriptApp.deleteTrigger(t); n++; }
  });
  ui.alert(n ? 'Sincronización automática desactivada.' : 'No había ninguna sincronización activa.');
}

function menuEstado() {
  var ui = SpreadsheetApp.getUi();
  var props = PropertiesService.getScriptProperties();
  var pendiente = !!props.getProperty('SUPABASE_SERVICE_KEY');
  var auto = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'sincronizarProspectos';
  });
  var detalle = HOJAS.map(function (cfg) {
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(cfg.hoja);
    if (!sh) return '· ' + cfg.hoja + ': hoja no encontrada';
    var filas = Math.max(0, sh.getLastRow() - 1);
    var enc = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    var col = -1;
    for (var i = 0; i < enc.length; i++) if (_norm(enc[i]) === _norm(COL_MARCA)) col = i;
    var enviadas = 0;
    if (col >= 0 && filas > 0) {
      sh.getRange(2, col + 1, filas, 1).getValues().forEach(function (f) { if (String(f[0] || '').trim()) enviadas++; });
    }
    return '· ' + cfg.hoja + ': ' + enviadas + ' de ' + filas + ' en el CRM';
  }).join('\n');

  var ultima = props.getProperty(PROP_ULTIMA_CORRIDA) || 'todavía no corrió ninguna vez';

  ui.alert('Estado de la sincronización',
    (auto ? '✓ Sincronización automática activa (cada 10 min)' : '✗ Sincronización automática apagada (paso 2)') + '\n' +
    (pendiente ? '⚠ Todavía hay una clave vieja guardada: volvé a abrir el Sheet para que se borre.'
               : '✓ El script no guarda ninguna credencial') +
    '\n\nÚltima corrida: ' + ultima +
    '\n\n' + detalle, ui.ButtonSet.OK);
}

/** Corre una sincronización mostrando el resultado, sin dejar al usuario a ciegas. */
function _menuCorrer(fn, titulo) {
  var ui = SpreadsheetApp.getUi();
  _ULTIMO_ERROR = '';
  SpreadsheetApp.getActiveSpreadsheet().toast('Mandando filas al CRM…', 'LABO CRM', 10);
  try {
    var n = fn();
    if (_ULTIMO_ERROR) {
      ui.alert('El CRM rechazó la carga',
        (n ? ('Alcanzaron a entrar ' + n + ' fila(s) y después falló.\n\n') : '') + _ULTIMO_ERROR,
        ui.ButtonSet.OK);
      return;
    }
    ui.alert(titulo, n
      ? (n + ' fila(s) enviadas al CRM. Ya se ven en la pestaña Prospectos.')
      : 'No había filas nuevas para enviar.', ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('Hubo un problema', String(e), ui.ButtonSet.OK);
  }
}

// ── Punto de entrada: esto es lo que corre el disparador cada 10 minutos ──────
function sincronizarProspectos() {
  _limpiarCredencialesViejas();
  _ULTIMO_ERROR = '';
  var total = 0;
  HOJAS.forEach(function (cfg) {
    try {
      total += _sincronizarHoja(cfg, false);
    } catch (e) {
      Logger.log('Error en hoja "' + cfg.hoja + '": ' + e);
    }
  });
  _registrarCorrida(total);
  Logger.log('Sincronización terminada. Filas nuevas enviadas: ' + total);
  return total;
}

/** Deja por escrito cómo terminó la última corrida, para que "Ver estado" lo diga. */
function _registrarCorrida(total) {
  var sello = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yy HH:mm');
  var txt = _ULTIMO_ERROR
    ? ('✗ ' + sello + ' — FALLÓ: ' + _ULTIMO_ERROR.replace(/\s+/g, ' ').slice(0, 300))
    : ('✓ ' + sello + ' — ' + total + ' fila(s) nuevas');
  try {
    PropertiesService.getScriptProperties().setProperty(PROP_ULTIMA_CORRIDA, txt);
  } catch (e) {
    Logger.log('No se pudo guardar el estado de la corrida: ' + e);
  }
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

/** Chequeo de conectividad, para correr a mano desde el editor. */
function verificarConexion() {
  try {
    var r = _probarCRM();
    Logger.log('Prueba de conexión: ' + r.code + ' ' + r.body);
    return r.code === 200;
  } catch (e) {
    Logger.log('✗ ' + e);
    return false;
  }
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

  // Las marcas se acumulan y se escriben de una sola vez: con cientos de filas,
  // una escritura por celda es lo que haría que la carga histórica se pase del
  // límite de 6 minutos de Apps Script.
  var marcas = datos.map(function (fila) { return [fila[colMarca - 1] || '']; });
  var hoy = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd/MM/yy');
  var enviadas = 0;
  for (var d = 0; d < pendientes.length; d += LOTE) {
    var lote = pendientes.slice(d, d + LOTE);
    var ok = _postProspectos(supa, lote.map(function (p) { return p.payload; }));
    if (!ok) break;                                          // error de red/API: se reintenta en la próxima corrida

    lote.forEach(function (p) {
      var previa = marcas[p.fila - 2][0];
      // Una resincronización no pisa la marca original: la fecha que interesa es la
      // de cuándo entró al CRM por primera vez.
      marcas[p.fila - 2] = [previa || ('✓ ' + hoy)];
    });
    enviadas += lote.length;
  }
  if (enviadas) {
    sh.getRange(2, colMarca, marcas.length, 1).setValues(marcas);
    SpreadsheetApp.flush();
  }
  Logger.log('Hoja "' + cfg.hoja + '": ' + enviadas + ' filas enviadas.');
  return enviadas;
}

/**
 * Manda un lote de filas al CRM.
 *
 * La carga NO escribe directo en la tabla: entra por la función
 * labocomercial_prospectos_ingest (ver supabase_prospectos_sql más abajo). El
 * Sheet no tiene ningún permiso sobre la tabla de prospectos; la validación y la
 * deduplicación ocurren adentro de la función, que sí puede leer la tabla para
 * resolver el "on conflict".
 *
 * Por qué así: insertar directo con "on conflict" exige poder leer la fila que ya
 * existe, y este script no puede leer (ni debe). Esa combinación hacía rebotar el
 * lote entero con un error de RLS. Ver supabase_prospectos_sync.sql.
 */
function _postProspectos(supa, filas) {
  var resp = UrlFetchApp.fetch(supa.url + '/rest/v1/rpc/labocomercial_prospectos_ingest', {
    method: 'post',
    contentType: 'application/json',
    headers: _headers(supa),
    payload: JSON.stringify({ filas: filas }),
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  if (code < 200 || code >= 300) {
    _ULTIMO_ERROR = 'El CRM respondió ' + code + ':\n' + String(resp.getContentText() || '').slice(0, 400);
    Logger.log(_ULTIMO_ERROR);
    return false;
  }
  return true;
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
    responsable:       _vendedor(v('responsable')),
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

// Marcas de acento (rango Unicode 0300-036F). Se arma con fromCharCode para que el
// archivo no lleve caracteres invisibles que se pierdan al copiarlo y pegarlo.
var _RE_TILDES = new RegExp('[' + String.fromCharCode(768) + '-' + String.fromCharCode(879) + ']', 'g');

function _norm(s) {
  return String(s === null || s === undefined ? '' : s)
    .normalize('NFD').replace(_RE_TILDES, '')            // saca acentos
    .toLowerCase().replace(/[^a-z0-9]/g, '');           // saca espacios, ¿?, °, etc.
}
// Vendedores del CRM. En el Sheet se anota el nombre corto ("Hector"): se traduce
// al nombre completo para que el prospecto quede asignado de verdad.
var VENDEDORES = ['Pablo Spinetto', 'Leandro Seoane', 'Hector Bermudez',
                  'Victoria Lopez Aybar', 'Matias Formica'];

function _vendedor(v) {
  var n = _norm(v);
  if (!n) return '';
  for (var i = 0; i < VENDEDORES.length; i++) if (_norm(VENDEDORES[i]) === n) return VENDEDORES[i];
  var cand = VENDEDORES.filter(function (x) { return _norm(x).indexOf(n) === 0; });
  return cand.length === 1 ? cand[0] : _txt(v);
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
  var url = (p.getProperty('SUPABASE_URL') || SUPABASE_URL_DEFAULT).replace(/\/+$/, '');
  return { url: url };
}

/**
 * La clave del proyecto va sólo en 'apikey'. No se manda como Authorization: eso
 * funcionaba porque la clave legacy es un JWT, pero las claves nuevas
 * (sb_publishable_…) no lo son y el header las haría rebotar. Sin Authorization,
 * la petición entra como anónima, que es exactamente lo que necesita el Sheet.
 */
function _headers(cfg, prefer) {
  var h = { 'apikey': SUPABASE_PUBLIC_KEY };
  if (prefer) h['Prefer'] = prefer;
  return h;
}
