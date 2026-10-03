import type { Database } from "bun:sqlite";

// Docket, title and agency for a document's database, with fallbacks for older databases: some
// were loaded before document_metadata existed, and some documents' stored title is only their
// Federal Register document number. Shared by the website build, landing page and skill export so
// they agree on docket IDs (used in URLs) and titles.
export interface DocumentInfo {
  docketId: string;
  title: string;
  agency: string;
  agencyId?: string;
  documentType?: string;
  commentStartDate?: string;
  commentEndDate?: string;
}

export function readDocumentInfo(db: Database, documentId: string): DocumentInfo {
  let meta: any = null;
  try {
    meta = db.prepare(`
      SELECT docket_id, title, document_type, agency_id, agency_name, comment_start_date, comment_end_date, metadata_json
      FROM document_metadata LIMIT 1
    `).get();
  } catch {
    // no document_metadata table
  }

  // Comment IDs carry the docket ID as their prefix (CMS-2026-2377-0042 → CMS-2026-2377)
  const firstCommentId = (db.prepare("SELECT id FROM comments ORDER BY id LIMIT 1").get() as { id?: string } | null)?.id;
  const docketId = meta?.docket_id || firstCommentId?.match(/^(.+)-\d+$/)?.[1] || documentId;

  let title: string | undefined = meta?.title;
  if (title && /^\d{4}-\d+$/.test(title.trim())) {
    try { title = JSON.parse(meta?.metadata_json || "{}").subject || title; } catch {}
  }

  return {
    docketId,
    title: title || docketId,
    agency: meta?.agency_name || meta?.agency_id || docketId.split("-")[0] || "Unknown Agency",
    agencyId: meta?.agency_id || undefined,
    documentType: meta?.document_type || undefined,
    commentStartDate: meta?.comment_start_date || undefined,
    commentEndDate: meta?.comment_end_date || undefined,
  };
}
