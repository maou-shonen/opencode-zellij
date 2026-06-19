export interface OpenCodeEventLike {
  type: string
  properties: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function stringProperty(object: Record<string, unknown>, key: string): string | undefined {
  const value = object[key]
  return typeof value === 'string' ? value : undefined
}

function nestedStringProperty(object: Record<string, unknown>, key: string, nestedKey: string): string | undefined {
  const nested = object[key]
  if (!isRecord(nested))
    return undefined
  return stringProperty(nested, nestedKey)
}

export function deletedSessionID(event: OpenCodeEventLike): string | undefined {
  if (!isRecord(event.properties))
    return undefined
  return nestedStringProperty(event.properties, 'info', 'id') ?? stringProperty(event.properties, 'sessionID')
}
