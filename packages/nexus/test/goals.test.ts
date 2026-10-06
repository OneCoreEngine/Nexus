import { describe, expect, test } from "bun:test"
import { closeGoal, makeGoal, readGoals, stageGoal, summarizeGoals, type Goal } from "../src/goals"

function goal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "goal_abc",
    title: "Ship it",
    status: "active",
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  }
}

describe("session goals", () => {
  test("makeGoal stamps ids and times", () => {
    const created = makeGoal("  Launch  ", 5000)
    expect(created.title).toBe("Launch")
    expect(created.status).toBe("active")
    expect(created.createdAt).toBe(5000)
    expect(created.id.length).toBeGreaterThan(0)
  })

  test("readGoals tolerates missing and malformed metadata", () => {
    expect(readGoals(undefined)).toEqual([])
    expect(readGoals({})).toEqual([])
    expect(readGoals({ nexusGoals: "nope" })).toEqual([])
    expect(
      readGoals({
        nexusGoals: [
          goal(),
          { junk: true },
          { id: "b", title: "Ship it", status: "bogus", createdAt: 1000, updatedAt: 1000 },
        ],
      }),
    ).toEqual([goal()])
  })

  test("stageGoal upserts by id and preserves sibling keys", () => {
    const metadata = stageGoal({ other: 1 }, goal())
    expect(readGoals(metadata)).toEqual([goal()])
    expect(metadata.other).toBe(1)
    const replaced = stageGoal(metadata, goal({ title: "Ship it v2", updatedAt: 2000 }))
    expect(readGoals(replaced)).toEqual([goal({ title: "Ship it v2", updatedAt: 2000 })])
  })

  test("closeGoal flips status with a fresh timestamp", () => {
    const closed = closeGoal([goal()], "goal_abc", "done", 9000)
    expect(closed[0].status).toBe("done")
    expect(closed[0].updatedAt).toBe(9000)
    expect(closeGoal([goal()], "missing", "dropped")).toEqual([goal()])
  })

  test("summarizeGoals counts actives", () => {
    expect(summarizeGoals([])).toContain("No goals")
    const summary = summarizeGoals([goal(), goal({ id: "b", title: "Old", status: "done" })])
    expect(summary).toContain("1 active of 2")
    expect(summary).toContain("[ ] Ship it")
    expect(summary).toContain("[x] Old")
  })
})
