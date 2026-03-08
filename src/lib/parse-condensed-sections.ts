export interface CondensedSections {
  oneLineSummary?: string;
  commenterProfile?: string;
  corePosition?: string;
  keyRecommendations?: string;
  mainConcerns?: string;
  notableExperiences?: string;
  keyQuotations?: string;
  detailedContent?: string;
}

const SECTION_HEADERS = {
  'ONE-LINE SUMMARY': 'oneLineSummary',
  'COMMENTER PROFILE': 'commenterProfile',
  'CORE POSITION': 'corePosition',
  'KEY RECOMMENDATIONS': 'keyRecommendations',
  'MAIN CONCERNS': 'mainConcerns',
  'NOTABLE EXPERIENCES & INSIGHTS': 'notableExperiences',
  'KEY QUOTATIONS': 'keyQuotations',
} as const;

export function parseCondensedSections(text: string): {
  sections: CondensedSections;
  errors: string[];
} {
  const sections: CondensedSections = {};
  const errors: string[] = [];
  const missingHeaders: string[] = [];
  
  // Create a map for case-insensitive header matching
  const headerMap = new Map<string, string>();
  for (const [header, key] of Object.entries(SECTION_HEADERS)) {
    headerMap.set(header.toUpperCase(), key);
  }
  
  // Split by ### headers
  const parts = text.split(/^###\s+/m);
  
  // First part before any ### should be empty or whitespace
  const intro = parts[0].trim();
  if (intro && !intro.startsWith('#')) {
    errors.push(`Unexpected content before first section: "${intro.substring(0, 50)}..."`);
  }
  
  // Process each section
  const foundHeaders = new Set<string>();
  
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    const lines = part.split('\n');
    const header = lines[0].trim();
    const content = lines.slice(1).join('\n').trim();
    
    // Canonicalize header for matching
    const canonicalHeader = header.toUpperCase();
    
    if (headerMap.has(canonicalHeader)) {
      const key = headerMap.get(canonicalHeader)!;
      sections[key] = content;
      // Store the exact header found (for checking missing headers)
      for (const [originalHeader, _] of Object.entries(SECTION_HEADERS)) {
        if (originalHeader.toUpperCase() === canonicalHeader) {
          foundHeaders.add(originalHeader);
          break;
        }
      }
    } else {
      errors.push(`Unknown section header: "${header}"`);
    }
  }
  
  // Check for missing required headers
  for (const requiredHeader of Object.keys(SECTION_HEADERS)) {
    if (!foundHeaders.has(requiredHeader)) {
      missingHeaders.push(requiredHeader);
    }
  }
  
  if (missingHeaders.length > 0) {
    errors.push(`Missing required sections: ${missingHeaders.join(', ')}`);
  }
  
  return { sections, errors };
}

// Extract specific structured data from sections
export function extractStructuredData(sections: CondensedSections) {
  const result: any = {
    summary: sections.oneLineSummary?.trim(),
    profile: {},
    position: sections.corePosition?.trim(),
    recommendations: [],
    concerns: [],
    experiences: [],
    quotations: []
  };
  
  // Parse commenter profile
  if (sections.commenterProfile) {
    const profileLines = sections.commenterProfile.split('\n');
    for (const line of profileLines) {
      const match = line.match(/^\s*-\s*\*\*([^:]+):\*\*\s*(.+)$/);
      if (match) {
        const [, key, value] = match;
        const normalizedKey = key.toLowerCase().replace(/[^a-z]/g, '');
        result.profile[normalizedKey] = value.trim();
      }
    }
  }
  
  // Parse bullet lists for recommendations, concerns, experiences, quotations
  const parseBulletList = (text: string | undefined): string[] => {
    if (!text) return [];
    const items: string[] = [];
    const lines = text.split('\n');
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('- ') && !trimmed.startsWith('  ')) {
        // Top-level bullet
        items.push(trimmed.substring(2));
      }
    }
    
    return items;
  };
  
  result.recommendations = parseBulletList(sections.keyRecommendations);
  result.concerns = parseBulletList(sections.mainConcerns);
  result.experiences = parseBulletList(sections.notableExperiences);
  
  // Parse quotations (remove surrounding quotes if present)
  const quotes = parseBulletList(sections.keyQuotations);
  result.quotations = quotes.map(q => {
    // Remove surrounding quotes if they exist
    if (q.startsWith('"') && q.endsWith('"')) {
      return q.slice(1, -1);
    }
    return q;
  });
  
  return result;
} 