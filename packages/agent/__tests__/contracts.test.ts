/**
 * Zod contract tests — cross-package boundary validation.
 *
 * Verifies that all schema types used across package boundaries
 * correctly validate and reject edge cases.
 */

import { describe, expect, it } from "vitest";
import {
  Insight,
  InsightKind,
  VotedInsight,
  SynthesizedInsight,
  LocalizedValue,
  ValidatedInsight,
  NewsMessage,
  NewsChannelWithUpdates,
  AlertType,
  QualitativeCount,
} from "@easyoref/shared";

// ── AlertType ──────────────────────────────────────────

describe("AlertType schema", () => {
  it("accepts valid alert types", () => {
    expect(AlertType.parse("early_warning")).toBe("early_warning");
    expect(AlertType.parse("red_alert")).toBe("red_alert");
    expect(AlertType.parse("resolved")).toBe("resolved");
  });

  it("rejects invalid alert type", () => {
    expect(() => AlertType.parse("unknown")).toThrow();
    expect(() => AlertType.parse("")).toThrow();
  });
});

// ── QualitativeCount ───────────────────────────────────

describe("QualitativeCount schema", () => {
  it("accepts exact count", () => {
    const r = QualitativeCount.parse({ type: "exact", value: 30 });
    expect(r).toEqual({ type: "exact", value: 30 });
  });

  it("accepts qualitative types", () => {
    expect(QualitativeCount.parse({ type: "most" })).toEqual({ type: "most" });
    expect(QualitativeCount.parse({ type: "none" })).toEqual({ type: "none" });
  });

  it("rejects missing value for more_than", () => {
    expect(() => QualitativeCount.parse({ type: "more_than" })).toThrow();
  });
});

// ── NewsMessage ────────────────────────────────────────

describe("NewsMessage schema", () => {
  const valid = {
    channelId: "@test",
    sourceType: "telegram_channel",
    timestamp: 1700000000,
    text: "Alert in Tel Aviv",
  };

  it("accepts valid message", () => {
    expect(() => NewsMessage.parse(valid)).not.toThrow();
  });

  it("rejects empty channelId", () => {
    expect(() => NewsMessage.parse({ ...valid, channelId: "" })).toThrow();
  });

  it("rejects empty text", () => {
    expect(() => NewsMessage.parse({ ...valid, text: "" })).toThrow();
  });

  it("rejects negative timestamp", () => {
    expect(() => NewsMessage.parse({ ...valid, timestamp: -1 })).toThrow();
  });
});

// ── InsightKind ────────────────────────────────────────

describe("InsightKind schema", () => {
  it("accepts eta with minutes", () => {
    const r = InsightKind.parse({
      kind: "eta",
      value: { kind: "minutes", minutes: 5 },
    });
    expect(r.kind).toBe("eta");
  });

  it("accepts country_origins", () => {
    const r = InsightKind.parse({
      kind: "country_origins",
      value: ["Iran", "Lebanon"],
    });
    expect(r.kind).toBe("country_origins");
  });

  it("accepts rocket_count with exact", () => {
    const r = InsightKind.parse({
      kind: "rocket_count",
      value: { type: "exact", value: 30 },
    });
    expect(r.kind).toBe("rocket_count");
  });

  it("accepts cluser_munition_used", () => {
    const r = InsightKind.parse({
      kind: "cluser_munition_used",
      value: true,
    });
    expect(r.kind).toBe("cluser_munition_used");
  });

  it("rejects country_origins with empty array", () => {
    expect(() =>
      InsightKind.parse({ kind: "country_origins", value: [] }),
    ).toThrow();
  });

  it("rejects unknown kind", () => {
    expect(() =>
      InsightKind.parse({ kind: "unknown_field", value: "test" }),
    ).toThrow();
  });
});

// ── Insight ────────────────────────────────────────────

describe("Insight schema", () => {
  const validInsight = {
    kind: { kind: "eta", value: { kind: "minutes", minutes: 3 } },
    timeRelevance: 1.0,
    regionRelevance: 0.9,
    confidence: 0.8,
    source: {
      channelId: "@channel1",
      sourceType: "telegram_channel",
      timestamp: 1700000000,
      text: "ETA 3 minutes",
    },
    timeStamp: new Date().toISOString(),
  };

  it("accepts valid insight", () => {
    expect(() => Insight.parse(validInsight)).not.toThrow();
  });

  it("rejects confidence > 1", () => {
    expect(() =>
      Insight.parse({ ...validInsight, confidence: 1.5 }),
    ).toThrow();
  });

  it("rejects confidence < 0", () => {
    expect(() =>
      Insight.parse({ ...validInsight, confidence: -0.1 }),
    ).toThrow();
  });

  it("rejects missing source", () => {
    const { source: _, ...noSource } = validInsight;
    expect(() => Insight.parse(noSource)).toThrow();
  });
});

// ── LocalizedValue ─────────────────────────────────────

describe("LocalizedValue schema", () => {
  it("accepts all 4 languages", () => {
    expect(() =>
      LocalizedValue.parse({
        ru: "Иран",
        en: "Iran",
        he: "איראן",
        ar: "إيران",
      }),
    ).not.toThrow();
  });

  it("rejects missing language", () => {
    expect(() =>
      LocalizedValue.parse({ ru: "Иран", en: "Iran", he: "איראן" }),
    ).toThrow();
  });
});

// ── SynthesizedInsight ─────────────────────────────────

describe("SynthesizedInsight schema", () => {
  const valid = {
    key: "origin",
    value: { ru: "Иран", en: "Iran", he: "איראן", ar: "إيران" },
    confidence: 0.85,
    sourceUrls: ["https://t.me/channel/123"],
  };

  it("accepts valid synthesized insight", () => {
    expect(() => SynthesizedInsight.parse(valid)).not.toThrow();
  });

  it("accepts empty sourceUrls", () => {
    // Schema allows empty — guardrails catch this separately
    expect(() =>
      SynthesizedInsight.parse({ ...valid, sourceUrls: [] }),
    ).not.toThrow();
  });

  it("rejects missing key", () => {
    const { key: _, ...noKey } = valid;
    expect(() => SynthesizedInsight.parse(noKey)).toThrow();
  });

  it("rejects confidence > 1", () => {
    expect(() =>
      SynthesizedInsight.parse({ ...valid, confidence: 2.0 }),
    ).toThrow();
  });
});

// ── VotedInsight ───────────────────────────────────────

describe("VotedInsight schema", () => {
  const valid = {
    kind: { kind: "eta", value: { kind: "minutes", minutes: 3 } },
    sources: [
      {
        channelId: "@test",
        sourceType: "telegram_channel",
        timestamp: 1700000000,
        text: "ETA 3 min",
      },
    ],
    confidence: 0.8,
    sourceTrust: 0.9,
    timeRelevance: 0.95,
    regionRelevance: 0.9,
    rejectedInsights: [],
  };

  it("accepts valid voted insight", () => {
    expect(() => VotedInsight.parse(valid)).not.toThrow();
  });

  it("rejects empty sources array", () => {
    expect(() => VotedInsight.parse({ ...valid, sources: [] })).toThrow();
  });

  it("accepts insightLocation", () => {
    expect(() =>
      VotedInsight.parse({ ...valid, insightLocation: "exact_user_zone" }),
    ).not.toThrow();
  });

  it("rejects invalid insightLocation", () => {
    expect(() =>
      VotedInsight.parse({ ...valid, insightLocation: "invalid" }),
    ).toThrow();
  });
});

// ── NewsChannelWithUpdates ─────────────────────────────

describe("NewsChannelWithUpdates schema", () => {
  it("accepts channel with messages", () => {
    const ch = {
      channel: "@test",
      processedMessages: [],
      unprocessedMessages: [
        {
          channelId: "@test",
          sourceType: "telegram_channel",
          timestamp: 1700000000,
          text: "Alert",
        },
      ],
    };
    expect(() => NewsChannelWithUpdates.parse(ch)).not.toThrow();
  });

  it("rejects empty channel name", () => {
    expect(() =>
      NewsChannelWithUpdates.parse({
        channel: "",
        processedMessages: [],
        unprocessedMessages: [],
      }),
    ).toThrow();
  });
});
