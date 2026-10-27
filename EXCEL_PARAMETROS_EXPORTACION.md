# Hoja `Parametros` del Excel de costeo — parámetros globales + exportación

El cotizador ya lee del Excel los **materiales, cómputos, TC y montaje**. Para cerrar
el circuito y que **todo** salga del Excel (incluida la exportación a Uruguay), agregá
una hoja nueva llamada exactamente **`Parametros`** (sin acento) con esta estructura.

> Es segura y opcional: si la hoja o una celda no existen, el import **no cambia** ese
> valor (mantiene el actual). Lo que cargues acá pisa lo que haya en la plataforma al
> subir el Excel, así el Excel queda siempre como fuente de verdad.

## Escalares (columna B)

| Celda | Concepto | Valor hoy | Formato |
|-------|----------|-----------|---------|
| B2  | Margen módulo | 0.35 | proporción (0.35 = 35%) |
| B3  | Margen opcional | 0.15 | proporción |
| B4  | Gastos (divisor) | 0.957 | proporción |
| B5  | Prorrateable infraestructura | 0.08 | proporción |
| B6  | Prorrateable consumibles | 0.04 | proporción |
| B7  | Prorrateable seguridad e higiene | 0.01 | proporción |
| B8  | IVA | 0.21 | proporción |
| B9  | IIBB | 0.03 | proporción |
| B10 | IDC | 0.006 | proporción |
| B11 | Ganancias | 0.20 | proporción |
| B12 | USD/km/camión — **nacional** | 5 | costo USD |
| B13 | USD/km/camión — **export** | 10 *(preliminar)* | costo USD |
| B14 | Aduana / despacho export (fijo por operación) | 1500 *(preliminar)* | costo USD |

La columna A es libre para que pongas las etiquetas (el import lee solo la B).

## Grilla por modelo (encabezado en fila 16, datos en 17–19)

Columnas: **C = SE · D = S · E = M · F = L · G = XL**

| Fila | Concepto | SE | S | M | L | XL |
|------|----------|----|----|----|----|----|
| 17 | Camiones por modelo | 2 | 2 | 2 | 3 | 4 |
| 18 | Platea/fundación **export** (costo) | *preliminar* | | | | |
| 19 | Montaje **export** (costo) | *preliminar* | | | | |

## Notas importantes

- **Son costos.** El motor les aplica el markup opcional `(1 + margen_opcional) / gastos`
  (hoy ≈ ×1,2017) para obtener el precio de venta. Cargás costo, la plataforma calcula precio.
- **Flete export**: usa `USD/km/camión export × km × camiones` (misma mecánica que el nacional,
  distinta tarifa). No se le aplica el descuento del 30% por distancia.
- **Aduana**: un único valor fijo por operación, igual para todos los modelos.
- **Platea export** = 0 si la fundación la hace el cliente en destino.
- **Lo que NO cambia**: TC sigue en `Análisis!K2`, el montaje nacional en la hoja
  `Montaje x Rango`, y los materiales/cómputos en sus hojas de siempre.
- Estos valores también se pueden editar desde **⚙ Actualizar Costos** (sección
  "Exportación a Uruguay") como respaldo, pero lo recomendado es mantenerlos en el Excel.
