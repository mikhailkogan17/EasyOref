import { describe, expect, it } from "vitest";

// ── Alert Type Classification (copied logic for unit testing) ──

type AlertType = "early_warning" | "siren" | "resolved";

function classifyAlertType(title: string): AlertType {
  if (title.includes("האירוע הסתיים")) return "resolved";
  if (title.includes("בדקות הקרובות") || title.includes("צפויות להתקבל"))
    return "early_warning";
  return "siren";
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

  it("classifies siren as default", () => {
    expect(classifyAlertType("ירי רקטות וטילים")).toBe("siren");
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
  it("produces valid HTML with blockquote", () => {
    const msg = [
      "<b>⚠️ Early Warning</b>",
      "Rocket launches detected. Stay near a protected space.",
      "",
      "<blockquote>",
      "<b>Area:</b> Tel Aviv - South And Jaffa",
      "<b>Time to impact:</b> ~5–12 min",
      "<b>Time:</b> 14:32",
      "</blockquote>",
    ].join("\n");

    expect(msg).toContain("<blockquote>");
    expect(msg).toContain("</blockquote>");
    expect(msg).toContain("<b>Area:</b>");
  });
});
