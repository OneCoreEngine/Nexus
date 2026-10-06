import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { applyPolicy, type Policy } from "../../src/session/tools"

const args = { path: "/tmp/file.txt" }

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function run(policy: Policy, ask?: () => Effect.Effect<void, unknown>) {
  let asked = 0
  const effect = applyPolicy(policy, () => {
    asked++
    return ask?.() ?? Effect.void
  })
  return Effect.runPromise(
    Effect.zip(
      effect,
      Effect.sync(() => asked),
    ),
  )
}

describe("tool.policy outcomes", () => {
  test("allow proceeds with rewritten args without asking", async () => {
    const rewritten = { path: "/tmp/clean.txt" }
    const [result, asked] = await run({ decision: "allow", args: rewritten })
    expect(result).toEqual(rewritten)
    expect(asked).toBe(0)
  })

  test("deny fails with the policy reason", async () => {
    const error = await Effect.runPromise(
      applyPolicy({ decision: "deny", reason: "read-only mode", args }, () => Effect.void).pipe(Effect.flip),
    )
    expect(errorMessage(error)).toContain("read-only mode")
  })

  test("deny without reason fails with a default message", async () => {
    const error = await Effect.runPromise(applyPolicy({ decision: "deny", args }, () => Effect.void).pipe(Effect.flip))
    expect(errorMessage(error)).toContain("blocked by policy")
  })

  test("ask prompts once then proceeds", async () => {
    const [result, asked] = await run({ decision: "ask", args })
    expect(result).toEqual(args)
    expect(asked).toBe(1)
  })

  test("ask denial propagates the failure", async () => {
    const denied = Effect.fail(new Error("rejected"))
    const error = await Effect.runPromise(
      applyPolicy({ decision: "ask", args }, () => denied).pipe(
        Effect.flip,
        Effect.map((cause) => String(cause)),
      ),
    )
    expect(error).toContain("rejected")
  })
})
