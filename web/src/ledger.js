// Ledger row helpers. Pure JavaScript with no imports, so the web checks
// (plain node scripts) can use them as well as the screens.

// The id of the entry that replaced this one, or null. Newer servers send
// correctedById; otherwise the corrects_id links say the same.
export function supersededById(entry, all) {
  if (entry.correctedById !== undefined) return entry.correctedById;
  return (all ?? []).find((x) => x.corrects_id === entry.id)?.id ?? null;
}

// The id of the one entry that may show "Fix this entry", or null: the
// shop's latest entry (highest seq, ties by id, as the server picks it),
// unless it is itself a correction or was already corrected. Newer servers
// send correctedById; otherwise the corrects_id links say the same.
export function fixableEntryId(entries) {
  const all = entries ?? [];
  if (all.length === 0) return null;
  const latest = all.reduce((a, b) => (b.seq > a.seq || (b.seq === a.seq && b.id > a.id) ? b : a));
  if (latest.type === "correction") return null;
  if (supersededById(latest, all) != null) return null;
  return latest.id;
}
