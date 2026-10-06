import { describe, expect, test } from "bun:test"
import { LayerNode } from "@nexus-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { addLocalMemory } from "../../src/cli/cmd/memory"
import type { Agent } from "../../src/agent/agent"
import { NamedError } from "@nexus-ai/core/util/error"
import { Skill } from "../../src/skill"
import { Permission } from "../../src/permission"
import type { Provider } from "../../src/provider/provider"
import { SystemPrompt, truncateOrders, STANDING_ORDER_FILE_BUDGET_CHARS } from "../../src/session/system"
import { Config } from "../../src/config/config"
import { FSUtil } from "@nexus-ai/core/fs-util"
import { Global } from "@nexus-ai/core/global"
import { MCP } from "../../src/mcp"
import { testEffect } from "../lib/effect"
import { provideTmpdirInstance } from "../fixture/fixture"
import { CrossSpawnSpawner } from "@nexus-ai/core/cross-spawn-spawner"

const skills: Skill.Info[] = [
  {
    name: "zeta-skill",
    description: "Zeta skill.",
    location: "/tmp/zeta-skill/SKILL.md",
    content: "# zeta-skill",
  },
  {
    name: "alpha-skill",
    description: "Alpha skill.",
    location: "/tmp/alpha-skill/SKILL.md",
    content: "# alpha-skill",
  },
  {
    name: "middle-skill",
    description: "Middle skill.",
    location: "/tmp/middle-skill/SKILL.md",
    content: "# middle-skill",
  },
  {
    name: "manual-skill",
    location: "/tmp/manual-skill/SKILL.md",
    content: "# manual-skill",
  },
]

const build: Agent.Info = {
  name: "build",
  mode: "primary",
  permission: Permission.fromConfig({ "*": "allow" }),
  options: {},
}

const node = LayerNode.compile(CrossSpawnSpawner.node)

const filesystemLayer = (readFileStringSafe: FSUtil.Interface["readFileStringSafe"]) =>
  Layer.effect(
    FSUtil.Service,
    FSUtil.Service.pipe(Effect.map((fs) => FSUtil.Service.of({ ...fs, readFileStringSafe }))),
  ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(SystemPrompt.node, [
      [
        MCP.node,
        Layer.mock(MCP.Service, {
          instructions: () =>
            Effect.succeed([
              {
                name: "guide-server",
                instructions: "Use lookup before mutate.",
                tools: [],
              },
              {
                name: "tool-server",
                instructions: "Prefer search before update.",
                tools: ["tool-server_search", "tool-server_update"],
              },
            ]),
        }),
      ],
      [
        Skill.node,
        Layer.succeed(
          Skill.Service,
          Skill.Service.of({
            get: (name) => Effect.succeed(skills.find((skill) => skill.name === name)),
            require: (name) => {
              const info = skills.find((skill) => skill.name === name)
              if (info) return Effect.succeed(info)
              return Effect.fail(new Skill.NotFoundError({ name, available: skills.map((skill) => skill.name) }))
            },
            all: () => Effect.succeed(skills),
            dirs: () => Effect.succeed([]),
            available: () => Effect.succeed(skills),
          }),
        ),
      ],
      [
        Config.node,
        Layer.mock(Config.Service, {
          get: () => Effect.succeed({}),
        }),
      ],
      [FSUtil.node, filesystemLayer(() => Effect.succeed(undefined))],
      [Global.node, Global.layerWith({ home: "/tmp/nexus-test-no-home" })],
    ]),
    node,
  ),
)

describe("session.system", () => {
  test("selects the Meta prompt for Muse Spark model IDs", () => {
    for (const id of ["meta/muse-spark-preview", "muse-spark-1.1", "muse-spark-1.2"]) {
      const prompt = SystemPrompt.provider({ api: { id } } as Provider.Model)[0]
      expect(prompt).toContain("powered by Muse Spark,")
      expect(prompt).toContain("using Meta Muse Spark.")
      expect(prompt).not.toContain("{{MODEL_NAME}}")
    }
  })

  test("selects the Meta prompt for Muse Glimmer model IDs", () => {
    for (const id of ["meta/muse-glimmer", "meta/muse-glimmer-30b", "muse-glimmer-30b"]) {
      const prompt = SystemPrompt.provider({ api: { id } } as Provider.Model)[0]
      expect(prompt).toContain("powered by Muse Glimmer,")
      expect(prompt).toContain("using Meta Muse Glimmer.")
      expect(prompt).not.toContain("{{MODEL_NAME}}")
    }
  })

  test("selects the Kimi prompt for official provider model IDs", () => {
    for (const providerID of ["kimi-for-coding", "moonshotai", "moonshotai-cn"]) {
      const prompt = SystemPrompt.provider({ providerID, api: { id: "k3" } } as Provider.Model)[0]
      expect(prompt).toContain("# Prompt and Tool Use")
    }
  })

  it.effect("skills output is sorted by name and stable across calls", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const first = yield* prompt.skills(build)
      const second = yield* prompt.skills(build)
      const output = first ?? (yield* Effect.fail(new NamedError.Unknown({ message: "missing skills output" })))

      expect(first).toBe(second)

      const alpha = output.indexOf("<name>alpha-skill</name>")
      const middle = output.indexOf("<name>middle-skill</name>")
      const zeta = output.indexOf("<name>zeta-skill</name>")

      expect(alpha).toBeGreaterThan(-1)
      expect(middle).toBeGreaterThan(alpha)
      expect(zeta).toBeGreaterThan(middle)
      expect(output).not.toContain("manual-skill")
    }),
  )

  it.effect("MCP output includes connected server instructions", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = yield* prompt.mcp(build)

      expect(output).toBe(
        [
          "<mcp_instructions>",
          '  <server name="guide-server">',
          "    Use lookup before mutate.",
          "  </server>",
          '  <server name="tool-server">',
          "    Prefer search before update.",
          "  </server>",
          "</mcp_instructions>",
        ].join("\n"),
      )
    }),
  )

  it.effect("MCP output omits servers when all advertised tools are denied", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = yield* prompt.mcp(build, Permission.fromConfig({ "tool-server_*": "deny" }))

      expect(output).toBe(
        [
          "<mcp_instructions>",
          '  <server name="guide-server">',
          "    Use lookup before mutate.",
          "  </server>",
          "</mcp_instructions>",
        ].join("\n"),
      )
    }),
  )

  it.live("standing orders are undefined when no orders files exist", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const prompt = yield* SystemPrompt.Service
        const output = yield* prompt.standing(build)
        expect(output).toBeUndefined()
      }),
    ),
  )
})

const itOrders = testEffect(
  Layer.mergeAll(
    LayerNode.compile(SystemPrompt.node, [
      [
        MCP.node,
        Layer.mock(MCP.Service, {
          instructions: () => Effect.succeed([]),
        }),
      ],
      [
        Skill.node,
        Layer.succeed(
          Skill.Service,
          Skill.Service.of({
            get: () => Effect.succeed(undefined),
            require: (name) => Effect.fail(new Skill.NotFoundError({ name, available: [] })),
            all: () => Effect.succeed([]),
            dirs: () => Effect.succeed([]),
            available: () => Effect.succeed([]),
          }),
        ),
      ],
      [
        Config.node,
        Layer.mock(Config.Service, {
          get: () => Effect.succeed({}),
        }),
      ],
      [
        FSUtil.node,
        filesystemLayer((file: string) =>
          Effect.succeed(
            file.endsWith(path.join(".nexus", "standing-orders.md")) ? "Always answer in Hinglish." : undefined,
          ),
        ),
      ],
      [Global.node, Global.layerWith({ home: "/tmp/nexus-test-no-home" })],
    ]),
    node,
  ),
)

describe("session.system standing orders", () => {
  itOrders.live("standing orders inject workspace orders into every session", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const prompt = yield* SystemPrompt.Service
        const output = yield* prompt.standing(build)
        expect(output).toContain("<standing_orders>")
        expect(output).toContain("Always answer in Hinglish.")
      }),
    ),
  )
})

describe("standing order budget", () => {
  test("huge files truncate with a marker instead of bloating prompts", () => {
    const big = "x".repeat(STANDING_ORDER_FILE_BUDGET_CHARS + 100)
    const truncated = truncateOrders(big)
    expect(truncated.length).toBeLessThan(big.length)
    expect(truncated).toContain("[truncated:")
    expect(truncateOrders("short")).toBe("short")
  })
})

describe("session.system memory", () => {
  it.effect("memory block is undefined without stored memories", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = yield* prompt.memory(build, "/tmp/nexus-test-no-memories-here")
      expect(output).toBeUndefined()
    }),
  )

  it.effect("memory block surfaces stored facts", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(path.join(tmpdir(), "nexus-memory-"))
      try {
        addLocalMemory({ title: "coffee shop", value: "User loves cold brew", stateDirectory: dir })
        const prompt = yield* SystemPrompt.Service
        const output = yield* prompt.memory(build, dir)
        expect(output).toContain("<memories>")
        expect(output).toContain("coffee shop")
        expect(output).toContain("cold brew")
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }),
  )
})
