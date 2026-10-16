import type { OpenCodeEventLike } from '../zellij/tab-title-events.js'
import { z } from 'zod'

const locationSchema = z.object({
  directory: z.string().min(1).optional(),
})

const envelopeSchema = z.object({
  type: z.string(),
  data: z.unknown().optional(),
  location: locationSchema.optional(),
})

const sessionIDSchema = z.string().min(1)

const createdDataSchema = z.object({
  sessionID: sessionIDSchema,
  parentID: sessionIDSchema.optional(),
  location: locationSchema.optional(),
})

const sessionDataSchema = z.object({
  sessionID: sessionIDSchema,
})

const statusDataSchema = z.object({
  sessionID: sessionIDSchema,
  status: z.object({
    type: z.enum(['idle', 'busy', 'retry']),
  }),
})

const permissionAskedSchema = z.object({
  id: z.string().min(1),
  sessionID: sessionIDSchema,
})

const permissionRepliedSchema = z.object({
  requestID: z.string().min(1),
  sessionID: sessionIDSchema,
})

const formSchema = z.object({
  id: z.string().min(1),
  sessionID: sessionIDSchema.refine(sessionID => sessionID !== 'global'),
})

const formCreatedSchema = z.object({
  form: formSchema,
})

const formQuestionType = {
  'form.created': 'question.asked',
  'form.replied': 'question.replied',
  'form.cancelled': 'question.rejected',
} as const

function questionEventFromForm(type: keyof typeof formQuestionType, data: unknown): OpenCodeEventLike | undefined {
  if (type === 'form.created') {
    const parsed = formCreatedSchema.safeParse(data)
    if (!parsed.success)
      return undefined
    return {
      type: formQuestionType[type],
      properties: { id: parsed.data.form.id, sessionID: parsed.data.form.sessionID },
    }
  }
  const parsed = formSchema.safeParse(data)
  if (!parsed.success)
    return undefined
  return {
    type: formQuestionType[type],
    properties: { id: parsed.data.id, sessionID: parsed.data.sessionID },
  }
}

export function v2EventToActivityEvent(event: unknown): OpenCodeEventLike | undefined {
  const envelope = envelopeSchema.safeParse(event)
  if (!envelope.success)
    return undefined
  const { type, data, location } = envelope.data

  switch (type) {
    case 'session.created':
    case 'session.forked': {
      const parsed = createdDataSchema.safeParse(data)
      if (!parsed.success)
        return undefined
      const info: Record<string, string> = { id: parsed.data.sessionID }
      const directory = parsed.data.location?.directory ?? location?.directory
      if (directory)
        info.directory = directory
      if (parsed.data.parentID)
        info.parentID = parsed.data.parentID
      return { type: 'session.created', properties: { info } }
    }
    case 'session.moved': {
      const parsed = createdDataSchema.safeParse(data)
      if (!parsed.success)
        return undefined
      const directory = parsed.data.location?.directory ?? location?.directory
      if (!directory)
        return undefined
      const info: Record<string, string> = { id: parsed.data.sessionID, directory }
      if (parsed.data.parentID)
        info.parentID = parsed.data.parentID
      return { type: 'session.updated', properties: { info } }
    }
    case 'session.deleted': {
      const parsed = sessionDataSchema.safeParse(data)
      if (!parsed.success)
        return undefined
      return { type: 'session.deleted', properties: { sessionID: parsed.data.sessionID } }
    }
    case 'session.status': {
      const parsed = statusDataSchema.safeParse(data)
      if (!parsed.success)
        return undefined
      return {
        type: 'session.status',
        properties: {
          sessionID: parsed.data.sessionID,
          status: { type: parsed.data.status.type },
        },
      }
    }
    case 'session.idle':
    case 'session.execution.succeeded':
    case 'session.execution.interrupted': {
      const parsed = sessionDataSchema.safeParse(data)
      if (!parsed.success)
        return undefined
      return { type: 'session.idle', properties: { sessionID: parsed.data.sessionID } }
    }
    case 'session.execution.failed': {
      const parsed = sessionDataSchema.safeParse(data)
      if (!parsed.success)
        return undefined
      return { type: 'session.error', properties: { sessionID: parsed.data.sessionID } }
    }
    case 'session.execution.started': {
      const parsed = sessionDataSchema.safeParse(data)
      if (!parsed.success)
        return undefined
      return {
        type: 'session.status',
        properties: {
          sessionID: parsed.data.sessionID,
          status: { type: 'busy' },
        },
      }
    }
    case 'permission.asked': {
      const parsed = permissionAskedSchema.safeParse(data)
      if (!parsed.success)
        return undefined
      return {
        type: 'permission.asked',
        properties: { id: parsed.data.id, sessionID: parsed.data.sessionID },
      }
    }
    case 'permission.replied': {
      const parsed = permissionRepliedSchema.safeParse(data)
      if (!parsed.success)
        return undefined
      return {
        type: 'permission.replied',
        properties: { requestID: parsed.data.requestID, sessionID: parsed.data.sessionID },
      }
    }
    case 'form.created':
    case 'form.replied':
    case 'form.cancelled':
      return questionEventFromForm(type, data)
    case 'global.disposed':
    case 'server.instance.disposed':
      return { type, properties: {} }
    default:
      return undefined
  }
}
