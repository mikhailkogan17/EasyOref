---
"easyoref": patch
---

fix: injuries_cause field, origin dedup, hit_location, rocket threshold, all-clear notices

- Add `injuries_cause` field ("rocket" | "rushing_to_shelter") — now shown in resolved message as "Пострадавшие: 4 (на пути в укрытие)"
- Fix duplicate country origins (case-insensitive dedup: "Iran" + "iran" → one entry)
- hit_location now prefers specific city names over macro-regions (LLM prompt rule)
- Lower rocket count post-filter thresholds: region_relevance 0.5→0.3, confidence 0.3→0.2 for rocket-only posts
- Rocket display: require confidence ≥ 0.55, show (?) below CERTAIN
- Administrative phase notices (all-clear, shelter-leave) from IDF/Home Front Command: set time_relevance=0, extract no data
