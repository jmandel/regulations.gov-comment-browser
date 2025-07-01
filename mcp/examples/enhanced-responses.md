# Enhanced MCP Response Examples

This document shows the improved response formats that help LLMs use the MCP tools more effectively.

## searchComments Response

```json
{
  "docketInfo": {
    "documentId": "CMS-2025-0050-0031",
    "totalComments": 199064,
    "totalThemes": 45,
    "totalEntities": 892
  },
  "searchResults": {
    "totalFound": 368,
    "returned": 368,
    "offset": 0,
    "limit": "all"
  },
  "results": [
    {
      "commentId": "CMS-2025-0050-0098",
      "submitter": "Wavital",
      "submitterType": "Private Industry - Health Care",
      "date": "2025-06-17T04:00Z",
      "snippets": [
        {
          "field": "detailedContent",
          "text": "...continuous waveforms and vital signs data is critical for improving patient care and reducing healthcare costs. The ability to access and analyze high-frequency physiological data through TEFCA would enable better clinical decision-making, earlier detection of patient deterioration, and more personalized treatment plans. We strongly urge CMS to prioritize the inclusion of continuous waveforms and vital signs measured at ≥1 Hz in both USCDI and TEFCA by CY 2027. This would utilize existing IEEE 11073 terminology standards and HL7 v2 MDM message formats that are already widely adopted in healthcare settings...",
          "matchStart": 245,
          "matchEnd": 1045
        }
      ]
    }
  ],
  "query": {
    "keywords": ["TEFCA"],
    "entities": [],
    "themes": [],
    "exclude": []
  },
  "suggestions": [
    "To get full comment text, re-run with returnType: \"fields\" and returnFields: {detailedContent: true}",
    "Or use getComment for specific comments: \"CMS-2025-0050-0098\", \"CMS-2025-0050-0112\", \"CMS-2025-0050-0156\""
  ]
}
```

## getComment Response (No Fields Specified)

```json
{
  "docketInfo": {
    "documentId": "CMS-2025-0050-0031",
    "totalComments": 199064
  },
  "comment": {
    "commentId": "CMS-2025-0050-0098",
    "submitter": "Wavital",
    "submitterType": "Private Industry - Health Care",
    "date": "2025-06-17T04:00Z",
    "location": "CA",
    "detailedContent": "Full comment text here...",
    "oneLineSummary": "Support including continuous waveforms in TEFCA/USCDI",
    "corePosition": "Strong support with specific technical recommendations",
    "keyRecommendations": [
      "Add continuous waveforms to USCDI v5",
      "Include vital signs at ≥1 Hz sampling rate",
      "Utilize IEEE 11073 terminology standards"
    ],
    "mainConcerns": [
      "Current lack of waveform data standards",
      "Interoperability challenges"
    ],
    "notableExperiences": [
      "Successful pilot with 5 hospitals showing 30% reduction in ICU adverse events"
    ],
    "keyQuotations": [
      "High-frequency physiological data is the next frontier in precision medicine"
    ],
    "commenterProfile": "Medical device company specializing in patient monitoring",
    "themeScores": {
      "4.2": 1,
      "4.2.1": 1,
      "6.1": 1
    },
    "wordCount": 2847,
    "hasAttachments": true
  },
  "suggestions": [
    "This comment relates to themes: 4.2, 4.2.1, 6.1. Use getThemeSummary for analysis.",
    "All fields returned. Specify fields parameter to get only specific data."
  ]
}
```

## listEntities Response

```json
{
  "docketInfo": {
    "documentId": "CMS-2025-0050-0031",
    "totalComments": 199064,
    "totalEntities": 892
  },
  "entities": {
    "Healthcare Organizations": [
      {
        "label": "AMA",
        "definition": "American Medical Association",
        "terms": ["AMA", "American Medical Association"],
        "mentionCount": 523
      },
      {
        "label": "ANA", 
        "definition": "American Nurses Association",
        "terms": ["ANA", "American Nurses Association"],
        "mentionCount": 412
      }
    ],
    "Government Agencies": [
      {
        "label": "CMS",
        "definition": "Centers for Medicare & Medicaid Services",
        "terms": ["CMS", "Centers for Medicare"],
        "mentionCount": 1893
      }
    ]
  },
  "totalReturned": 45,
  "suggestions": [
    "Filter by specific category to focus on particular stakeholder types",
    "Use entity labels in searchComments with entity:\"Label\" syntax (case-insensitive)",
    "Most mentioned: CMS (1893), Medicare (1456), AMA (523)"
  ]
}
```

## listThemes Response

```json
{
  "docketInfo": {
    "documentId": "CMS-2025-0050-0031",
    "totalComments": 199064,
    "totalThemes": 45,
    "themesWithComments": 42
  },
  "themes": [
    {
      "code": "2",
      "description": "Prior Authorization",
      "detailed_guidelines": "All comments about prior authorization processes...",
      "level": 1,
      "parent_code": null,
      "comment_count": 15234,
      "direct_count": 3421,
      "touch_count": 0,
      "children": ["2.1", "2.2", "2.3"]
    },
    {
      "code": "2.1",
      "description": "Administrative Burden",
      "detailed_guidelines": "Comments specifically about paperwork, time delays...",
      "level": 2,
      "parent_code": "2",
      "comment_count": 8932,
      "direct_count": 8932,
      "touch_count": 0,
      "children": []
    }
  ],
  "suggestions": [
    "Use theme codes in searchComments with theme:CODE syntax",
    "Use getThemeSummary for detailed analysis of specific themes",
    "Most discussed themes: 2 (15234 comments), 3.1 (12456 comments), 4.2 (9823 comments)"
  ]
}
```

## Key Improvements

1. **Docket Context**: Every response includes metadata about the docket
2. **Smart Suggestions**: Context-aware follow-up queries with specific examples
3. **Better Defaults**: All fields returned from getComment (except entities), detailedContent default for searchComments fields mode
4. **Clearer Structure**: Organized sections for easier parsing
5. **Pagination Help**: Clear guidance on how to get more results
6. **Entity/Theme Discovery**: Suggestions guide users to relevant filters