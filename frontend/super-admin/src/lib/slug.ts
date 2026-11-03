// The Organization Service allows slugs up to 100 characters; leave room for a uniqueness suffix.
const MAX_BASE_LENGTH = 80;

export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip accents: "Société" -> "Societe"
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_BASE_LENGTH)
    .replace(/-+$/g, "");
  return slug || "org"; // e.g. a name made only of non-latin characters
}

// Candidate slugs to try in order: base, base-2 ... base-6, then base + random suffix.
// Uniqueness itself is enforced by the database; the caller retries when the API answers 409.
export function slugCandidates(base: string, sequentialTries = 6, randomTries = 4): string[] {
  const candidates = [base];
  for (let n = 2; n <= sequentialTries; n++) candidates.push(`${base}-${n}`);
  for (let i = 0; i < randomTries; i++) {
    candidates.push(`${base}-${Math.random().toString(36).slice(2, 8).padEnd(6, "0")}`);
  }
  return candidates;
}
