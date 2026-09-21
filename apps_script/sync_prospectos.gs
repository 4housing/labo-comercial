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
 * acceso de edición puede leer las credenciales guardadas en el script. Por eso
 * acá NO va la service_role key (que saltea RLS y da control total de la base).
 * El script entra como una cuenta de Supabase que SÓLO puede insertar prospectos:
 * si la credencial se filtra, no se puede leer el pipeline ni modificar nada.
 * Ver supabase_prospectos_sync.sql.
 *
 * Reglas de oro:
 *  - Las credenciales NO van en este archivo: se cargan desde el menú y quedan
 *    guardadas en las Propiedades del Script.
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

// Proyecto Supabase del CRM. Se puede pisar desde el menú si alguna vez cambia.
var SUPABASE_URL_DEFAULT = 'https://wcpkpwxhqdcdljfwzcmy.supabase.co';

// Clave pública del proyecto (anon). No es un secreto: viaja en el HTML del CRM y
// por sí sola no da acceso a nada — todo pasa por las políticas de seguridad de la
// base, que dependen de con qué cuenta se entra.
var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndjcGtwd3hocWRjZGxqZnd6Y215Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEwNDM4NDAsImV4cCI6MjA5NjYxOTg0MH0.MSTk46VAwdAsn5qNBdrHmGIiLYyN-rAyAZC72xZW3D4';

// ── Menú dentro del Sheet ─────────────────────────────────────────────────────
// Toda la operación se hace desde acá: no hace falta volver a abrir el editor.
function onOpen() {
  SpreadsheetApp.getUi().createMenu('LABO CRM')
    .addItem('1 · Conectar con el CRM', 'menuConfigurar')
    .addItem('2 · Subir el histórico', 'menuHistorico')
    .addItem('3 · Activar sincronización automática', 'menuActivar')
    .addSeparator()
    .addItem('Sincronizar ahora', 'menuSincronizar')
    .addItem('Ver estado', 'menuEstado')
    .addItem('Desactivar sincronización', 'menuDesactivar')
    .addToUi();
}

/** Paso 1: pide las credenciales de la cuenta de sincronización y prueba la conexión. */
function menuConfigurar() {
  var ui = SpreadsheetApp.getUi();
  var props = PropertiesService.getScriptProperties();
  var urlActual = props.getProperty('SUPABASE_URL') || SUPABASE_URL_DEFAULT;

  var r1 = ui.prompt('Conectar con el CRM (1 de 3)',
    'URL del proyecto Supabase.\n\nSi es el CRM de siempre, dejá la que está y dale Aceptar:\n' + urlActual,
    ui.ButtonSet.OK_CANCEL);
  if (r1.getSelectedButton() !== ui.Button.OK) return;
  var url = (r1.getResponseText() || '').trim() || urlActual;

  var r2 = ui.prompt('Conectar con el CRM (2 de 3)',
    'Mail de la cuenta de sincronización.\n\n' +
    'Es una cuenta de servicio que sólo puede cargar prospectos: no puede leer ni ' +
    'modificar el resto del CRM. La crea el equipo de 4housing en Supabase.',
    ui.ButtonSet.OK_CANCEL);
  if (r2.getSelectedButton() !== ui.Button.OK) return;
  var mail = (r2.getResponseText() || '').trim();
  if (!mail) { ui.alert('No pusiste ningún mail. No se guardó nada.'); return; }

  var r3 = ui.prompt('Conectar con el CRM (3 de 3)', 'Contraseña de esa cuenta.',
    ui.ButtonSet.OK_CANCEL);
  if (r3.getSelectedButton() !== ui.Button.OK) return;
  var pass = r3.getResponseText() || '';
  if (!pass) { ui.alert('No pusiste ninguna contraseña. No se guardó nada.'); return; }

  props.setProperty('SUPABASE_URL', url.replace(/\/+$/, ''));
  props.setProperty('SYNC_EMAIL', mail);
  props.setProperty('SYNC_PASSWORD', pass);
  // Restos de la versión anterior, que guardaba la llave maestra del proyecto.
  props.deleteProperty('SUPABASE_SERVICE_KEY');

  try {
    if (verificarConexion()) {
      ui.alert('✓ Conectado',
        'La conexión con el CRM funciona.\n\nAhora corré el paso 2 (Subir el histórico).',
        ui.ButtonSet.OK);
    } else {
      ui.alert('No se pudo conectar',
        'El mail o la contraseña no son correctos, o la cuenta todavía no existe. ' +
        'Pedíselos al equipo de 4housing y volvé a correr "1 · Conectar con el CRM".',
        ui.ButtonSet.OK);
    }
  } catch (e) {
    ui.alert('No se pudo conectar', String(e), ui.ButtonSet.OK);
  }
}

/** Paso 2: sube todo lo que ya está cargado en el Sheet. */
function menuHistorico() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.alert('Subir el histórico',
    'Manda al CRM todas las filas de las hojas Formulario, Brochure y Landing Meta.\n\n' +
    'Es seguro repetirlo: lo que ya está no se duplica ni se pisa.\n\n¿Seguimos?',
    ui.ButtonSet.YES_NO);
  if (r !== ui.Button.YES) return;
  _menuCorrer(function () { return sincronizarTodoElHistorico(); }, 'Histórico subido');
}

/** Paso 3: deja la sincronización corriendo sola. */
function menuActivar() {
  var ui = SpreadsheetApp.getUi();
  try {
    _config();                      // falla temprano si todavía no se configuró
    instalarDisparador();
    ui.alert('✓ Sincronización activada',
      'De acá en más los leads nuevos entran solos al CRM, cada 10 minutos.', ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('Falta conectar', String(e), ui.ButtonSet.OK);
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
  var conectado = !!(props.getProperty('SYNC_EMAIL') && props.getProperty('SYNC_PASSWORD'));
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

  ui.alert('Estado de la sincronización',
    (conectado ? '✓ Conectado con el CRM' : '✗ Todavía no está conectado (paso 1)') + '\n' +
    (auto ? '✓ Sincronización automática activa (cada 10 min)' : '✗ Sincronización automática apagada (paso 3)') +
    '\n\n' + detalle, ui.ButtonSet.OK);
}

/** Corre una sincronización mostrando el resultado, sin dejar al usuario a ciegas. */
function _menuCorrer(fn, titulo) {
  var ui = SpreadsheetApp.getUi();
  try {
    _config();
  } catch (e) {
    ui.alert('Falta conectar', String(e), ui.ButtonSet.OK);
    return;
  }
  SpreadsheetApp.getActiveSpreadsheet().toast('Mandando filas al CRM…', 'LABO CRM', 10);
  try {
    var n = fn();
    ui.alert(titulo, n
      ? (n + ' fila(s) enviadas al CRM. Ya se ven en la pestaña Prospectos.')
      : 'No había filas nuevas para enviar.', ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('Hubo un problema', String(e), ui.ButtonSet.OK);
  }
}

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

/**
 * Chequeo de configuración: valida que la cuenta de sincronización pueda entrar.
 * No se comprueba con una lectura porque esta cuenta, a propósito, no puede leer
 * nada: lo único que sabe hacer es insertar prospectos.
 */
function verificarConexion() {
  try {
    var ok = !!_token(_config());
    Logger.log(ok ? '✓ Conexión OK con el CRM.' : '✗ No se pudo entrar.');
    return ok;
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
 * Manda un lote de filas. 'return=minimal' es a propósito: la cuenta de
 * sincronización sólo puede insertar, así que no puede pedir que le devuelvan lo
 * insertado. 'ignore-duplicates' hace que las filas ya cargadas se salteen solas.
 */
function _postProspectos(supa, filas) {
  var resp = UrlFetchApp.fetch(supa.url + '/rest/v1/labocomercial_prospectos', {
    method: 'post',
    contentType: 'application/json',
    headers: _headers(supa, 'resolution=ignore-duplicates,return=minimal'),
    payload: JSON.stringify(filas),
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  if (code < 200 || code >= 300) {
    Logger.log('El CRM respondió ' + code + ': ' + resp.getContentText());
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
  var email = p.getProperty('SYNC_EMAIL') || '';
  var password = p.getProperty('SYNC_PASSWORD') || '';
  if (!url || !email || !password) {
    throw new Error('Todavía no está conectado con el CRM. Andá al menú "LABO CRM" ' +
                    'del Sheet y corré "1 · Conectar con el CRM".');
  }
  return { url: url, email: email, password: password };
}

/**
 * Entra a Supabase con la cuenta de sincronización y devuelve su token. Dura una
 * hora y cada corrida del script es de segundos, así que se pide uno nuevo por
 * corrida y no se guarda en ningún lado.
 */
var _tokenCache = null;
function _token(cfg) {
  if (_tokenCache) return _tokenCache;
  var resp = UrlFetchApp.fetch(cfg.url + '/auth/v1/token?grant_type=password', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'apikey': SUPABASE_ANON_KEY },
    payload: JSON.stringify({ email: cfg.email, password: cfg.password }),
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) {
    throw new Error('No se pudo entrar al CRM con la cuenta de sincronización (' +
                    resp.getResponseCode() + '). Revisá el mail y la contraseña en ' +
                    'el menú "LABO CRM" → "1 · Conectar con el CRM".');
  }
  var tok = JSON.parse(resp.getContentText()).access_token;
  if (!tok) throw new Error('El CRM no devolvió un token de acceso.');
  _tokenCache = tok;
  return tok;
}

function _headers(cfg, prefer) {
  var h = { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + _token(cfg) };
  if (prefer) h['Prefer'] = prefer;
  return h;
}
