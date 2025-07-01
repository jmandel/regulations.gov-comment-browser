/**
 * Example usage of the Regulations Browser MCP
 * 
 * This demonstrates how to use the MCP tools to explore and analyze
 * public comments on federal regulations.
 */

// Note: In real usage, these would be MCP tool calls through your MCP client

async function exploreRegulations() {
  console.log("=== Regulations Browser MCP Example ===\n");

  // Step 1: List available dockets
  console.log("1. Listing available regulation dockets:");
  const dockets = await listDockets();
  console.log(`Found ${dockets.dockets.length} dockets`);
  dockets.dockets.forEach(d => {
    console.log(`- ${d.id}: Generated ${d.generatedAt} (${d.totalComments} comments)`);
  });

  // For this example, we'll use the first docket
  const docketId = dockets.dockets[0].id;
  console.log(`\nUsing docket: ${docketId}\n`);

  // Step 2: Explore themes
  console.log("2. Exploring theme taxonomy:");
  const themes = await listThemes({ docketId });
  console.log("Top-level themes:");
  themes.forEach(theme => {
    console.log(`- ${theme.code}: ${theme.description} (${theme.comment_count} comments)`);
    if (theme.children.length > 0) {
      console.log(`  Sub-themes: ${theme.children.join(', ')}`);
    }
  });

  // Step 3: Explore entities
  console.log("\n3. Major stakeholders (entities with 10+ mentions):");
  const entities = await listEntities({ 
    docketId, 
    minMentions: 10 
  });
  Object.entries(entities).forEach(([category, entityList]) => {
    console.log(`\n${category}:`);
    entityList.forEach(e => {
      console.log(`- ${e.label} (${e.mentionCount} mentions)`);
    });
  });

  // Step 4: Search for specific topics
  console.log("\n4. Searching for prior authorization comments from healthcare organizations:");
  const searchResults = await searchComments({
    docketId,
    query: '"prior authorization" entity:"Healthcare Organizations"',
    limit: 5,
    returnType: 'snippets'
  });
  console.log(`Found ${searchResults.totalCount} matching comments`);
  searchResults.results.forEach((result, i) => {
    console.log(`\nComment ${i + 1}: ${result.submitter} (${result.submitterType})`);
    result.snippets.forEach(snippet => {
      console.log(`- ${snippet.field}: ...${snippet.text}...`);
    });
  });

  // Step 5: Get detailed theme analysis
  console.log("\n5. Getting detailed analysis for a theme:");
  // Assuming theme 2.1 exists and is about prior authorization
  const themeSummary = await getThemeSummary({
    docketId,
    themeCode: '2.1'
  });
  console.log(`\nTheme ${themeSummary.themeCode}: ${themeSummary.themeDescription}`);
  console.log(`Comments analyzed: ${themeSummary.commentCount}`);
  console.log(`\nOverview: ${themeSummary.sections.overview}`);
  console.log(`\nTop recommendations:`);
  themeSummary.sections.recommendations.slice(0, 3).forEach(rec => {
    console.log(`- ${rec.recommendation} (Support: ${rec.supportLevel})`);
    console.log(`  Rationale: ${rec.rationale}`);
  });

  // Step 6: Get specific comment details
  console.log("\n6. Getting detailed information from a specific comment:");
  if (searchResults.results.length > 0) {
    const commentId = searchResults.results[0].commentId;
    const comment = await getComment({
      docketId,
      commentId,
      fields: {
        oneLineSummary: true,
        keyRecommendations: true,
        mainConcerns: true,
        themeScores: true
      }
    });
    console.log(`\nComment ${commentId}:`);
    console.log(`Summary: ${comment.oneLineSummary}`);
    console.log(`\nMain concerns:`);
    comment.mainConcerns.forEach(concern => console.log(`- ${concern}`));
    console.log(`\nKey recommendations:`);
    comment.keyRecommendations.forEach(rec => console.log(`- ${rec}`));
    console.log(`\nTheme relevance:`);
    Object.entries(comment.themeScores).forEach(([theme, score]) => {
      console.log(`- Theme ${theme}: ${score}/3`);
    });
  }
}

// Example workflow for analyzing a specific topic
async function analyzeSpecificTopic(docketId: string, topic: string) {
  console.log(`\n=== Analyzing "${topic}" ===\n`);

  // 1. Find relevant themes
  const themes = await listThemes({ docketId });
  const relevantThemes = themes.filter(t => 
    t.description.toLowerCase().includes(topic.toLowerCase())
  );

  // 2. Search for comments
  const results = await searchComments({
    docketId,
    query: topic,
    limit: 100,
    sortBy: 'relevance'
  });

  // 3. Analyze sentiment and positions
  const supportCount = results.results.filter(r => 
    r.snippets?.some(s => s.text.toLowerCase().includes('support'))
  ).length;
  
  const opposeCount = results.results.filter(r =>
    r.snippets?.some(s => s.text.toLowerCase().includes('oppose'))
  ).length;

  console.log(`Analysis of "${topic}":`);
  console.log(`- Total comments mentioning topic: ${results.totalCount}`);
  console.log(`- Comments expressing support: ~${supportCount}`);
  console.log(`- Comments expressing opposition: ~${opposeCount}`);
  console.log(`- Related themes: ${relevantThemes.map(t => t.description).join(', ')}`);

  // 4. Get theme summaries for deeper insights
  for (const theme of relevantThemes.slice(0, 2)) {
    const summary = await getThemeSummary({
      docketId,
      themeCode: theme.code
    });
    console.log(`\nInsights from theme "${theme.description}":`);
    console.log(`- ${summary.sections.overview}`);
  }
}

// Example: Finding comments from specific stakeholder groups
async function analyzeStakeholderPerspectives(docketId: string, stakeholderType: string) {
  console.log(`\n=== Analyzing ${stakeholderType} Perspectives ===\n`);

  // Search for comments from this stakeholder type
  const results = await searchComments({
    docketId,
    query: '',  // No keyword filter
    searchFields: { detailedContent: true },
    returnType: 'fields',
    returnFields: {
      oneLineSummary: true,
      corePosition: true,
      submitterType: true,
      keyRecommendations: true
    },
    limit: 1000
  });

  // Filter to specific stakeholder type
  const stakeholderComments = results.results.filter(r =>
    r.fields?.submitterType?.toLowerCase().includes(stakeholderType.toLowerCase())
  );

  console.log(`Found ${stakeholderComments.length} comments from ${stakeholderType}`);

  // Analyze common positions
  const positions = new Map<string, number>();
  stakeholderComments.forEach(comment => {
    const position = comment.fields?.corePosition;
    if (position) {
      positions.set(position, (positions.get(position) || 0) + 1);
    }
  });

  console.log("\nCommon positions:");
  Array.from(positions.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .forEach(([position, count]) => {
      console.log(`- "${position}" (${count} comments)`);
    });

  // Extract common recommendations
  const allRecommendations = stakeholderComments
    .flatMap(c => c.fields?.keyRecommendations || []);
  
  console.log(`\nTotal recommendations from ${stakeholderType}: ${allRecommendations.length}`);
}

// Note: These function calls would be replaced with actual MCP tool calls
// through your MCP client in real usage