# FloodGate

A proof-of-concept demonstration tool showing how AI can generate thousands of unique, authentic-seeming public comments that share core arguments but vary dramatically in expression.

## ⚠️ IMPORTANT DISCLAIMER

**This is a research demonstration tool only.** It should NOT be used to generate actual public comments for submission to government agencies. Always write your own authentic comments when participating in public comment processes.

## Purpose

FloodGate demonstrates:
- How future form letter campaigns might evolve using AI
- Why traditional clustering algorithms (n-gram similarity) will fail against AI-generated variations
- The need for new detection methods and policies

## Features

### Conceptual Variation (Not Templates)
- Uses conceptual frameworks instead of phrase templates
- Arguments are expressed as ideas to convey, not strings to copy
- Natural language variation based on concepts

### Multi-Dimensional Control
- 8 tone dimensions (formality, emotionality, urgency, etc.)
- 5 argument dimensions (legal, moral, practical, economic, personal)
- Multiple personas and writing styles
- Personal information integration

### Authentic Generation
- Each comment is unique
- Natural transitions and connections
- Appropriate tone consistency
- Optional typos and imperfections for authenticity

## Development

```bash
# Install dependencies
bun install

# Run development server
bun run index.html

# Build for production
bun build index.html --outdir=dist --minify
```

## Loading External Campaigns

FloodGate supports loading campaign configurations from external JSON files via URL parameters:

```
index.html?campaign=<url-to-campaign-json>
```

### Examples:
- **Default (no parameter)**: Loads `./floodgate-example-work-requirements.json`
- **Local file**: `?campaign=./my-custom-campaign.json`
- **Remote URL**: `?campaign=https://example.com/campaign.json`
- **GitHub raw**: `?campaign=https://raw.githubusercontent.com/user/repo/main/campaign.json`

The JSON file must conform to the `FormGenCampaign` interface defined in `floodgate-types.ts`.

## How It Works

1. **Randomization**: Settings are randomized on each page load for variety
2. **Concept Selection**: Random concepts are selected from each category
3. **Prompt Generation**: A detailed prompt is built with concepts, not templates
4. **LLM Generation**: Users copy the prompt to their preferred LLM to generate unique comments

## Technical Details

- Built with React and TypeScript
- Uses Bun for bundling and development
- Ocean-themed UI with wave animations
- No backend required - fully client-side

## Files

- `app.tsx` - Main React application
- `app.css` - Ocean-themed styling
- `floodgate-example-work-requirements.json` - Example campaign configuration (PRWORA work requirements)
- `floodgate-types.ts` - TypeScript interfaces for the FloodGate data structure
- `blog-post-floodgate.md` - Detailed explanation of the project

## Ethics

This tool is designed to:
1. Start conversations about AI's impact on democratic participation
2. Motivate development of better detection methods
3. Encourage proactive policy development
4. Demonstrate the need for transparency in AI-assisted communication

## License

Open source - part of the regulations.gov-comment-browser project