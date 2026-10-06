import { SessionV1 } from "@nexus-ai/core/v1/session"
import { Effect } from "effect"
import { Session } from "@/session/session"
import { Provider } from "@/provider/provider"
import { MessageID, PartID, SessionID } from "@/session/schema"

// External wakeups land as durable user messages, mirroring the plan_exit
// admission pattern. The running loop picks them up at safe boundaries; if no
// loop is alive the message waits for the next opened session turn.
export interface Injection {
  message: SessionV1.User
  part: SessionV1.TextPart
}

export function buildInjection(input: {
  sessionID: SessionID
  text: string
  agent: string
  model: SessionV1.User["model"]
}): Injection {
  const message: SessionV1.User = {
    id: MessageID.ascending(),
    sessionID: input.sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: input.agent,
    model: input.model,
  }
  const part: SessionV1.TextPart = {
    id: PartID.ascending(),
    messageID: message.id,
    sessionID: input.sessionID,
    type: "text",
    text: input.text,
    synthetic: true,
  }
  return { message, part }
}

export const inject = Effect.fn("Inbox.inject")(function* (input: { sessionID: string; text: string; agent?: string }) {
  const sessions = yield* Session.Service
  const provider = yield* Provider.Service
  const sessionID = yield* Effect.try({
    try: () => SessionID.make(input.sessionID),
    catch: () => new Error(`Invalid session ID: ${input.sessionID}`),
  })
  const info = yield* sessions.get(sessionID)
  const messages = yield* sessions.messages({ sessionID }).pipe(Effect.orDie)
  const lastUser = messages.findLast((item) => item.info.role === "user" && item.info.model)
  const model =
    lastUser?.info.role === "user" && lastUser.info.model ? lastUser.info.model : yield* provider.defaultModel()
  const { message, part } = buildInjection({
    sessionID,
    text: input.text,
    agent: input.agent ?? info.agent ?? "build",
    model,
  })
  yield* sessions.updateMessage(message)
  yield* sessions.updatePart(part)
  return { messageID: message.id }
})
