import { readFileSync } from "node:fs";

/**
 * The vendored API contract (`@atlas/api-types` openapi.json, pinned by `contract-pin.json`) and a validator of the JSON Schema subset its
 * command schemas use: `$ref`, `type` (one or a list), `const`, `enum`, `oneOf`, `anyOf`, `properties`/`required`/
 * `additionalProperties: false`, `items`, `minLength`/`maxLength` (code points, as JSON Schema counts them), `minimum`/`maximum`,
 * `pattern` and `format: uuid`. An unknown keyword fails the check rather than being ignored, so the subset cannot silently pass a body.
 */
type Schema = Record<string, unknown>;

const contract = JSON.parse(
  readFileSync(
    new URL(
      "../../../node_modules/@atlas/api-types/openapi.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { components: { schemas: Record<string, Schema> } };

const UUID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const KNOWN = new Set([
  "$ref",
  "type",
  "const",
  "enum",
  "oneOf",
  "anyOf",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "pattern",
  "format",
  "description",
  "title",
  "maxItems",
  "minItems",
]);

const typeOf = (value: unknown): string =>
  value === null
    ? "null"
    : Array.isArray(value)
      ? "array"
      : typeof value === "number"
        ? Number.isInteger(value)
          ? "integer"
          : "number"
        : typeof value;

/** The problems of `value` against `schema` (an empty list: valid). */
export function validate(value: unknown, schema: Schema, path = "$"): string[] {
  for (const key of Object.keys(schema))
    if (!KNOWN.has(key)) return [`${path}: unsupported keyword ${key}`];
  if (typeof schema.$ref === "string") {
    const name = schema.$ref.replace("#/components/schemas/", "");
    const target = contract.components.schemas[name];
    if (target === undefined) return [`${path}: unknown $ref ${schema.$ref}`];
    return validate(value, target, path);
  }
  const problems: string[] = [];
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(value);
    const ok = types.some(
      (t) => t === actual || (t === "number" && actual === "integer"),
    );
    if (!ok) return [`${path}: ${actual} is not ${types.join("|")}`];
  }
  if ("const" in schema && value !== schema.const)
    problems.push(`${path}: not ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value))
    problems.push(`${path}: not in enum`);
  if (Array.isArray(schema.oneOf)) {
    const passing = schema.oneOf.filter(
      (s) => validate(value, s as Schema, path).length === 0,
    ).length;
    if (passing !== 1) problems.push(`${path}: matches ${passing} of oneOf`);
  }
  if (
    Array.isArray(schema.anyOf) &&
    !schema.anyOf.some((s) => validate(value, s as Schema, path).length === 0)
  )
    problems.push(`${path}: matches none of anyOf`);
  if (typeof value === "string") {
    const length = [...value].length;
    if (typeof schema.minLength === "number" && length < schema.minLength)
      problems.push(`${path}: shorter than ${schema.minLength}`);
    if (typeof schema.maxLength === "number" && length > schema.maxLength)
      problems.push(`${path}: longer than ${schema.maxLength}`);
    if (
      typeof schema.pattern === "string" &&
      !new RegExp(schema.pattern, "u").test(value)
    )
      problems.push(`${path}: does not match ${schema.pattern}`);
    if (schema.format === "uuid" && !UUID.test(value))
      problems.push(`${path}: not a uuid`);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum)
      problems.push(`${path}: below ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum)
      problems.push(`${path}: above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems)
      problems.push(`${path}: more than ${schema.maxItems} items`);
    if (typeof schema.minItems === "number" && value.length < schema.minItems)
      problems.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.items !== undefined)
      value.forEach((item, i) => {
        problems.push(
          ...validate(item, schema.items as Schema, `${path}[${i}]`),
        );
      });
  }
  if (typeOf(value) === "object") {
    const object = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, Schema>;
    for (const key of (schema.required ?? []) as string[])
      if (!Object.hasOwn(object, key)) problems.push(`${path}: missing ${key}`);
    for (const [key, item] of Object.entries(object)) {
      const sub = properties[key];
      if (sub !== undefined)
        problems.push(...validate(item, sub, `${path}.${key}`));
      else if (schema.additionalProperties === false)
        problems.push(`${path}: unexpected ${key}`);
    }
  }
  return problems;
}

/** `value` against the named component schema. */
export const validateAs = (value: unknown, name: string): string[] =>
  validate(value, { $ref: `#/components/schemas/${name}` });
