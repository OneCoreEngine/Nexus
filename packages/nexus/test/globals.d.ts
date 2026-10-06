import "bun:test"

declare global {
  const test: typeof import("bun:test").test
  const it: typeof import("bun:test").it
  const describe: typeof import("bun:test").describe
  const expect: typeof import("bun:test").expect
  const expectTypeOf: typeof import("bun:test").expectTypeOf
  const beforeAll: typeof import("bun:test").beforeAll
  const beforeEach: typeof import("bun:test").beforeEach
  const afterAll: typeof import("bun:test").afterAll
  const afterEach: typeof import("bun:test").afterEach
}

export {}
