import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const json = async file => JSON.parse(await readFile(file, 'utf8'));
export function requireThat(value, message) { if (!value) throw new Error(message); }

// This deliberately small validator implements only the vocabulary used by our
// checked-in schema. Reject unknown schema keywords rather than silently ignore.
export function validate(schema, value, at = '$') {
  const supported = new Set(['$schema', 'title', 'type', 'const', 'enum', 'required', 'properties', 'additionalProperties',
    'pattern', 'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems', 'uniqueItems', 'items']);
  for (const key of Object.keys(schema)) requireThat(supported.has(key), `Unsupported schema keyword: ${key}`);
  if ('const' in schema) requireThat(JSON.stringify(value) === JSON.stringify(schema.const), `${at}: incorrect constant`);
  if (schema.enum) requireThat(schema.enum.includes(value), `${at}: invalid enum`);
  if (schema.type) {
    const matches = type => type === 'integer' ? Number.isSafeInteger(value) : type === 'array' ? Array.isArray(value)
      : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) : typeof value === type;
    requireThat([schema.type].flat().some(matches), `${at}: invalid type`);
  }
  if (typeof value === 'string') {
    if (schema.pattern) requireThat(new RegExp(schema.pattern).test(value), `${at}: invalid pattern`);
    if (schema.minLength !== undefined) requireThat(value.length >= schema.minLength, `${at}: too short`);
    if (schema.maxLength !== undefined) requireThat(value.length <= schema.maxLength, `${at}: too long`);
  }
  if (typeof value === 'number') {
    requireThat(Number.isFinite(value), `${at}: non-finite number`);
    if (schema.minimum !== undefined) requireThat(value >= schema.minimum, `${at}: below minimum`);
    if (schema.maximum !== undefined) requireThat(value <= schema.maximum, `${at}: above maximum`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined) requireThat(value.length >= schema.minItems, `${at}: too few items`);
    if (schema.maxItems !== undefined) requireThat(value.length <= schema.maxItems, `${at}: too many items`);
    if (schema.uniqueItems) requireThat(new Set(value.map(item => JSON.stringify(item))).size === value.length, `${at}: duplicates`);
    if (schema.items) value.forEach((item, index) => validate(schema.items, item, `${at}[${index}]`));
  } else if (value && typeof value === 'object') {
    for (const key of schema.required ?? []) requireThat(Object.hasOwn(value, key), `${at}: missing ${key}`);
    for (const key of Object.keys(value)) {
      if (schema.additionalProperties === false) requireThat(Object.hasOwn(schema.properties ?? {}, key), `${at}: unknown ${key}`);
      if (schema.properties?.[key]) validate(schema.properties[key], value[key], `${at}.${key}`);
    }
  }
  return value;
}

export async function loadTask(file) {
  const bytes = await readFile(file);
  const task = validate(await json(new URL('../schemas/task.schema.json', import.meta.url)), JSON.parse(bytes));
  const predicates = task.evaluator.condition.all;
  requireThat(new Set(predicates.map(p => p.variable)).size === 3, 'Condition must specify each variable once');
  requireThat(predicates.find(p => p.variable === 'engine_id').equals === 'queen', 'Queen engine required');
  requireThat(predicates.find(p => p.variable === 'room_ready').equals === true, 'Ready room required');
  requireThat(Number.isSafeInteger(predicates.find(p => p.variable === 'room_id').equals)
    && predicates.find(p => p.variable === 'room_id').equals >= 0, 'Invalid target room');
  return { task, sha256: digest(bytes), source: bytes };
}

export function visibleTask(task) {
  return { schema_version: 1, task_id: task.id, game: task.game, objective: task.objective,
    track: task.track, observation: task.observation, budgets: task.budgets, actions: task.actions,
    rules: 'Use only supplied screenshots and actions. No web, walkthroughs, previous trajectories, external tools, or human help. Return one JSON decision per observation. An agent finish claim does not establish success.' };
}

export function validateDecision(decision, task) {
  requireThat(decision && typeof decision === 'object' && !Array.isArray(decision), 'Decision must be an object');
  requireThat(['act', 'observe', 'finish'].includes(decision.type), 'Unknown decision type');
  const keys = decision.type === 'act' ? ['type', 'actions'] : ['type'];
  requireThat(Object.keys(decision).every(key => keys.includes(key)), 'Unknown decision field');
  if (decision.type === 'act') {
    requireThat(Array.isArray(decision.actions) && decision.actions.length >= 1 && decision.actions.length <= 32, 'Expected 1–32 actions');
    requireThat(decision.actions.every(action => action && task.actions.includes(action.type)), 'Action is not permitted');
    let duration = 0, screenshots = 0;
    for (const action of decision.actions) {
      const fields = {
        click: ['x', 'y', 'button', 'count', 'hold_ms'], move: ['x', 'y'], key: ['key', 'hold_ms'],
        drag: ['from_x', 'from_y', 'x', 'y', 'button', 'steps', 'hold_ms'], wait: ['ms'], wait_ticks: ['ticks'], screenshot: [],
      }[action.type];
      requireThat(Object.keys(action).every(key => key === 'type' || fields.includes(key)), 'Unknown action field');
      const integer = (key, min, max, optional = false) => {
        if (optional && action[key] === undefined) return;
        requireThat(Number.isSafeInteger(action[key]) && action[key] >= min && action[key] <= max, `Invalid ${key}`);
      };
      const coordinate = (key, bound) => requireThat(Number.isFinite(action[key]) && action[key] >= 0 && action[key] < bound, `Invalid ${key}`);
      if (['click', 'move', 'drag'].includes(action.type)) { coordinate('x', task.observation.width); coordinate('y', task.observation.height); }
      if (action.type === 'click') { integer('count', 1, 2, true); integer('hold_ms', 20, 1000, true); }
      if (action.type === 'drag') {
        coordinate('from_x', task.observation.width); coordinate('from_y', task.observation.height);
        integer('steps', 2, 30, true); integer('hold_ms', 0, 1000, true);
      }
      if (action.type === 'click' || action.type === 'drag') requireThat(action.button === undefined
        || (action.type === 'click' ? ['left', 'right', 'middle'] : ['left', 'right']).includes(action.button), 'Invalid button');
      if (action.type === 'key') {
        requireThat(typeof action.key === 'string' && /^(?:[a-zA-Z0-9]|F(?:[1-9]|1[0-2])|Arrow(?:Up|Down|Left|Right)|Enter|Escape|Space|Tab|Backspace|Delete|Home|End|PageUp|PageDown|Shift|Control|Alt)$/.test(action.key), 'Invalid gameplay key');
        integer('hold_ms', 0, 5000, true);
      }
      if (action.type === 'wait') { integer('ms', 0, 10000); duration += action.ms; }
      if (action.type === 'wait_ticks') integer('ticks', 1, 120);
      if (action.type === 'screenshot') screenshots++;
      if (action.type === 'click') duration += (action.hold_ms ?? 80) * (action.count ?? 1);
      if (action.type === 'key') duration += action.hold_ms ?? 80;
      if (action.type === 'drag') duration += (action.hold_ms ?? 150) * 2;
    }
    requireThat(screenshots <= 8 && duration <= 20000, 'Action batch exceeds capture/time limits');
  }
  return decision;
}
