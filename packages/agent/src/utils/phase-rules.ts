/** Phase-specific extraction rule strings for the LLM prompt. */
export function getPhaseRule(alertType: string): string {
  switch (alertType) {
    case "early_warning":
      return "Focus on country_origins, eta, rocket_count, cluser_munition_used. Do NOT extract impact, hits, or casualities in this early phase.";
    case "red_alert":
      return "Focus on country_origins, eta, rocket_count, cluser_munition_used, impact (interceptions, sea falls, open area falls). Do NOT extract casualities or detailed hits yet.";
    case "resolved":
      return "Extract ALL insight kinds: country_origins, rocket_count, impact (interceptions, hits, sea/open area falls), cluser_munition_used, casualities. Prioritize reports with exact numbers or locations.";
    default:
      return "Extract all relevant information about the attack.";
  }
}
