import { describe, expect, test } from "bun:test"
import { planAndroidArtifactTest, planAndroidDeviceCommands } from "./android-audit"

describe("Android artifact testing plan", () => {
  test("plans APK device checks only when a device is connected", () => {
    const plan = planAndroidArtifactTest({
      artifact: "build/outputs/apk/debug/app-debug.apk",
      capabilities: { android: true, androidDevice: true, apkBuild: true },
    })
    expect(plan.artifactType).toBe("apk")
    expect(plan.canRunDeviceChecks).toBe(true)
    expect(plan.approvalRequired.some((item) => /install/i.test(item))).toBe(true)
  })

  test("plans approval-gated APK install, launch, and bounded logcat commands", () => {
    const commands = planAndroidDeviceCommands({
      artifact: "app-debug.apk",
      packageName: "com.example.app",
      androidDevice: true,
    })
    expect(commands.map((item) => item.id)).toEqual(["install", "launch", "logcat"])
    expect(commands.every((item) => item.approvalRequired)).toBe(true)
    expect(commands[0]?.command).toEqual(["adb", "install", "-r", "app-debug.apk"])
    expect(commands[2]?.command).toEqual(["adb", "logcat", "-d", "-t", "200"])
  })

  test("does not create device commands without a connected device", () => {
    expect(
      planAndroidDeviceCommands({ artifact: "app.apk", packageName: "com.example.app", androidDevice: false }),
    ).toEqual([])
  })

  test("rejects direct device execution plans for AAB files", () => {
    expect(() =>
      planAndroidDeviceCommands({ artifact: "app.aab", packageName: "com.example.app", androidDevice: true }),
    ).toThrow(/\.apk/i)
  })

  test("keeps APK device checks checkpointed without a device", () => {
    const plan = planAndroidArtifactTest({
      artifact: "app.apk",
      capabilities: { android: true, androidDevice: false, apkBuild: true },
    })
    expect(plan.canRunDeviceChecks).toBe(false)
    expect(plan.limitations.some((item) => /connected/i.test(item))).toBe(true)
  })

  test("does not pretend an AAB is directly installable", () => {
    const plan = planAndroidArtifactTest({
      artifact: "app-release.aab",
      capabilities: { android: true, androidDevice: true, apkBuild: true },
    })
    expect(plan.artifactType).toBe("aab")
    expect(plan.canRunDeviceChecks).toBe(false)
    expect(plan.limitations).toContain("An AAB is not directly installable with adb.")
  })

  test("rejects non-Android artifacts", () => {
    expect(() =>
      planAndroidArtifactTest({
        artifact: "dist/site.zip",
        capabilities: { android: false, androidDevice: false, apkBuild: false },
      }),
    ).toThrow(/\.apk or \.aab/i)
  })
})
