import { extractPrefixParts } from "../src/tools"

describe("extractPrefixParts", () => {
  test("uses bracketed tokens when present", () => {
    expect(extractPrefixParts("[PreviewGateTiming] finalGatePass true")).toEqual({
      prefix: "PreviewGateTiming",
      subprefix: "finalGatePass",
      remaining: "finalGatePass true",
    })
  })

  test("falls back to plain-text words when brackets are absent", () => {
    expect(extractPrefixParts("isPreviewReady 00:02 ready")).toEqual({
      prefix: "isPreviewReady",
      subprefix: "00:02",
      remaining: "isPreviewReady 00:02 ready",
    })
  })
})
