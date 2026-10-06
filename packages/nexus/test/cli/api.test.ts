import { expect, test } from "bun:test"
import { formatApiReadiness, formatApiRoutePreview, formatApiVaultList } from "../../src/cli/cmd/api"

test("API vault list labels only NEXUS-observed usage and never claims provider account state", () => {
  const output = formatApiVaultList({
    vaultPath: "/tmp/nexus/api-keys.json",
    autoRotate: true,
    budget: { version: 1, maxRequestsPerTask: 3, maxTokensPerTask: 1200, maxRequestsPerDay: 12, maxTokensPerDay: 4800 },
    rows: [
      {
        provider: "groq",
        index: 1,
        label: "default",
        key: "gsk_abc***xyz",
        status: "active",
        usage: { todayRequests: 2, todayInputTokens: 40, todayOutputTokens: 60 },
      },
    ],
    now: Date.UTC(2026, 7, 25),
  })

  expect(output).toContain("NEXUS observed today")
  expect(output).toContain("2 req / 100 tok")
  expect(output).toContain("not a provider balance, remaining quota, account token allocation, or cost reading")
  expect(output).toContain("gsk_abc***xyz")
})

test("API readiness summarizes only stored local health and usage evidence", () => {
  const output = formatApiReadiness(
    {
      autoRotate: true,
      budget: { version: 1, maxRequestsPerDay: 12 },
      rows: [
        {
          provider: "groq",
          index: 1,
          label: "first",
          key: "gsk_one***one",
          status: "active",
          usage: { todayRequests: 2, todayInputTokens: 10, todayOutputTokens: 20 },
        },
        {
          provider: "groq",
          index: 2,
          label: "second",
          key: "gsk_two***two",
          status: "rate_limited",
          cooldownUntil: "2026-08-25T12:00:00.000Z",
          usage: { todayRequests: 2, todayInputTokens: 10, todayOutputTokens: 20 },
        },
      ],
      now: Date.UTC(2026, 7, 25, 11),
    },
    "table",
  )

  expect(output).toContain("2 masked key entries across 1 provider")
  expect(output).toContain("1 active, 0 unknown, 1 rate-limited")
  expect(output).toContain("1 cooling")
  expect(output).toContain("2 request(s) / 30 token(s)")
  expect(output).toContain("No provider contacted, key checked, vault changed, route selected, or task started")
  expect(output).not.toContain("gsk_one")
})

test("API route preview keeps candidate order while revealing no key or account data", () => {
  const output = formatApiRoutePreview(
    {
      model: "deepseek",
      routes: [
        { alias: "deepseek", provider: "groq", model: "deepseek-chat", reason: "preferred provider" },
        { alias: "deepseek", provider: "ollama", model: "llama3", reason: "local fallback" },
      ],
      rows: [
        {
          provider: "groq",
          keys: [
            {
              index: 1,
              label: "default",
              key: "gsk_abc***xyz",
              status: "active",
              failures: 0,
              added: "2026-08-25",
              todayRequests: 0,
              todayInputTokens: 0,
              todayOutputTokens: 0,
            },
          ],
        },
      ],
      now: Date.UTC(2026, 7, 25),
    },
    "table",
  )

  expect(output).toContain("1\tgroq/deepseek-chat\tpreferred provider")
  expect(output).toContain("Local candidate; backend/runtime availability is not checked")
  expect(output).toContain(
    "Preview only: no provider contacted, key validated, vault changed, route selected, or task started",
  )
  expect(output).not.toContain("gsk_abc")
})

test("API route preview JSON is explicit that it is observation-only", () => {
  const output = formatApiRoutePreview({ model: "custom", routes: [], rows: [] }, "json")
  expect(output).toContain('"observedOnly": true')
  expect(output).toContain("does not select a route or start a task")
})
