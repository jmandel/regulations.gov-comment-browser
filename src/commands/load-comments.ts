import { Command } from "commander";
import { Database } from "bun:sqlite";
import { createReadStream, readFileSync } from "fs";
import { parse } from "csv-parse";
import { basename, extname } from "path";
import { openDb, withTransaction } from "../lib/database";
import { initDebug, debugLog } from "../lib/debug";
import { runPool } from "../lib/worker-pool";
import type { CommentAttributes } from "../types";

export const loadCommentsCommand = new Command("load")
  .description("Load comments from regulations.gov API, the Mirrulations S3 mirror, or a CSV file")
  .argument("<source>", "Document ID (e.g., CMS-2025-0050-0031) or path to CSV file")
  .option("-k, --api-key <key>", "Regulations.gov API key", process.env.REGSGOV_API_KEY || "DEMO_KEY")
  .option("--skip-attachments", "Skip downloading attachments")
  .option("-l, --limit <n>", "Stop after N comments", parseInt)
  .option("--mirrulations", "Load from the Mirrulations S3 mirror instead of the regulations.gov API (best for large dockets)")
  .option("--whole-docket", "With --mirrulations: include comments on every document in the docket, not just this one")
  .option("--fill-unavailable", "With --mirrulations: fetch comments Mirrulations marks unavailable from the regulations.gov API (needs REGSGOV_API_KEY)")
  .option("-c, --concurrency <n>", "Parallel downloads for --mirrulations (default: 16)", parseInt)
  .option("-d, --debug", "Enable debug output")
  .action(loadComments);

async function loadComments(source: string, options: any) {
  await initDebug(options.debug);

  // Determine if source is file or document ID
  const isFile = source.includes(".") || source.includes("/");

  if (isFile) {
    await loadFromCsv(source, options);
  } else if (options.mirrulations) {
    await loadFromMirrulations(source, options);
  } else {
    await loadFromApi(source, options);
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Accept": "application/pdf,*/*",
};

// Retry-with-backoff fetch: retries 429s, 5xx, and network errors
async function fetchWithRetry(url: string, opts: RequestInit = {}, maxRetries = 10): Promise<Response> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const resp = await fetch(url, opts);
      if (resp.status === 429 || resp.status >= 500) {
        const backoff = Math.min(5000 * Math.pow(2, attempt), 120000);
        console.log(`   ⏳ ${resp.status} from ${new URL(url).host}, waiting ${(backoff/1000).toFixed(0)}s (attempt ${attempt+1}/${maxRetries})...`);
        await sleep(backoff);
        continue;
      }
      return resp;
    } catch (e) {
      const backoff = Math.min(2000 * Math.pow(2, attempt), 60000);
      debugLog(`Network error fetching ${url}: ${e}; retrying in ${backoff}ms`);
      await sleep(backoff);
    }
  }
  // Last attempt, return whatever we get
  return fetch(url, opts);
}

type AttachmentRecord = {
  id: string;
  fmt: string;
  fileName: string;
  url: string;
  size: number | null;
  blob: Uint8Array | null;
};

function saveComment(db: Database, commentId: string, attributes: CommentAttributes, attachments: AttachmentRecord[]) {
  withTransaction(db, () => {
    db.prepare("INSERT OR REPLACE INTO comments (id, attributes_json) VALUES (?, ?)")
      .run(commentId, JSON.stringify(attributes));
    const insertAttachment = db.prepare(`
      INSERT OR REPLACE INTO attachments (id, comment_id, format, file_name, url, size, blob_data)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const att of attachments) {
      insertAttachment.run(att.id, commentId, att.fmt, att.fileName, att.url, att.size, att.blob);
    }
  });
}

async function fetchAgencyName(agencyId: string, apiKey: string): Promise<string> {
  try {
    const resp = await fetchWithRetry(`https://api.regulations.gov/v4/agencies/${agencyId}`, { headers: { "X-Api-Key": apiKey } });
    if (resp.ok) {
      const data: any = await resp.json();
      return data.data.attributes.name || agencyId;
    }
  } catch (e) {}
  console.warn(`⚠️  Could not fetch agency name for ${agencyId}`);
  return agencyId;
}

function saveDocumentMetadata(db: Database, documentId: string, docAttrs: any, agencyId: string, agencyName: string) {
  db.prepare(`
    INSERT OR REPLACE INTO document_metadata (
      document_id, title, docket_id, agency_id, agency_name,
      document_type, posted_date, comment_start_date, comment_end_date,
      metadata_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(
    documentId,
    docAttrs.title || documentId,
    docAttrs.docketId || documentId,
    agencyId,
    agencyName,
    docAttrs.documentType || 'Unknown',
    docAttrs.postedDate || null,
    docAttrs.commentStartDate || null,
    docAttrs.commentEndDate || null,
    JSON.stringify(docAttrs)
  );
  console.log(`💾 Saved document metadata: ${docAttrs.title || documentId}`);
}

// Fetch one comment (and its attachments) from the regulations.gov API.
// Returns null if the comment or any attachment could not be fetched.
async function fetchCommentFromApi(
  commentId: string,
  apiKey: string,
  skipAttachments: boolean
): Promise<{ attributes: CommentAttributes; attachments: AttachmentRecord[] } | null> {
  const headers = { "X-Api-Key": apiKey };

  // 1️⃣ Fetch comment details with relationships to attachments
  const response = await fetchWithRetry(`https://api.regulations.gov/v4/comments/${commentId}?include=attachments`, { headers });
  if (!response.ok) {
    console.error(`❌ Failed to fetch comment ${commentId}: ${response.status}`);
    return null;
  }
  const data: any = await response.json();

  // 2️⃣ Gather attachment metadata (+ optional binary)
  const attachments: AttachmentRecord[] = [];
  const relationshipData: { id: string }[] = data.data.relationships?.attachments?.data || [];

  for (const rel of relationshipData) {
    const attResp = await fetchWithRetry(`https://api.regulations.gov/v4/attachments/${rel.id}?include=fileFormats`, { headers });
    if (!attResp.ok) {
      console.error(`\n❌ Failed to fetch attachment metadata ${rel.id}: ${attResp.status}`);
      return null;
    }

    const attData: any = await attResp.json();

    for (const format of attData.data.attributes.fileFormats || []) {
      const fileUrl: string | undefined = format.downloadUrl || format.fileUrl;
      if (!fileUrl) continue;

      const fmt = (format.fileFormat || format.format || "bin").toLowerCase();
      const fileName = `${rel.id}.${fmt}`;

      let blob: Uint8Array | null = null;
      let size: number | null = format.size || null;

      if (!skipAttachments) {
        try {
          const binResp = await fetchWithRetry(fileUrl, { headers: { ...headers, ...BROWSER_HEADERS } });
          if (!binResp.ok) {
            console.error(`\n❌ Failed to download attachment ${fileName}: ${binResp.status}`);
            return null;
          }
          blob = new Uint8Array(await binResp.arrayBuffer());
          size = blob.length;
          debugLog(`Downloaded ${fileName}: ${size} bytes`);
        } catch (e) {
          console.error(`\n❌ Error downloading attachment ${fileName}:`, e);
          return null;
        }
      }

      attachments.push({ id: format.formatId || rel.id, fmt, fileName, url: fileUrl, size, blob });
    }

    // modest delay to respect rate limits
    await sleep(1000);
  }

  return { attributes: data.data.attributes, attachments };
}

// Load from regulations.gov API
async function loadFromApi(documentId: string, options: any) {
  console.log(`📥 Loading comments for document ${documentId} from regulations.gov API`);

  const db = openDb(documentId);
  const headers = { "X-Api-Key": options.apiKey };

  try {
    // Get document object ID
    console.log("🔍 Resolving document object ID...");
    const docResponse = await fetchWithRetry(
      `https://api.regulations.gov/v4/documents/${documentId}`, { headers }
    );

    if (!docResponse.ok) {
      throw new Error(`Failed to fetch document: ${docResponse.status} ${docResponse.statusText}`);
    }

    const docData: any = await docResponse.json();
    const objectId = docData.data.attributes.objectId;
    debugLog(`Object ID: ${objectId}`);

    // Save document metadata
    const docAttrs = docData.data.attributes;
    const agencyId = docAttrs.agencyId || documentId.split('-')[0];
    saveDocumentMetadata(db, documentId, docAttrs, agencyId, await fetchAgencyName(agencyId, options.apiKey));

    // Get existing comment count
    const existingCount = db.prepare("SELECT COUNT(*) as count FROM comments").get() as { count: number };
    console.log(`📊 Existing comments in database: ${existingCount.count}`);

    // List all comment IDs
    console.log("📋 Fetching comment list...");
    const commentIds: string[] = [];
    let page = 1;

    while (true) {
      const url = `https://api.regulations.gov/v4/comments?filter[commentOnId]=${objectId}&page[size]=250&page[number]=${page}`;
      const response = await fetchWithRetry(url, { headers });

      if (!response.ok) {
        throw new Error(`Failed to fetch comments: ${response.status} ${response.statusText}`);
      }

      const data: any = await response.json();
      if (!data.data || data.data.length === 0) break;

      commentIds.push(...data.data.map((c: any) => c.id));
      console.log(`  Page ${page}: ${data.data.length} comments (total: ${commentIds.length})`);

      if (data.data.length < 250) break;
      page++;
      await sleep(1200); // Rate limiting
    }

    console.log(`📊 Total comments available: ${commentIds.length}`);

    // Filter out already loaded comments
    const loadedIds = new Set(db.prepare("SELECT id FROM comments").all().map((r: any) => r.id));
    const newIds = commentIds.filter(id => !loadedIds.has(id));
    console.log(`🆕 New comments to load: ${newIds.length}`);

    // Apply limit if specified
    const idsToLoad = options.limit ? newIds.slice(0, options.limit - existingCount.count) : newIds;
    console.log(`🎯 Will load ${idsToLoad.length} comments`);

    let loaded = 0;
    let skipped = 0;

    for (const commentId of idsToLoad) {
      try {
        const result = await fetchCommentFromApi(commentId, options.apiKey, !!options.skipAttachments);
        if (!result) {
          console.error(`\n⚠️  Skipping comment ${commentId} due to fetch failure`);
          skipped++;
          continue;
        }

        saveComment(db, commentId, result.attributes, result.attachments);

        loaded++;
        process.stdout.write(`\r✅ Loaded ${loaded}/${idsToLoad.length} comments`);

        await sleep(1200); // Rate limiting between comments
      } catch (error) {
        console.error(`\n❌ Error loading comment ${commentId}:`, error);
      }
    }

    console.log(`\n✅ Successfully loaded ${loaded} comments`);
    if (skipped > 0) {
      console.log(`⚠️  Skipped ${skipped} comments due to attachment failures`);
      console.log(`💡 To retry these comments, run the load command again`);
    }

  } finally {
    db.close();
  }
}

// Mirrulations (https://github.com/MoravianUniversity/mirrulations) mirrors regulations.gov
// into a public S3 bucket, one prefix per docket:
//   raw-data/<agency>/<docket>/text-<docket>/documents/<documentId>.json
//   raw-data/<agency>/<docket>/text-<docket>/comments/<commentId>.json   (or <commentId>_UNAVAILABLE)
//   raw-data/<agency>/<docket>/binary-<docket>/comments_attachments/<commentId>_attachment_<n>.<fmt>
// Comment JSON is the same shape as the API's `comments/<id>?include=attachments` response.
const MIRRULATIONS_BASE = "https://mirrulations.s3.amazonaws.com";

// List all keys under a prefix (anonymous S3 ListObjectsV2)
async function listMirrulationsKeys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | null = null;
  do {
    const params = new URLSearchParams({ "list-type": "2", prefix });
    if (token) params.set("continuation-token", token);
    const resp = await fetchWithRetry(`${MIRRULATIONS_BASE}/?${params}`);
    if (!resp.ok) throw new Error(`Failed to list s3://mirrulations/${prefix}: ${resp.status}`);
    const xml = await resp.text();
    for (const m of xml.matchAll(/<Key>(.*?)<\/Key>/g)) keys.push(m[1]);
    token = xml.match(/<NextContinuationToken>(.*?)<\/NextContinuationToken>/)?.[1] ?? null;
  } while (token);
  return keys;
}

async function loadFromMirrulations(documentId: string, options: any) {
  const docketId = documentId.replace(/-\d+$/, "");
  const agencyId = docketId.split(/[-_]/)[0];
  const textPrefix = `raw-data/${agencyId}/${docketId}/text-${docketId}/`;
  const binaryPrefix = `raw-data/${agencyId}/${docketId}/binary-${docketId}/comments_attachments/`;
  const concurrency = options.concurrency || 16;

  console.log(`📥 Loading comments for document ${documentId} from Mirrulations (s3://mirrulations/${textPrefix})`);
  if (options.wholeDocket) console.log(`   Including comments on all documents in docket ${docketId}`);

  const db = openDb(documentId);

  try {
    // Document metadata (agency name stays as the ID; downstream falls back to agency_id anyway)
    const docResp = await fetchWithRetry(`${MIRRULATIONS_BASE}/${textPrefix}documents/${documentId}.json`);
    if (!docResp.ok) throw new Error(`Document ${documentId} not found in Mirrulations: ${docResp.status}`);
    const docAttrs = ((await docResp.json()) as any).data.attributes;
    saveDocumentMetadata(db, documentId, docAttrs, docAttrs.agencyId || agencyId, docAttrs.agencyId || agencyId);

    // List comments and attachment binaries
    console.log("📋 Listing comments in Mirrulations...");
    const commentKeys = await listMirrulationsKeys(`${textPrefix}comments/`);
    // Mirrulations keeps repeat fetches as "<id>(1).json", "<id>(2).json": one comment per base ID,
    // preferring the unsuffixed file
    const fileForId = new Map<string, string>();
    const unavailable = new Set<string>();
    for (const key of commentKeys) {
      const name = key.slice(key.lastIndexOf("/") + 1);
      if (name.endsWith(".json")) {
        const stem = name.slice(0, -".json".length);
        const id = stem.replace(/\(\d+\)$/, "");
        if (!fileForId.has(id) || stem === id) fileForId.set(id, stem);
      } else if (name.endsWith("_UNAVAILABLE")) {
        unavailable.add(name.slice(0, -"_UNAVAILABLE".length).replace(/\(\d+\)$/, ""));
      }
    }
    const availableIds = [...fileForId.keys()];
    const unavailableIds = [...unavailable].filter(id => !fileForId.has(id));
    console.log(`📊 Mirrulations has ${availableIds.length} comments (${unavailableIds.length} marked unavailable)`);

    const binaryKeys = new Set(options.skipAttachments ? [] : await listMirrulationsKeys(binaryPrefix));
    if (!options.skipAttachments) console.log(`📎 Mirrulations has ${binaryKeys.size} attachment files`);

    const existingCount = db.prepare("SELECT COUNT(*) as count FROM comments").get() as { count: number };
    const loadedIds = new Set(db.prepare("SELECT id FROM comments").all().map((r: any) => r.id));
    const newIds = availableIds.filter(id => !loadedIds.has(id));
    const idsToLoad = options.limit ? newIds.slice(0, Math.max(0, options.limit - existingCount.count)) : newIds;
    console.log(`📊 Existing comments in database: ${existingCount.count}`);
    console.log(`🎯 Will fetch ${idsToLoad.length} comments (concurrency ${concurrency})`);

    let loaded = 0;
    let skipped = 0;
    let otherDocument = 0;
    let fromRegsGov = 0;

    await runPool(idsToLoad, concurrency, async (commentId) => {
      try {
        const resp = await fetchWithRetry(`${MIRRULATIONS_BASE}/${textPrefix}comments/${fileForId.get(commentId)}.json`);
        if (!resp.ok) {
          console.error(`\n❌ Failed to fetch comment ${commentId}: ${resp.status}`);
          skipped++;
          return;
        }
        const data: any = await resp.json();
        const attributes: CommentAttributes = data.data.attributes;

        // Match the API loader's scope (comments on this document) unless --whole-docket
        if (!options.wholeDocket && attributes.commentOnDocumentId && attributes.commentOnDocumentId !== documentId) {
          otherDocument++;
          return;
        }

        const attachments: AttachmentRecord[] = [];
        const included: any[] = (data.included || []).filter((inc: any) => inc.type === "attachments");
        for (const inc of included) {
          for (const format of inc.attributes?.fileFormats || []) {
            const fileUrl: string | undefined = format.fileUrl || format.downloadUrl;
            if (!fileUrl) continue;
            const fmt = (format.format || format.fileFormat || "bin").toLowerCase();

            let blob: Uint8Array | null = null;
            let size: number | null = format.size || null;

            if (!options.skipAttachments) {
              // Prefer the S3 copy; fall back to downloads.regulations.gov if Mirrulations lacks it
              const s3Key = `${binaryPrefix}${commentId}_${basename(new URL(fileUrl).pathname)}`;
              const fromS3 = binaryKeys.has(s3Key);
              if (!fromS3) fromRegsGov++;
              const binResp = await fetchWithRetry(fromS3 ? `${MIRRULATIONS_BASE}/${s3Key}` : fileUrl, fromS3 ? {} : { headers: BROWSER_HEADERS });
              if (!binResp.ok) {
                console.error(`\n❌ Failed to download attachment ${inc.id}.${fmt} for ${commentId}: ${binResp.status}`);
                skipped++;
                return; // Skip this comment entirely
              }
              blob = new Uint8Array(await binResp.arrayBuffer());
              size = blob.length;
              debugLog(`Downloaded ${inc.id}.${fmt} (${fromS3 ? "s3" : "regulations.gov"}): ${size} bytes`);
            }

            attachments.push({ id: inc.id, fmt, fileName: `${inc.id}.${fmt}`, url: fileUrl, size, blob });
          }
        }

        saveComment(db, commentId, attributes, attachments);
        loaded++;
        process.stdout.write(`\r✅ Loaded ${loaded}/${idsToLoad.length} comments (${skipped} skipped, ${otherDocument} on other documents)`);
      } catch (error) {
        console.error(`\n❌ Error loading comment ${commentId}:`, error);
        skipped++;
      }
    });

    console.log(`\n✅ Loaded ${loaded} comments from Mirrulations`);
    if (fromRegsGov > 0) console.log(`📎 ${fromRegsGov} attachment files were missing from S3 and fetched from regulations.gov`);
    if (otherDocument > 0) console.log(`⏭️  Ignored ${otherDocument} comments on other documents in the docket (use --whole-docket to include them)`);

    // Comments Mirrulations couldn't fetch: try the regulations.gov API directly
    const missingIds = unavailableIds.filter(id => !loadedIds.has(id));
    if (missingIds.length > 0 && !options.fillUnavailable) {
      console.log(`⏭️  ${missingIds.length} comments are marked unavailable in Mirrulations (use --fill-unavailable to fetch them from the regulations.gov API)`);
    } else if (missingIds.length > 0) {
      console.log(`🔁 Fetching ${missingIds.length} comments marked unavailable in Mirrulations from regulations.gov API...`);
      let recovered = 0;
      for (const commentId of missingIds) {
        try {
          const result = await fetchCommentFromApi(commentId, options.apiKey, !!options.skipAttachments);
          if (!result) {
            skipped++;
            continue;
          }
          if (!options.wholeDocket && result.attributes.commentOnDocumentId && result.attributes.commentOnDocumentId !== documentId) {
            continue;
          }
          saveComment(db, commentId, result.attributes, result.attachments);
          recovered++;
          process.stdout.write(`\r✅ Recovered ${recovered}/${missingIds.length} comments from regulations.gov`);
        } catch (error) {
          console.error(`\n❌ Error loading comment ${commentId}:`, error);
          skipped++;
        }
        await sleep(1200); // Rate limiting between comments
      }
      console.log(`\n✅ Recovered ${recovered} comments from regulations.gov`);
    }

    if (skipped > 0) {
      console.log(`⚠️  Skipped ${skipped} comments due to fetch failures`);
      console.log(`💡 To retry these comments, run the load command again`);
    }
  } finally {
    db.close();
  }
}

// Load from CSV file
async function loadFromCsv(csvPath: string, options: any) {
  console.log(`📥 Loading comments from CSV file: ${csvPath}`);
  
  // Extract document ID from CSV filename or use generic ID
  const csvBasename = basename(csvPath, extname(csvPath));
  const documentId =  csvBasename;
  
  console.log(`📄 Using document ID: ${documentId}`);
  
  const db = openDb(documentId);
  
  // Prepare statements
  const insertComment = db.prepare("INSERT OR REPLACE INTO comments (id, attributes_json) VALUES (?, ?)");
  const insertAttachment = db.prepare(`
    INSERT OR REPLACE INTO attachments (id, comment_id, format, file_name, url, size, blob_data)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  
  // CSV field mapping
  const fieldMap: Record<string, keyof CommentAttributes> = {
    "Document ID": "id",
    "Agency ID": "agencyId",
    "Docket ID": "docketId",
    "Document Type": "documentType",
    "Title": "title",
    "Posted Date": "postedDate",
    "Comment": "comment",
    "First Name": "firstName",
    "Last Name": "lastName",
    "Organization Name": "organization",
    "Submitter Representative": "submitterRep",
    "Category": "category",
    "State/Province": "stateProvinceRegion",
    "Country": "country",
    "Received Date": "receiveDate",
    "Page Count": "pageCount",
  };
  
  // Get existing count
  const existingCount = db.prepare("SELECT COUNT(*) as count FROM comments").get() as { count: number };
  const skipCount = existingCount.count;
  console.log(`📊 Existing comments: ${existingCount.count}`);
  
  // Parse CSV
  const parser = createReadStream(csvPath, "utf8").pipe(
    parse({
      columns: true,
      skip_empty_lines: true,
    })
  );
  
  let processed = 0;
  let loaded = 0;
  let skipped = 0;
  
  try {
    for await (const row of parser) {
      processed++;
      
      // Skip already loaded rows
      if (processed <= skipCount) continue;
      
      // Check limit
      if (options.limit && loaded >= options.limit) {
        console.log(`\n🛑 Reached limit of ${options.limit} comments`);
        break;
      }
      
      const commentId = row["Document ID"] || `row${processed}`;
      
      // Build attributes object
      const attributes: CommentAttributes = {};
      for (const [csvField, attrField] of Object.entries(fieldMap)) {
        if (row[csvField]) {
          if (attrField === "pageCount") {
            const parsed = parseInt(row[csvField]);
            if (!isNaN(parsed)) {
              attributes[attrField] = parsed;
            }
          } else {
            attributes[attrField] = row[csvField];
          }
        }
      }
      
      // Handle display properties
      const displayProps = row["Display Properties (Name, Label, Tooltip)"];
      if (displayProps) {
        attributes.displayProperties = displayProps
          .split(";")
          .map((s: string) => s.trim())
          .filter(Boolean)
          .map((piece: string) => {
            const [name, label, tooltip] = piece.split(/\s*,\s*/);
            return { name, label, tooltip };
          });
      }
      
      // Gather attachment info (and optionally download files)
      const urls = (
        (row["Attachment Files"] || "") + ";" + (row["Content Files"] || "")
      )
        .split(/[\s;,|]+/)
        .map(u => u.trim())
        .filter(Boolean);

      type AttachmentData = {
        attachId: string;
        fmt: string;
        fileName: string;
        url: string;
        size: number | null;
        blob: Uint8Array | null;
      };

      const attachments: AttachmentData[] = [];
      let attachmentFailures = 0;

      for (let i = 0; i < urls.length; i++) {
        const url = urls[i];
        const fmt = extname(url).replace(".", "").toLowerCase() || "bin";
        const attachId = `${commentId}-att${i + 1}`;
        const fileName = basename(url);

        let size: number | null = null;
        let blob: Uint8Array | null = null;

        if (!options.skipAttachments) {
          try {
            const resp = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", "Accept": "application/pdf,*/*" } });
            if (resp.ok) {
              const buffer = new Uint8Array(await resp.arrayBuffer());
              blob = buffer;
              size = buffer.length;
              debugLog(`Downloaded ${fileName}: ${size} bytes`);
            } else {
              console.error(`❌ Failed to download attachment ${fileName}: ${resp.status}`);
              attachmentFailures++;
              break; // Skip this comment entirely
            }
          } catch (e) {
            console.error(`❌ Error downloading attachment ${fileName}:`, e);
            attachmentFailures++;
            break; // Skip this comment entirely
          }
        }

        attachments.push({ attachId, fmt, fileName, url, size, blob });
      }

      // Only save comment if all attachments were successfully downloaded (or skipped)
      if (attachmentFailures > 0 && !options.skipAttachments) {
        console.error(`⚠️  Skipping comment ${commentId} due to ${attachmentFailures} attachment failure(s)`);
        skipped++;
        continue;
      }

      // Save comment & attachments inside a single transaction (sync)
      withTransaction(db, () => {
        insertComment.run(commentId, JSON.stringify(attributes));

        for (const att of attachments) {
          insertAttachment.run(
            att.attachId,
            commentId,
            att.fmt,
            att.fileName,
            att.url,
            att.size,
            att.blob
          );
        }
      });
      
      loaded++;
      
      if (loaded % 5 === 0 || loaded === 1) {
        process.stdout.write(`\r📥 Loaded ${loaded} comments (${skipped} skipped)...`);
      }
    }
    
    console.log(`\n✅ Successfully loaded ${loaded} new comments (${existingCount.count + loaded} total)`);
    if (skipped > 0) {
      console.log(`⚠️  Skipped ${skipped} comments due to attachment failures`);
      console.log(`💡 To retry these comments, run the load command again`);
    }
    
  } finally {
    db.close();
  }
}
