export type JsonSchemaType = "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";

/** The JSON Schema subset used by tool inputs. Plain JSON Schema, so it works with MCP and LLM function calling. */
export interface JsonSchema {
  type?: JsonSchemaType | JsonSchemaType[];
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: readonly unknown[];
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minItems?: number;
  maxItems?: number;
  format?: string;
  default?: unknown;
  examples?: unknown[];
}

export function validate(schema: JsonSchema, value: unknown, path = "input"): string[] {
  const errors: string[] = [];
  check(schema, value, path, errors);
  return errors;
}

function check(schema: JsonSchema, value: unknown, path: string, errors: string[]): void {
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(type, value))) {
      errors.push(`${path} must be ${types.join(" or ")}, got ${describe(value)}`);
      return;
    }
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path} must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`);
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path} must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path} must be <= ${schema.maximum}`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
      errors.push(`${path} must be > ${schema.exclusiveMinimum}`);
    }
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path} must be at least ${schema.minLength} characters`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${path} must be at most ${schema.maxLength} characters`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path} must match ${schema.pattern}`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path} must have at least ${schema.minItems} items`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${path} must have at most ${schema.maxItems} items`);
    }
    if (schema.items) {
      value.forEach((item, index) => check(schema.items!, item, `${path}[${index}]`, errors));
    }
  }

  if (isPlainObject(value)) {
    for (const key of schema.required ?? []) {
      if (value[key] === undefined) errors.push(`${path}.${key} is required`);
    }
    for (const [key, child] of Object.entries(value)) {
      const childSchema = schema.properties?.[key];
      if (childSchema) {
        if (child !== undefined) check(childSchema, child, `${path}.${key}`, errors);
      } else if (schema.additionalProperties === false) {
        const known = Object.keys(schema.properties ?? {});
        errors.push(`${path}.${key} is not allowed${known.length ? ` (expected one of: ${known.join(", ")})` : ""}`);
      }
    }
  }
}

function matchesType(type: JsonSchemaType, value: unknown): boolean {
  switch (type) {
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "string") return `string ${JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}...` : value)}`;
  return typeof value === "number" ? `number ${value}` : typeof value;
}
