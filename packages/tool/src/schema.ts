import type { JsonSchema, JsonSchemaType, JsonValue } from '@ai-application-toolkit/core'

export interface ValidationError {
  /** JSON-pointer-ish path to the offending value (empty string = root). */
  path: string
  message: string
}

export interface ValidationResult {
  valid: boolean
  errors: ValidationError[]
}

type RuntimeType = JsonSchemaType | 'undefined'

function typeOf(value: unknown): RuntimeType {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  switch (typeof value) {
    case 'number':
      return Number.isInteger(value) ? 'integer' : 'number'
    case 'string':
      return 'string'
    case 'boolean':
      return 'boolean'
    case 'object':
      return 'object'
    default:
      return 'undefined'
  }
}

function matchesType(value: unknown, type: JsonSchemaType): boolean {
  const actual = typeOf(value)
  if (type === 'number') return actual === 'number' || actual === 'integer'
  if (type === 'integer') return actual === 'integer'
  return actual === type
}

function enumIncludes(values: JsonValue[], value: unknown): boolean {
  const target = JSON.stringify(value)
  return values.some((candidate) => JSON.stringify(candidate) === target)
}

function validate(
  schema: JsonSchema,
  value: unknown,
  path: string,
  errors: ValidationError[]
): void {
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some((type) => matchesType(value, type))) {
      errors.push({
        path,
        message: `expected type ${types.join(' | ')}, got ${typeOf(value)}`
      })
      // Type mismatch makes deeper checks meaningless.
      return
    }
  }

  if (schema.enum !== undefined && !enumIncludes(schema.enum, value)) {
    errors.push({ path, message: 'value is not one of the allowed enum values' })
  }

  const kind = typeOf(value)

  if (kind === 'object') {
    const obj = value as Record<string, unknown>

    for (const key of schema.required ?? []) {
      if (!(key in obj)) {
        errors.push({ path: `${path}/${key}`, message: 'missing required property' })
      }
    }

    if (schema.properties) {
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (key in obj) {
          validate(sub, obj[key], `${path}/${key}`, errors)
        }
      }
    }

    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}))
      for (const key of Object.keys(obj)) {
        if (!allowed.has(key)) {
          errors.push({ path: `${path}/${key}`, message: 'additional property is not allowed' })
        }
      }
    } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      const declared = new Set(Object.keys(schema.properties ?? {}))
      for (const key of Object.keys(obj)) {
        if (!declared.has(key)) {
          validate(schema.additionalProperties, obj[key], `${path}/${key}`, errors)
        }
      }
    }
  }

  if (kind === 'array' && schema.items) {
    for (const [index, item] of (value as unknown[]).entries()) {
      validate(schema.items, item, `${path}/${index}`, errors)
    }
  }
}

/**
 * Validates a value against a {@link JsonSchema}. Supports the common subset:
 * `type` (incl. unions), `properties`, `required`, `items`, `enum`, and
 * `additionalProperties` (boolean or schema). Unlisted keywords are ignored.
 */
export function validateInput(schema: JsonSchema, value: unknown): ValidationResult {
  const errors: ValidationError[] = []
  validate(schema, value, '', errors)
  return { valid: errors.length === 0, errors }
}
