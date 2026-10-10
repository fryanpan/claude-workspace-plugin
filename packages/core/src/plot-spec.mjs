// plot-spec.mjs: the canonical copy, in claude-workspaces packages/core/src. Version 1 (2026-10-10). Other repos copy these bytes verbatim and compare this line.
// @ts-check

/**
 * The `<PlotChart>` spec turned into an Observable Plot chart, without
 * evaluating anything: every name the spec gives is looked up in an
 * allowlist, every `data` reference is a key into the spec's own `data` or an
 * inline array, and every other string is handed to Plot as the field name or
 * constant it already is.
 *
 * Each mark is `Plot[mark](data, Plot[pointer](Plot[transform](options)))`,
 * leaving out whichever wrapper the mark does not name. The pointer wraps the
 * transform, so a tip sees the stacked positions. The chart is
 * `Plot.plot({ ...options, marks })`.
 *
 * The whole spec is checked before any Plot function is called, so a bad spec
 * draws nothing and throws a `PlotSpecError` whose message the caller shows.
 *
 * Plain JavaScript importing nothing: sf-works runs it under Node as it is.
 */

export const PLOT_SPEC_VERSION = 1;

export const PLOT_MARKS = Object.freeze([
  'areaY',
  'areaX',
  'lineY',
  'lineX',
  'barY',
  'barX',
  'dot',
  'ruleY',
  'ruleX',
  'text',
  'tip',
  'rectY',
  'cell',
  'tickX',
  'tickY',
]);

export const PLOT_TRANSFORMS = Object.freeze([
  'stackY',
  'stackY1',
  'stackY2',
  'stackX',
  'stackX1',
  'stackX2',
  'binX',
  'groupX',
  'groupY',
]);

export const PLOT_POINTERS = Object.freeze(['pointerX', 'pointerY']);

/** Options a mark may not take: a link's URL comes from the data, and the
 *  data is somebody's document text. */
const REFUSED_MARK_OPTIONS = Object.freeze(['href', 'target']);

/**
 * @typedef {'bad-spec' | 'unknown-mark' | 'unknown-transform' | 'unknown-pointer' | 'missing-data' | 'refused-option'} PlotSpecErrorCode
 */

/**
 * @typedef {object} PlotMarkSpec
 * @property {string} mark
 * @property {string | unknown[]} [data] A key into the spec's `data`, or the rows themselves.
 * @property {string} [transform]
 * @property {string} [pointer]
 * @property {Record<string, unknown>} [options]
 */

/**
 * @typedef {object} PlotSpec
 * @property {Record<string, unknown>} [data]
 * @property {Record<string, unknown>} [options]
 * @property {unknown} marks
 */

/**
 * The Plot module, or any object carrying the functions a spec names.
 * @typedef {Record<string, unknown>} PlotModule
 */

/** Why a spec cannot be drawn, in words a reader can act on. */
export class PlotSpecError extends Error {
  /**
   * @param {PlotSpecErrorCode} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'PlotSpecError';
    /** @type {PlotSpecErrorCode} */
    this.code = code;
  }
}

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * @param {readonly string[]} list
 * @param {unknown} name
 * @returns {name is string}
 */
const allowed = (list, name) => typeof name === 'string' && list.includes(name);

/**
 * @param {PlotModule} Plot
 * @param {string} name
 * @returns {(...args: unknown[]) => unknown}
 */
function fn(Plot, name) {
  const f = Plot[name];
  if (typeof f !== 'function') {
    throw new PlotSpecError('bad-spec', `This Plot has no ${name}`);
  }
  return /** @type {(...args: unknown[]) => unknown} */ (f);
}

/**
 * Every mark of `spec`, checked against the allowlists and its data resolved,
 * with no Plot function called.
 * @param {PlotSpec} spec
 * @returns {Array<{ mark: string, data: unknown[], transform?: string, pointer?: string, options: Record<string, unknown> }>}
 */
export function checkPlotSpec(spec) {
  if (!isRecord(spec)) throw new PlotSpecError('bad-spec', 'The chart has no spec');
  const data = spec.data === undefined ? {} : spec.data;
  if (!isRecord(data))
    throw new PlotSpecError('bad-spec', '`data` must be an object of named rows');
  if (spec.options !== undefined && !isRecord(spec.options)) {
    throw new PlotSpecError('bad-spec', '`options` must be an object');
  }
  if (!Array.isArray(spec.marks) || spec.marks.length === 0) {
    throw new PlotSpecError('bad-spec', '`marks` must be a list of at least one mark');
  }
  return spec.marks.map((m, i) => {
    const at = `Mark ${i + 1}`;
    if (!isRecord(m)) throw new PlotSpecError('bad-spec', `${at} is not an object`);
    if (!allowed(PLOT_MARKS, m.mark)) {
      throw new PlotSpecError('unknown-mark', `${at}: unknown mark ${JSON.stringify(m.mark)}`);
    }
    if (m.transform !== undefined && !allowed(PLOT_TRANSFORMS, m.transform)) {
      throw new PlotSpecError(
        'unknown-transform',
        `${at}: unknown transform ${JSON.stringify(m.transform)}`,
      );
    }
    if (m.pointer !== undefined && !allowed(PLOT_POINTERS, m.pointer)) {
      throw new PlotSpecError(
        'unknown-pointer',
        `${at}: unknown pointer ${JSON.stringify(m.pointer)}`,
      );
    }
    /** @type {unknown[]} */
    let rows;
    if (Array.isArray(m.data)) rows = m.data;
    else if (typeof m.data === 'string') {
      const named = Object.hasOwn(data, m.data) ? data[m.data] : undefined;
      if (!Array.isArray(named)) {
        throw new PlotSpecError('missing-data', `${at}: no data named ${JSON.stringify(m.data)}`);
      }
      rows = named;
    } else {
      throw new PlotSpecError('missing-data', `${at} has no data`);
    }
    const options = m.options === undefined ? {} : m.options;
    if (!isRecord(options)) throw new PlotSpecError('bad-spec', `${at}: options must be an object`);
    for (const key of REFUSED_MARK_OPTIONS) {
      if (Object.hasOwn(options, key)) {
        throw new PlotSpecError('refused-option', `${at}: the ${key} option is not allowed`);
      }
    }
    return {
      mark: m.mark,
      data: rows,
      ...(m.transform === undefined ? {} : { transform: m.transform }),
      ...(m.pointer === undefined ? {} : { pointer: m.pointer }),
      options: { ...options },
    };
  });
}

/**
 * The chart `spec` describes, drawn by `Plot`. Throws a `PlotSpecError`, having
 * called no Plot function, when the spec names anything outside the
 * allowlists or a `data` key it does not carry.
 * @param {PlotModule} Plot
 * @param {PlotSpec} spec
 * @returns {Element}
 */
export function buildPlot(Plot, spec) {
  // Every function is found before any is called.
  const steps = checkPlotSpec(spec).map((m) => ({
    m,
    mark: fn(Plot, m.mark),
    transform: m.transform ? fn(Plot, m.transform) : undefined,
    pointer: m.pointer ? fn(Plot, m.pointer) : undefined,
  }));
  const plot = fn(Plot, 'plot');
  const marks = steps.map(({ m, mark, transform, pointer }) => {
    let options = /** @type {unknown} */ (m.options);
    if (transform) options = transform(options);
    if (pointer) options = pointer(options);
    return mark(m.data, options);
  });
  return /** @type {Element} */ (plot({ ...(spec.options ?? {}), marks }));
}
