import { Command } from "commander";
import { Database } from "bun:sqlite";
import { createReadStream, readFileSync } from "fs";
import { parse } from "csv-parse";
import { basename, extname } from "path";
import { openDb, withTransaction } from "../lib/database";
import { initDebug, debugLog } from "../lib/debug";
import type { CommentAttributes } from "../types";

export const loadCommentsCommand = new Command("load")
  .description("Load comments from regulations.gov API or CSV file")
  .argument("<source>", "Document ID (e.g., CMS-2025-0050-0031) or path to CSV file")
  .option("-k, --api-key <key>", "Regulations.gov API key", process.env.REGSGOV_API_KEY || "DEMO_KEY")
  .option("--skip-attachments", "Skip downloading attachments")
  .option("-l, --limit <n>", "Stop after N comments", parseInt)
  .option("-d, --debug", "Enable debug output")
  .action(loadComments);

async function loadComments(source: string, options: any) {
  await initDebug(options.debug);
  
  // Determine if source is file or document ID
  const isFile = source.includes(".") || source.includes("/");
  
  if (isFile) {
    await loadFromCsv(source, options);
  } else {
    await loadFromApi(source, options);
  }
}

// Load from regulations.gov API
async function loadFromApi(documentId: string, options: any) {
  console.log(`📥 Loading comments for document ${documentId} from regulations.gov API`);
  
  const db = openDb(documentId);
  const headers = { "X-Api-Key": options.apiKey };
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  
  try {
    // Get document object ID
    console.log("🔍 Resolving document object ID...");
    const docResponse = await fetch(
      `https://api.regulations.gov/v4/documents/${documentId}`,
      { headers }
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
    
    // Fetch agency name if possible
    let agencyName = agencyId;
    try {
      const agencyResponse = await fetch(
        `https://api.regulations.gov/v4/agencies/${agencyId}`,
        { headers }
      );
      if (agencyResponse.ok) {
        const agencyData: any = await agencyResponse.json();
        agencyName = agencyData.data.attributes.name || agencyId;
      }
    } catch (e) {
      console.warn(`⚠️  Could not fetch agency name for ${agencyId}`);
    }
    
    // Insert or update document metadata
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
    
    // Get existing comment count
    const existingCount = db.prepare("SELECT COUNT(*) as count FROM comments").get() as { count: number };
    console.log(`📊 Existing comments in database: ${existingCount.count}`);
    
    // List all comment IDs
    console.log("📋 Fetching comment list...");
    const commentIds: string[] = [];
    let page = 1;
    
    while (true) {
      const url = `https://api.regulations.gov/v4/comments?filter[commentOnId]=${objectId}&page[size]=250&page[number]=${page}`;
      const response = await fetch(url, { headers });
      
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
    const loadedIds = db.prepare("SELECT id FROM comments").all().map((r: any) => r.id);
    const newIds = commentIds.filter(id => !loadedIds.includes(id));
    console.log(`🆕 New comments to load: ${newIds.length}`);
    
    // Apply limit if specified
    const idsToLoad = options.limit ? newIds.slice(0, options.limit - existingCount.count) : newIds;
    console.log(`🎯 Will load ${idsToLoad.length} comments`);
    
    // Prepare statements
    const insertComment = db.prepare("INSERT OR REPLACE INTO comments (id, attributes_json) VALUES (?, ?)");
    const insertAttachment = db.prepare(`
      INSERT OR REPLACE INTO attachments (id, comment_id, format, file_name, url, size, blob_data)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    
    let loaded = 0;
    let skipped = 0;
    
    for (const commentId of idsToLoad) {
      try {
        // 1️⃣ Fetch comment details with relationships to attachments
        const url = `https://api.regulations.gov/v4/comments/${commentId}?include=attachments`;
        const response = await fetch(url, { headers });
        if (!response.ok) {
          console.error(`❌ Failed to fetch comment ${commentId}: ${response.status}`);
          continue;
        }

        const data: any = await response.json();

        // 2️⃣ Gather attachment metadata (+ optional binary)
        type APIAttachment = {
          id: string;
        };

        type AttachmentRecord = {
          id: string;
          fmt: string;
          fileName: string;
          url: string;
          size: number | null;
          blob: Uint8Array | null;
        };

        const attachments: AttachmentRecord[] = [];
        let attachmentFailures = 0;

        const relationshipData: APIAttachment[] = data.data.relationships?.attachments?.data || [];

        for (const rel of relationshipData) {
          const attUrl = `https://api.regulations.gov/v4/attachments/${rel.id}?include=fileFormats`;
          const attResp = await fetch(attUrl, { headers });
          if (!attResp.ok) {
            console.error(`\n❌ Failed to fetch attachment metadata ${rel.id}: ${attResp.status}`);
            attachmentFailures++;
            continue;
          }

          const attData: any = await attResp.json();

          for (const format of attData.data.attributes.fileFormats || []) {
            const fileUrl: string | undefined = format.downloadUrl || format.fileUrl;
            if (!fileUrl) continue;

            const fmt = (format.fileFormat || format.format || "bin").toLowerCase();
            const fileName = `${rel.id}.${fmt}`;

            let blob: Uint8Array | null = null;
            let size: number | null = format.size || null;

            if (!options.skipAttachments) {
              try {
                const binResp = await fetch(fileUrl, { headers });
                if (binResp.ok) {
                  const buffer = new Uint8Array(await binResp.arrayBuffer());
                  blob = buffer;
                  size = buffer.length;
                  debugLog(`Downloaded ${fileName}: ${size} bytes`);
                } else {
                  console.error(`\n❌ Failed to download attachment ${fileName}: ${binResp.status}`);
                  attachmentFailures++;
                  break; // Skip this comment entirely
                }
              } catch (e) {
                console.error(`\n❌ Error downloading attachment ${fileName}:`, e);
                attachmentFailures++;
                break; // Skip this comment entirely
              }
            }

            attachments.push({ id: format.formatId || rel.id, fmt, fileName, url: fileUrl, size, blob });
          }

          // If we had failures, skip this comment
          if (attachmentFailures > 0) break;

          // modest delay to respect rate limits
          await sleep(1000);
        }

        // 3️⃣ Only save comment if all attachments were successfully downloaded (or skipped)
        if (attachmentFailures > 0 && !options.skipAttachments) {
          console.error(`\n⚠️  Skipping comment ${commentId} due to ${attachmentFailures} attachment failure(s)`);
          skipped++;
          continue;
        }

        withTransaction(db, () => {
          insertComment.run(commentId, JSON.stringify(data.data.attributes));
          for (const att of attachments) {
            insertAttachment.run(
              att.id,
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
            const resp = await fetch(url);
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
      
      if (loaded % 100 === 0) {
        process.stdout.write(`\r✅ Loaded ${loaded} comments`);
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
