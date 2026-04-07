/** Map synthesis field key → insight kind literal. */
export function fieldKeyToKind(key: string): string {
  const map: Record<string, string> = {
    origin: "country_origins",
    eta_absolute: "eta",
    rocket_count: "rocket_count",
    is_cluster_munition: "cluser_munition_used",
    intercepted: "impact",
    hits: "impact",
    casualties: "casualities",
    no_casualties: "casualities",
    earlyWarningTime: "eta",
  };
  return map[key] ?? key;
}
