/**
 * FloodGate - TypeScript Type Definitions
 * 
 * Type definitions for the FloodGate comment generation system.
 * These interfaces define the structure for campaigns that generate
 * highly varied, authentic-seeming public comments using conceptual
 * frameworks rather than template strings.
 * 
 * CORE CONCEPTS:
 * - Conceptual themes instead of phrase templates
 * - Multi-dimensional tone and style control
 * - Argument dimensions with core concepts
 * - Persona-based variation
 * - Authentic personalization options
 */

export interface FormGenCampaign {
  /** Unique identifier for this campaign */
  campaignId: string;
  
  /** Human-readable campaign name */
  campaignName: string;
  
  /** Target regulation/docket for comments */
  targetDocket: string;
  
  /** Campaign metadata */
  metadata: CampaignMetadata;
  
  /** Pool of core arguments to draw from */
  argumentPools: ArgumentPool[];
  
  /** Persona templates for different commenter types */
  personas: PersonaTemplate[];
  
  /** Style variations for tone and voice */
  styleProfiles: StyleProfile[];
  
  /** Narrative structures for organizing comments */
  narrativeFrameworks: NarrativeFramework[];
  
  /** Bank of statistics and facts to reference */
  factBank: FactBank;
  
  /** Personal detail prompts for authenticity */
  personalizationPrompts: PersonalizationPrompt[];
  
  /** Emotional hooks and personal stories */
  emotionalHooks: EmotionalHook[];
  
  /** Various ways to close the comment */
  closingStrategies: ClosingStrategy[];
  
  /** Generation parameters and constraints */
  generationConfig: GenerationConfig;
  
  /** Detailed tone guidance for each dimension */
  toneGuidance?: ToneGuidance[];
  
  /** Dynamic phrase variations to avoid repetitive language */
  phraseVariations?: {
    openings?: string[];
    transitions?: string[];
    impacts?: string[];
    legalConcerns?: string[];
    callsToAction?: string[];
    emotionalAppeals?: string[];
    credibilityMarkers?: string[];
    [key: string]: string[] | undefined;
  };
}

export interface CampaignMetadata {
  /** Organization running the campaign */
  organizingEntity: string;
  
  /** Campaign launch date */
  launchDate: string;
  
  /** Target number of comments to generate */
  targetCommentCount: number;
  
  /** Key talking points (for internal reference) */
  coreTalkingPoints: string[];
  
  /** Opposition framing */
  oppositionFraming: string;
  
  /** Detailed regulatory background */
  regulatoryBackground?: {
    /** Official notice title */
    noticeTitle: string;
    
    /** Federal Register document number */
    federalRegisterNumber: string;
    
    /** Date published in Federal Register */
    publishDate: string;
    
    /** Effective date of the change */
    effectiveDate: string;
    
    /** Agency issuing the regulation */
    agencyIssuing: string;
    
    /** Docket number for comments */
    docketNumber: string;
    
    /** Plain English summary of the change */
    summary: string;
    
    /** List of key changes being made */
    keyChanges: string[];
    
    /** Procedural issues with the rulemaking */
    proceduralIssues: string[];
    
    /** Previous interpretation details */
    previousInterpretation: {
      /** Description of prior policy */
      description: string;
      /** How long it was in effect */
      duration: string;
      /** Key aspects being reversed */
      keyAspects: string[];
    };
    
    /** Specific programs affected */
    affectedPrograms: {
      /** Program name */
      name: string;
      /** How it's affected */
      impact: string;
      /** Number of beneficiaries */
      beneficiaries?: string;
      /** Annual budget */
      budget?: string;
    }[];
    
    /** Legal flaws in the new interpretation */
    legalFlaws: {
      /** Type of flaw */
      flawType: string;
      /** Detailed explanation */
      explanation: string;
      /** Supporting precedents */
      precedents: string[];
    }[];
    
    /** Implementation problems */
    implementationIssues: {
      /** Issue category */
      category: string;
      /** Description */
      description: string;
      /** Estimated cost/burden */
      burden?: string;
    }[];
    
    /** Economic impact */
    economicImpact: {
      /** Total estimated cost */
      totalCost?: string;
      /** Cost per program */
      programCosts?: Record<string, string>;
      /** Administrative burden */
      administrativeBurden?: string;
      /** Secondary effects */
      secondaryEffects?: string[];
    };
    
    /** Harm to specific populations */
    populationHarms: {
      /** Population group */
      group: string;
      /** Type of harm */
      harmType: string;
      /** Estimated number affected */
      numberAffected?: string;
      /** Long-term consequences */
      consequences: string[];
    }[];
  };
}

export interface ArgumentPool {
  /** Category of argument (economic, legal, moral, etc.) */
  category: "economic" | "legal" | "moral" | "practical" | "historical" | "personal";
  
  /** Weight for selection (higher = more likely to be included) */
  weight: number;
  
  /** Multiple ways to express this argument */
  variations: ArgumentVariation[];
  
  /** Can this be combined with other categories? */
  combinableWith: string[];
  
  /** Arguments that conflict with this one */
  exclusiveWith: string[];
}

export interface ArgumentVariation {
  /** The argument expressed in different ways */
  templates: string[];
  
  /** Required persona attributes to use this variation */
  requiredPersonaTraits?: string[];
  
  /** Intensity level (1-5, mild to strong) */
  intensity: number;
  
  /** Keywords that should appear somewhere if this is used */
  seedKeywords: string[];
  
  /** Placeholder variables that need filling */
  variables: string[];
}

export interface PersonaTemplate {
  /** Unique identifier for this persona type */
  personaId: string;
  
  /** Human-readable persona name */
  label: string;
  
  /** Demographic attributes */
  demographics: {
    /** Age range */
    ageRange?: [number, number];
    
    /** Profession categories */
    professions?: string[];
    
    /** Geographic regions */
    regions?: string[];
    
    /** Family status options */
    familyStatus?: string[];
  };
  
  /** Traits this persona can have */
  availableTraits: string[];
  
  /** How this persona typically introduces themselves */
  introductionTemplates: string[];
  
  /** Credibility builders for this persona */
  credibilityMarkers: string[];
  
  /** What motivates this persona */
  motivations: string[];
  
  /** Specific concerns for this persona */
  specificConcerns: string[];
}

export interface StyleProfile {
  /** Unique identifier */
  styleId: string;
  
  /** Human-readable style name */
  label: string;
  
  /** Writing characteristics */
  characteristics: {
    /** Sentence length preference */
    sentenceLength: "short" | "medium" | "long" | "varied";
    
    /** Vocabulary complexity */
    vocabularyLevel: "simple" | "moderate" | "advanced" | "professional";
    
    /** Paragraph structure */
    paragraphStyle: "brief" | "standard" | "detailed";
    
    /** Use of contractions */
    contractions: "never" | "occasionally" | "frequently";
    
    /** Punctuation style */
    punctuationStyle: "minimal" | "standard" | "emphatic";
  };
  
  /** Tone indicators */
  tone: {
    formality: number; // 1-10, informal to formal
    emotionality: number; // 1-10, logical to emotional
    urgency: number; // 1-10, calm to urgent
    respectfulness: number; // 1-10, confrontational to deferential
  };
  
  /** Phrases and expressions common to this style */
  signaturePhrases: string[];
  
  /** Transition words preferred by this style */
  transitionWords: string[];
}

export interface ToneGuidance {
  /** Tone dimension name */
  dimension: string;
  
  /** Guidance for different levels (1-10) */
  levels: {
    [level: number]: {
      /** Specific writing instructions for this level */
      instructions: string[];
      
      /** Example phrases to use */
      phrases: string[];
      
      /** Words to emphasize */
      keywords: string[];
      
      /** Structural guidance */
      structure?: string;
      
      /** What to avoid */
      avoid?: string[];
    };
  };
}

export interface NarrativeFramework {
  /** Framework identifier */
  frameworkId: string;
  
  /** Human-readable name */
  label: string;
  
  /** Structure of the narrative */
  structure: NarrativeSection[];
  
  /** Minimum and maximum word count */
  wordCountRange: [number, number];
  
  /** Compatible persona types */
  compatiblePersonas: string[];
}

export interface NarrativeSection {
  /** Section type */
  sectionType: "introduction" | "problem_statement" | "personal_impact" | 
                "community_impact" | "evidence" | "counter_argument" | 
                "call_to_action" | "conclusion";
  
  /** Is this section required? */
  required: boolean;
  
  /** Order preference (lower numbers come first) */
  orderPreference: number;
  
  /** Percentage of total word count */
  wordCountPercentage: number;
  
  /** Can this section be repeated? */
  repeatable: boolean;
}

export interface FactBank {
  /** Statistics that can be cited */
  statistics: Statistic[];
  
  /** Historical facts and precedents */
  historicalFacts: HistoricalFact[];
  
  /** Legal citations and regulations */
  legalReferences: LegalReference[];
  
  /** Research studies and reports */
  researchCitations: ResearchCitation[];
  
  /** Relevant quotes from authorities */
  authorityQuotes: AuthorityQuote[];
}

export interface Statistic {
  /** The statistic value */
  value: string;
  
  /** What it represents */
  description: string;
  
  /** Source of the statistic */
  source: string;
  
  /** Year of the data */
  year: number;
  
  /** Different ways to present this stat */
  presentationVariations: string[];
}

export interface HistoricalFact {
  /** The fact or event */
  fact: string;
  
  /** Year or date */
  date: string;
  
  /** Relevance to current issue */
  relevance: string;
  
  /** Ways to reference this */
  referenceTemplates: string[];
}

export interface LegalReference {
  /** Name of law or regulation */
  name: string;
  
  /** Citation format */
  citation: string;
  
  /** Relevant section */
  section: string;
  
  /** Plain English explanation */
  explanation: string;
  
  /** How to invoke this reference */
  invocationTemplates: string[];
}

export interface ResearchCitation {
  /** Study title */
  title: string;
  
  /** Authors */
  authors: string[];
  
  /** Publication */
  publication: string;
  
  /** Year */
  year: number;
  
  /** Key finding */
  keyFinding: string;
  
  /** Ways to cite this */
  citationTemplates: string[];
}

export interface AuthorityQuote {
  /** The quote */
  quote: string;
  
  /** Who said it */
  speaker: string;
  
  /** Speaker's credibility */
  speakerTitle: string;
  
  /** Context */
  context: string;
  
  /** Ways to introduce this quote */
  introductionTemplates: string[];
}

export interface PersonalizationPrompt {
  /** Prompt identifier */
  promptId: string;
  
  /** The question to ask the user */
  userPrompt: string;
  
  /** Type of input expected */
  inputType: "text" | "number" | "select" | "multiselect" | "location";
  
  /** Options for select/multiselect */
  options?: string[];
  
  /** How to incorporate the response */
  incorporationTemplates: string[];
  
  /** Is this required? */
  required: boolean;
  
  /** Validation rules */
  validation?: {
    minLength?: number;
    maxLength?: number;
    pattern?: string;
  };
}

export interface EmotionalHook {
  /** Hook identifier */
  hookId: string;
  
  /** Type of emotional appeal */
  emotionType: "fear" | "hope" | "anger" | "empathy" | "pride" | "shame";
  
  /** Intensity level */
  intensity: "subtle" | "moderate" | "strong";
  
  /** Story templates */
  storyTemplates: string[];
  
  /** Compatible personas */
  compatiblePersonas: string[];
  
  /** Required personal details */
  requiredDetails: string[];
}

export interface ClosingStrategy {
  /** Strategy identifier */
  strategyId: string;
  
  /** Type of closing */
  closingType: "call_to_action" | "summary" | "emotional_appeal" | 
               "warning" | "hope" | "thank_you";
  
  /** Multiple variations */
  templates: string[];
  
  /** Compatible with which tones */
  compatibleTones: string[];
  
  /** Signature line formats */
  signatureFormats: string[];
}

export interface GenerationConfig {
  /** LLM model to use */
  model: string;
  
  /** Temperature for generation (0-2) */
  temperature: number;
  
  /** Variation parameters */
  variation: {
    /** Minimum arguments to include */
    minArguments: number;
    
    /** Maximum arguments to include */
    maxArguments: number;
    
    /** Chance of including personal story (0-1) */
    personalStoryProbability: number;
    
    /** Chance of including statistics (0-1) */
    statisticsProbability: number;
    
    /** Chance of including legal reference (0-1) */
    legalReferenceProbability: number;
  };
  
  /** Authenticity features */
  authenticity: {
    /** Add minor typos (0-1 probability) */
    typoRate: number;
    
    /** Regional dialect variations */
    dialectVariation: boolean;
    
    /** Inconsistent capitalization */
    capitalizationVariance: boolean;
    
    /** Emotional interruptions in text */
    emotionalInterruptions: boolean;
    
    /** Grammar imperfections */
    grammarImperfectionRate: number;
  };
  
  /** Distribution parameters */
  distribution: {
    /** Time window for submissions (hours) */
    submissionWindowHours: number;
    
    /** Peak submission times */
    peakTimes: string[];
    
    /** Geographic distribution */
    geographicWeighting: Record<string, number>;
    
    /** Delay between submissions (seconds) */
    submissionDelayRange: [number, number];
  };
  
  /** Anti-detection measures */
  antiDetection: {
    /** Use different models for batches */
    modelRotation: boolean;
    
    /** Vary prompt engineering */
    promptVariation: boolean;
    
    /** Include contradictory elements occasionally */
    contradictionRate: number;
    
    /** Reference current events */
    currentEventsIntegration: boolean;
    
    /** Unique fact hallucination (make up specific details) */
    uniqueDetailGeneration: boolean;
  };
}

/**
 * POPULATION INSTRUCTIONS:
 * 
 * 1. ARGUMENT POOLS:
 *    - Create 3-5 categories minimum
 *    - Each category needs 5-10 variation templates
 *    - Include placeholder variables like {years}, {city}, {number}
 *    - Set realistic weights based on importance
 * 
 * 2. PERSONAS:
 *    - Define 5-10 distinct persona types
 *    - Each should have unique introduction patterns
 *    - Include profession-specific concerns
 *    - Add credibility markers relevant to each
 * 
 * 3. STYLE PROFILES:
 *    - Create 4-6 different writing styles
 *    - Vary formality, emotion, and urgency
 *    - Include signature phrases that feel natural
 *    - Ensure compatibility with different personas
 * 
 * 4. NARRATIVE FRAMEWORKS:
 *    - Design 3-5 different comment structures
 *    - Vary the emphasis (personal vs. factual vs. emotional)
 *    - Allow flexibility in section ordering
 *    - Set appropriate word count ranges
 * 
 * 5. FACT BANK:
 *    - Include 10-20 relevant statistics
 *    - Add 5-10 historical precedents
 *    - Include legal citations if applicable
 *    - Provide multiple presentation formats for each
 * 
 * 6. PERSONALIZATION:
 *    - Create prompts that feel natural to answer
 *    - Mix required and optional fields
 *    - Include location and experience prompts
 *    - Design templates that smoothly incorporate responses
 * 
 * 7. GENERATION CONFIG:
 *    - Set temperature between 0.7-0.9 for variety
 *    - Configure authenticity features carefully
 *    - Plan distribution to avoid detection
 *    - Enable anti-detection measures appropriately
 */