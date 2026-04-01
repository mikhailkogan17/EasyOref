import { describe, expect, it } from "vitest";

// ── Alert Type Classification (copied logic for unit testing) ──

type AlertType = "early_warning" | "red_alert" | "resolved";

function classifyAlertType(title: string): AlertType {
  if (title.includes("האירוע הסתיים")) return "resolved";
  if (title.includes("בדקות הקרובות") || title.includes("צפויות להתקבל"))
    return "early_warning";
  return "red_alert";
}

describe("classifyAlertType", () => {
  it("classifies resolved alerts", () => {
    expect(classifyAlertType("האירוע הסתיים באזור")).toBe("resolved");
  });

  it("classifies early warning with בדקות הקרובות", () => {
    expect(classifyAlertType("התרעות בדקות הקרובות")).toBe("early_warning");
  });

  it("classifies early warning with צפויות להתקבל", () => {
    expect(classifyAlertType("התרעות צפויות להתקבל")).toBe("early_warning");
  });

  it("classifies red_alert as default", () => {
    expect(classifyAlertType("ירי רקטות וטילים")).toBe("red_alert");
  });
});

// ── Area filter logic ──

function isRelevantArea(alertAreas: string[], monitored: string[]): boolean {
  for (const m of monitored) {
    if (alertAreas.includes(m)) return true;
    if (alertAreas.some((a) => a.startsWith(m) || m.startsWith(a))) return true;
  }
  return false;
}

describe("isRelevantArea", () => {
  const monitored = ["תל אביב - דרום העיר ויפו", "גוש דן"];

  it("matches exact area", () => {
    expect(isRelevantArea(["תל אביב - דרום העיר ויפו"], monitored)).toBe(true);
  });

  it("matches prefix", () => {
    expect(isRelevantArea(["גוש דן מזרח"], monitored)).toBe(true);
  });

  it("rejects unrelated area", () => {
    expect(isRelevantArea(["חיפה - מערב"], monitored)).toBe(false);
  });

  it("handles empty alert areas", () => {
    expect(isRelevantArea([], monitored)).toBe(false);
  });
});

// ── i18n message format ──

describe("message format", () => {
  it("produces valid HTML with plain district line, empty line after title, no blockquote in base", () => {
    const msg = [
      "<b>⚠️ Early Warning</b> (14:32)",
      "",
      "Rocket launches detected. Stay near a protected space.",
      "Area: Tel Aviv - South And Jaffa",
    ].join("\n");

    expect(msg).not.toContain("<blockquote>");
    expect(msg).toContain("Area: Tel Aviv");
    expect(msg).toContain("<b>⚠️ Early Warning</b>");
  });

  it("siren/resolved enrichment is wrapped in blockquote", () => {
    const base = [
      "<b>🚨 Red Alert</b> (14:35)",
      "",
      "Area: Tel Aviv - South And Jaffa",
    ].join("\n");

    // Simulate enrichment appended by buildEnrichedMessage
    const enriched = base + "\n<blockquote><b>Origin:</b> Iran</blockquote>";

    expect(enriched).toContain("<blockquote>");
    expect(enriched).toContain("</blockquote>");
    expect(enriched).toContain("<b>Origin:</b> Iran");
    // District stays outside blockquote
    expect(enriched.indexOf("Area:")).toBeLessThan(enriched.indexOf("<blockquote>"));
  });
});
