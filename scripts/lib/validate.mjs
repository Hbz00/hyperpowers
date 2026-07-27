/**
 * A compact JSON Schema validator covering the subset Hyperpowers' own schemas use.
 *
 * Why not a library: this code runs inside hook subprocesses on whatever Node the user has,
 * with no install step. A plugin that needs `npm install` to enforce its safety invariants
 * does not enforce them on first run, which is exactly when it matters most.
 *
 * Supported: type (incl. unions), const, enum, required, properties, additionalProperties,
 * items, minItems/maxItems, minLength/maxLength, minimum/maximum, pattern, allOf, anyOf,
 * oneOf, not, if/then/else, $ref to local $defs.
 *
 * Unsupported keywords are ignored rather than silently passing something they would reject,
 * so schemas here deliberately stay inside the supported subset. `assertSupported` fails loudly
 * if a schema drifts outside it.
 */

/**
 * Keywords this validator actually enforces.
 *
 * A keyword listed here but not implemented below is the worst possible state: `assertSupported`
 * stays silent, so a schema author trusts a constraint that does nothing, and the tests confirm
 * the schema is "inside the supported subset". `propertyNames` and `prefixItems` sat here
 * unimplemented — every value passed them. This list must therefore be a claim about `validate`,
 * not an aspiration; the shipped test walks each entry and fails if it is inert.
 */
const SUPPORTED = new Set([
  '$schema', '$id', '$ref', '$defs', 'title', 'description', 'default', 'examples',
  'type', 'const', 'enum', 'required', 'properties', 'additionalProperties',
  'items', 'minItems', 'maxItems', 'uniqueItems',
  'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else',
]);

/**
 * Report every keyword a schema uses that this validator would silently ignore.
 *
 * Traversal has to reach every subschema `validate` can reach, or the check is decorative: a
 * `patternProperties` hidden in `$defs` and pulled in by `$ref` was invisible here while being
 * fully ignored at validation time.
 */
export function assertSupported(schema, path = '#') {
  if (!schema || typeof schema !== 'object') return [];
  const problems = [];
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED.has(key)) problems.push(`${path}: unsupported keyword '${key}'`);
  }
  for (const [key, value] of Object.entries(schema.properties ?? {})) {
    problems.push(...assertSupported(value, `${path}/properties/${key}`));
  }
  for (const [key, value] of Object.entries(schema.$defs ?? {})) {
    problems.push(...assertSupported(value, `${path}/$defs/${key}`));
  }
  if (schema.items) problems.push(...assertSupported(schema.items, `${path}/items`));
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    problems.push(...assertSupported(schema.additionalProperties, `${path}/additionalProperties`));
  }
  for (const key of ['if', 'then', 'else', 'not']) {
    if (schema[key]) problems.push(...assertSupported(schema[key], `${path}/${key}`));
  }
  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    (schema[key] ?? []).forEach((s, i) => problems.push(...assertSupported(s, `${path}/${key}/${i}`)));
  }
  return problems;
}

/** The keyword list, exported so a test can prove each entry actually rejects something. */
export const SUPPORTED_KEYWORDS = Object.freeze([...SUPPORTED]);

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function typeMatches(value, expected) {
  const actual = typeOf(value);
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  if (expected === 'integer') return actual === 'integer';
  return actual === expected;
}

function resolveRef(ref, root) {
  if (!ref.startsWith('#/')) return null;
  let node = root;
  for (const part of ref.slice(2).split('/')) {
    node = node?.[decodeURIComponent(part.replace(/~1/g, '/').replace(/~0/g, '~'))];
    if (node === undefined) return null;
  }
  return node;
}

/**
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validate(value, schema, { root = schema, path = '' } = {}) {
  const errors = [];
  const at = path || '(root)';

  if (!schema || typeof schema !== 'object') return { valid: true, errors };

  if (schema.$ref) {
    const target = resolveRef(schema.$ref, root);
    if (!target) return { valid: false, errors: [`${at}: unresolvable $ref ${schema.$ref}`] };
    return validate(value, target, { root, path });
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(value, t))) {
      errors.push(`${at}: expected ${types.join(' or ')}, got ${typeOf(value)}`);
      return { valid: false, errors }; // further checks would be noise
    }
  }

  if (schema.const !== undefined && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    errors.push(`${at}: must equal ${JSON.stringify(schema.const)}`);
  }

  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push(`${at}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}, got ${JSON.stringify(value)}`);
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${at}: string shorter than minLength ${schema.minLength} (got ${value.length})`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${at}: string longer than maxLength ${schema.maxLength}`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${at}: does not match pattern ${schema.pattern}`);
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: below minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: above maximum ${schema.maximum}`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) errors.push(`${at}: must exceed ${schema.exclusiveMinimum}`);
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) errors.push(`${at}: must be below ${schema.exclusiveMaximum}`);
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${at}: needs at least ${schema.minItems} item(s), got ${value.length}`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${at}: allows at most ${schema.maxItems} item(s), got ${value.length}`);
    }
    if (schema.uniqueItems) {
      const seen = new Set(value.map((v) => JSON.stringify(v)));
      if (seen.size !== value.length) errors.push(`${at}: items must be unique`);
    }
    if (schema.items) {
      value.forEach((item, i) => {
        errors.push(...validate(item, schema.items, { root, path: `${at}[${i}]` }).errors);
      });
    }
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(`${at}: missing required property '${key}'`);
      }
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(...validate(value[key], sub, { root, path: `${at}.${key}` }).errors);
      }
    }
    if (schema.additionalProperties === false) {
      const known = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(value)) {
        if (!known.has(key)) errors.push(`${at}: unexpected property '${key}'`);
      }
    } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      const known = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(value)) {
        if (!known.has(key)) {
          errors.push(...validate(value[key], schema.additionalProperties, { root, path: `${at}.${key}` }).errors);
        }
      }
    }
  }

  for (const sub of schema.allOf ?? []) {
    errors.push(...validate(value, sub, { root, path }).errors);
  }
  if (schema.anyOf && !schema.anyOf.some((sub) => validate(value, sub, { root, path }).valid)) {
    errors.push(`${at}: does not match any of the allowed shapes`);
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((sub) => validate(value, sub, { root, path }).valid).length;
    if (matches !== 1) errors.push(`${at}: must match exactly one shape, matched ${matches}`);
  }
  if (schema.not && validate(value, schema.not, { root, path }).valid) {
    errors.push(`${at}: matches a forbidden shape`);
  }
  if (schema.if) {
    const branch = validate(value, schema.if, { root, path }).valid ? schema.then : schema.else;
    if (branch) errors.push(...validate(value, branch, { root, path }).errors);
  }

  return { valid: errors.length === 0, errors };
}

/** Convenience: throw with a readable, actionable message. */
export function assertValid(value, schema, label = 'value') {
  const { valid, errors } = validate(value, schema);
  if (!valid) {
    throw new Error(`${label} failed schema validation:\n  - ${errors.join('\n  - ')}`);
  }
  return value;
}
