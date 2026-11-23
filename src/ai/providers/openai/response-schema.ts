// Structured Outputs requires closed objects with every property listed as required.
// Optional fields in the shared provider schema can be returned as null.
type Schema = {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  anyOf?: Schema[];
  $defs?: Record<string, Schema>;
  [key: string]: unknown;
};

export function toResponseSchema(input: object): Schema {
  const schema = input as Schema;
  const result = { ...schema };
  if (schema.properties) {
    const required = new Set(schema.required);
    result.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([name, value]) => {
        const property = toResponseSchema(value);
        return [name, required.has(name) ? property : { anyOf: [property, { type: 'null' }] }];
      }),
    );
    result.required = Object.keys(schema.properties);
    result.additionalProperties = false;
  }
  if (schema.items) result.items = toResponseSchema(schema.items);
  if (schema.anyOf) result.anyOf = schema.anyOf.map(toResponseSchema);
  if (schema.$defs) {
    result.$defs = Object.fromEntries(
      Object.entries(schema.$defs).map(([key, value]) => [key, toResponseSchema(value)]),
    );
  }
  return result;
}
