// Plain-text helpers shared by clustering, triage and transcription.

const ENTITIES: Record<string, string> = {
  nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', mdash: "-", ndash: "-", hellip: "...", bull: " ",
};

// Comment fields arrive as HTML, sometimes double-encoded (&amp;rsquo;)
export function htmlToText(s: string): string {
  for (let i = 0; i < 2; i++) {
    s = s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_, e: string) => {
      if (e[0] === "#") {
        const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : " ";
      }
      return ENTITIES[e.toLowerCase()] ?? " ";
    });
  }
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function wordCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}
