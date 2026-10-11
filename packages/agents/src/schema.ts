/**
 * The JSON Schema subset tool inputs use, and a validator for it. Providers receive
 * the schemas as they are; arguments a model sends are checked before any tool runs,
 * so a tool never sees malformed input.
 */

export type JsonSchema =
  | { type: 'string'; description?: string; enum?: readonly string[]; maxLength?: number }
  | { type: 'number' | 'integer'; description?: string; minimum?: number; maximum?: number }
  | { type: 'boolean'; description?: string }
  | { type: 'array'; description?: string; items: JsonSchema; maxItems?: number; minItems?: number }
  | {
      type: 'object';
      description?: string;
      properties: Record<string, JsonSchema>;
      required?: readonly string[];
      additionalProperties?: false;
    };

/** Problems with `value` against `schema`, as human-readable paths; empty if valid. */
export function validate(schema: JsonSchema, value: unknown, path = 'input'): string[] {
  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') return [`${path} must be a string`];
      if (schema.enum && !schema.enum.includes(value))
        return [`${path} must be one of ${schema.enum.join(', ')}`];
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        return [`${path} must be at most ${schema.maxLength} characters`];
      }
      return [];
    case 'number':
    case 'integer':
      if (typeof value !== 'number' || !Number.isFinite(value)) return [`${path} must be a number`];
      if (schema.type === 'integer' && !Number.isInteger(value)) return [`${path} must be an integer`];
      if (schema.minimum !== undefined && value < schema.minimum)
        return [`${path} must be at least ${schema.minimum}`];
      if (schema.maximum !== undefined && value > schema.maximum)
        return [`${path} must be at most ${schema.maximum}`];
      return [];
    case 'boolean':
      return typeof value === 'boolean' ? [] : [`${path} must be true or false`];
    case 'array': {
      if (!Array.isArray(value)) return [`${path} must be an array`];
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        return [`${path} must have at most ${schema.maxItems} items`];
      }
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        return [`${path} must have at least ${schema.minItems} items`];
      }
      return value.flatMap((v, i) => validate(schema.items, v, `${path}[${i}]`));
    }
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${path} must be an object`];
      const o = value as Record<string, unknown>;
      const errors: string[] = [];
      for (const r of schema.required ?? []) if (o[r] === undefined) errors.push(`${path}.${r} is required`);
      for (const [k, v] of Object.entries(o)) {
        const s = schema.properties[k];
        if (!s) {
          if (schema.additionalProperties === false) errors.push(`${path}.${k} is not a known property`);
          continue;
        }
        if (v !== undefined) errors.push(...validate(s, v, `${path}.${k}`));
      }
      return errors;
    }
  }
}
