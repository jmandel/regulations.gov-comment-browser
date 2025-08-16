import { Command } from "commander";
import { openDb } from "../lib/database";
import { mkdir, writeFile, readdir } from "fs/promises";
import { join } from "path";

export const generateLandingPageCommand = new Command("generate-landing-page")
  .description("Generate static landing page listing all regulations")
  .option("-d, --db-dir <dir>", "Directory containing SQLite databases", "dbs")
  .option("-o, --output <file>", "Output HTML file path", "dist/index.html")
  .action(generateLandingPage);

interface RegulationInfo {
  id: string;
  title: string;
  docketId: string;
  commentCount: number;
  themeCount: number;
  lastUpdated: string;
  agency: string;
  status: string;
}

async function generateLandingPage(options: any) {
  console.log("🏠 Generating landing page...");
  
  const dbDir = options.dbDir;
  const outputFile = options.output;
  
  // Ensure output directory exists
  const outputDir = join(outputFile, "..");
  await mkdir(outputDir, { recursive: true });
  
  // Find all SQLite databases
  const files = await readdir(dbDir);
  const dbFiles = files.filter(f => {
    // Must end with .sqlite
    if (!f.endsWith('.sqlite')) return false;
    // Exclude WAL/SHM files
    if (f.includes('.sqlite-')) return false;
    // Exclude duplicate .sqlite.sqlite files
    if (f.endsWith('.sqlite.sqlite')) return false;
    // Exclude other sqlite variants
    if (f.includes('.sqlite.')) return false;
    return true;
  });
  
  if (dbFiles.length === 0) {
    console.log("❌ No databases found in", dbDir);
    return;
  }
  
  console.log(`📊 Found ${dbFiles.length} regulation databases`);
  
  // Collect information from each database
  const regulations: RegulationInfo[] = [];
  
  for (const dbFile of dbFiles) {
    const documentId = dbFile.replace('.sqlite', '');
    console.log(`  Processing ${documentId}...`);
    
    try {
      const db = openDb(documentId);
      
      // Read document details from database
      let title = documentId;
      let docketId = documentId;
      let agency = "Unknown Agency";
      
      try {
        // Check if document_metadata table exists and has data
        const hasMetadata = db.prepare(`
          SELECT name FROM sqlite_master 
          WHERE type='table' AND name='document_metadata'
        `).get();
        
        if (hasMetadata) {
          const metadata = db.prepare(`
            SELECT title, docket_id, agency_name, agency_id
            FROM document_metadata
            WHERE document_id = ?
          `).get(documentId) as any;
          
          if (metadata) {
            title = metadata.title || documentId;
            docketId = metadata.docket_id || documentId;
            agency = metadata.agency_name || metadata.agency_id || "Unknown Agency";
          } else {
            console.warn(`  ⚠️  No metadata found in database for ${documentId}`);
          }
        } else {
          console.warn(`  ⚠️  No document_metadata table in database for ${documentId}`);
        }
      } catch (error) {
        console.warn(`  ⚠️  Failed to read metadata for ${documentId}:`, error);
      }
      
      // Get statistics
      const stats = {
        commentCount: (db.prepare("SELECT COUNT(*) as count FROM comments").get() as any).count,
        condensedCount: (db.prepare("SELECT COUNT(*) as count FROM condensed_comments WHERE status = 'completed'").get() as any).count,
        themeCount: (db.prepare("SELECT COUNT(*) as count FROM theme_hierarchy").get() as any).count,
        scoredCount: (db.prepare("SELECT COUNT(DISTINCT comment_id) as count FROM comment_themes").get() as any).count,
        summaryCount: (db.prepare("SELECT COUNT(*) as count FROM theme_summaries").get() as any).count,
      };
      
      // Get last update time
      const lastComment = db.prepare(`
        SELECT created_at 
        FROM comments 
        ORDER BY created_at DESC 
        LIMIT 1
      `).get() as { created_at: string } | undefined;
      
      // Determine processing status
      let status = "Not Started";
      if (stats.summaryCount > 0) {
        status = "Complete";
      } else if (stats.scoredCount > 0) {
        status = "Themes Scored";
      } else if (stats.themeCount > 0) {
        status = "Themes Discovered";
      } else if (stats.condensedCount > 0) {
        status = "Condensed";
      } else if (stats.commentCount > 0) {
        status = "Comments Loaded";
      }
      
      regulations.push({
        id: documentId,
        title,
        docketId,
        commentCount: stats.commentCount,
        themeCount: stats.themeCount,
        lastUpdated: lastComment?.created_at || new Date().toISOString(),
        agency,
        status
      });
      
      db.close();
    } catch (error) {
      console.error(`  ⚠️  Failed to process ${documentId}:`, error);
    }
  }
  
  // Sort by comment count (descending)
  regulations.sort((a, b) => b.commentCount - a.commentCount);
  
  // Generate HTML
  const html = generateHTML(regulations);
  
  // Write output file
  await writeFile(outputFile, html);
  console.log(`✅ Landing page generated at ${outputFile}`);
}

function generateHTML(regulations: RegulationInfo[]): string {
  const totalComments = regulations.reduce((sum, r) => sum + r.commentCount, 0);
  const totalThemes = regulations.reduce((sum, r) => sum + r.themeCount, 0);
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Regulations.gov Comment Browser</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      background: #f8fafc;
      color: #1a202c;
      line-height: 1.6;
    }
    
    .container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 0 1rem;
    }
    
    header {
      background: white;
      border-bottom: 1px solid #e2e8f0;
      padding: 2rem 0;
      margin-bottom: 3rem;
    }
    
    h1 {
      font-size: 2.5rem;
      font-weight: 700;
      color: #2d3748;
      margin-bottom: 0.5rem;
    }
    
    .subtitle {
      font-size: 1.25rem;
      color: #718096;
    }
    
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
      gap: 1.5rem;
      margin-bottom: 3rem;
    }
    
    .stat-card {
      background: white;
      padding: 1.5rem;
      border-radius: 0.5rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    
    .stat-label {
      font-size: 0.875rem;
      color: #718096;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    
    .stat-value {
      font-size: 2rem;
      font-weight: 700;
      color: #2d3748;
      margin-top: 0.25rem;
    }
    
    .regulations-grid {
      display: grid;
      gap: 1.5rem;
      margin-bottom: 3rem;
    }
    
    .regulation-card {
      background: white;
      border-radius: 0.5rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
      transition: all 0.2s;
      overflow: hidden;
    }
    
    .regulation-card:hover {
      box-shadow: 0 4px 6px rgba(0,0,0,0.1);
      transform: translateY(-2px);
    }
    
    .regulation-link {
      display: block;
      padding: 1.5rem;
      text-decoration: none;
      color: inherit;
    }
    
    .regulation-header {
      display: flex;
      justify-content: space-between;
      align-items: start;
      margin-bottom: 1rem;
    }
    
    .regulation-title {
      font-size: 1.25rem;
      font-weight: 600;
      color: #2d3748;
      margin-bottom: 0.25rem;
      line-height: 1.4;
    }
    
    .regulation-id {
      font-size: 0.875rem;
      color: #718096;
      font-family: monospace;
    }
    
    .regulation-status {
      display: inline-block;
      padding: 0.25rem 0.75rem;
      font-size: 0.75rem;
      font-weight: 600;
      border-radius: 9999px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      flex-shrink: 0;
    }
    
    .status-complete {
      background: #c6f6d5;
      color: #276749;
    }
    
    .status-themes-scored {
      background: #bee3f8;
      color: #2c5282;
    }
    
    .status-themes-discovered {
      background: #e9d8fd;
      color: #553c9a;
    }
    
    .status-condensed {
      background: #fed7d7;
      color: #c53030;
    }
    
    .status-comments-loaded {
      background: #feebc8;
      color: #c05621;
    }
    
    .status-not-started {
      background: #e2e8f0;
      color: #4a5568;
    }
    
    .regulation-meta {
      display: flex;
      gap: 2rem;
      font-size: 0.875rem;
      color: #718096;
    }
    
    .meta-item {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    
    .meta-item strong {
      color: #4a5568;
    }
    
    .about-section {
      background: white;
      padding: 2rem;
      border-radius: 0.5rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
      margin-bottom: 3rem;
    }
    
    .about-section h2 {
      font-size: 1.5rem;
      color: #2d3748;
      margin-bottom: 1rem;
    }
    
    .about-section p {
      color: #4a5568;
      margin-bottom: 1rem;
    }
    
    .about-section ul {
      list-style-position: inside;
      color: #4a5568;
      margin-left: 1rem;
    }
    
    .floodgate-section {
      background: linear-gradient(135deg, #0077be 0%, #00a8cc 100%);
      padding: 2rem;
      border-radius: 0.5rem;
      box-shadow: 0 4px 6px rgba(0,0,0,0.1);
      margin-bottom: 3rem;
      color: white;
    }
    
    .floodgate-section h2 {
      font-size: 1.75rem;
      margin-bottom: 1rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    
    .floodgate-section p {
      margin-bottom: 1.5rem;
      opacity: 0.95;
    }
    
    .floodgate-link {
      display: inline-block;
      background: white;
      color: #0077be;
      padding: 0.75rem 1.5rem;
      border-radius: 0.375rem;
      text-decoration: none;
      font-weight: 600;
      transition: all 0.2s;
    }
    
    .floodgate-link:hover {
      transform: translateY(-2px);
      box-shadow: 0 4px 12px rgba(0,0,0,0.2);
    }
    
    .warning-badge {
      display: inline-block;
      background: rgba(255,255,255,0.2);
      padding: 0.25rem 0.75rem;
      border-radius: 9999px;
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-left: 1rem;
    }
    
    footer {
      text-align: center;
      padding: 2rem 0;
      color: #718096;
      font-size: 0.875rem;
    }
    
    footer a {
      color: #4299e1;
      text-decoration: none;
    }
    
    footer a:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <header>
    <div class="container">
      <h1>Regulations.gov Comment Browser</h1>
      <p class="subtitle">AI-powered analysis of public comments on federal regulations</p>
    </div>
  </header>
  
  <main class="container">
    <div class="regulations-grid">
      ${regulations.map(reg => `
      <div class="regulation-card">
        <a href="./${reg.id}/" class="regulation-link">
          <div class="regulation-header">
            <div>
              <h3 class="regulation-title">${escapeHtml(reg.title)}</h3>
              <p class="regulation-id">Docket: ${reg.docketId} | Document: ${reg.id}</p>
            </div>
            <span class="regulation-status status-${reg.status.toLowerCase().replace(/\s+/g, '-')}">${reg.status}</span>
          </div>
          <div class="regulation-meta">
            <div class="meta-item">
              <strong>${reg.agency}</strong>
            </div>
            <div class="meta-item">
              <strong>${reg.commentCount.toLocaleString()}</strong> comments
            </div>
            ${reg.themeCount > 0 ? `
            <div class="meta-item">
              <strong>${reg.themeCount.toLocaleString()}</strong> themes
            </div>
            ` : ''}
          </div>
        </a>
      </div>
      `).join('')}
    </div>
    
    <div class="stats">
      <div class="stat-card">
        <div class="stat-label">Total Regulations</div>
        <div class="stat-value">${regulations.length.toLocaleString()}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Comments</div>
        <div class="stat-value">${totalComments.toLocaleString()}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Themes Discovered</div>
        <div class="stat-value">${totalThemes.toLocaleString()}</div>
      </div>
    </div>
    
    <div class="floodgate-section">
      <h2>
        🌊 FloodGate
        <span class="warning-badge">Research Demo</span>
      </h2>
      <p>
        <strong>Explore the future of public comment campaigns.</strong> FloodGate demonstrates how AI can generate 
        thousands of unique, authentic-seeming comments that share core arguments but vary dramatically in expression. 
        This proof-of-concept tool shows why traditional form letter detection methods may soon become obsolete.
      </p>
      <p>
        Try generating a few comments to see how different they can be while maintaining the same position. 
        This is a research demonstration only—not for actual submission to government agencies.
      </p>
      <a href="./floodgate/" class="floodgate-link">
        Launch FloodGate Demo →
      </a>
    </div>
    
    <div class="about-section">
      <h2>About This Tool</h2>
      <p>
        This browser provides AI-powered analysis of public comments submitted to federal regulations 
        through Regulations.gov. Our system processes thousands of comments to identify key themes, 
        concerns, and recommendations from the public.
      </p>
      <p><strong>Features:</strong></p>
      <ul>
        <li>Automatic theme discovery using hierarchical clustering</li>
        <li>Structured comment summaries highlighting key positions and concerns</li>
        <li>Entity recognition for organizations, regulations, and technical terms</li>
        <li>Interactive browsing by theme, entity, or individual comment</li>
        <li>Export capabilities for further analysis</li>
      </ul>
    </div>
  </main>
  
  <footer>
    <div class="container">
      <p>
        Generated on ${new Date().toLocaleDateString()} | 
        <a href="https://github.com/jmandel/regulations.gov-comment-browser" target="_blank">View on GitHub</a>
      </p>
    </div>
  </footer>
</body>
</html>`;
}

function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, m => map[m]);
}