import React, { useState, useEffect, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import type { 
  FormGenCampaign, 
  ArgumentPool, 
  PersonaTemplate, 
  StyleProfile,
  NarrativeFramework,
  PersonalizationPrompt 
} from './floodgate-types';
import './app.css';

function App() {
  // Campaign data - loaded from URL param or default
  const [campaign, setCampaign] = useState<FormGenCampaign | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  
  // User selections - start with defaults, will be randomized on mount
  const [selectedPersona, setSelectedPersona] = useState<string>('');
  const [customPersona, setCustomPersona] = useState<string>('');
  const [selectedStyle, setSelectedStyle] = useState<string>('');
  const [customStyle, setCustomStyle] = useState<string>('');
  const [targetWordCount, setTargetWordCount] = useState<number>(350);
  
  // Argument weights (0-100)
  const [argumentWeights, setArgumentWeights] = useState<Record<string, number>>({});
  
  // Which arguments to include
  const [includedArguments, setIncludedArguments] = useState<Record<string, boolean>>({});
  
  // Store previous weights when unchecking
  const [previousWeights, setPreviousWeights] = useState<Record<string, number>>({});
  
  // Tone adjustments - reduced to 8 key dimensions
  const [toneAdjustments, setToneAdjustments] = useState({
    formality: 5,
    emotionality: 5,
    urgency: 5,
    aggression: 3,
    technicality: 5,
    empathy: 5,
    outrage: 3,
    hope: 5
  });
  
  // Personal details
  const [personalDetails, setPersonalDetails] = useState<Record<string, string>>({
    name: '',
    organization: '',
    city: '',
    state: ''
  });
  
  // Personal story text
  const [personalStory, setPersonalStory] = useState<string>('');
  
  // Generation parameters
  const [genParams, setGenParams] = useState({
    wordCount: 350,
    temperature: 0.8
  });
  
  // Generated prompt
  const [generatedPrompt, setGeneratedPrompt] = useState<string>('');
  
  // Load campaign from URL param or default
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    let campaignUrl = params.get('campaign');
    
    // If no campaign parameter, use default and update URL
    if (!campaignUrl) {
      campaignUrl = './floodgate-example-work-requirements.json';
      // Update URL bar without refreshing the page
      params.set('campaign', campaignUrl);
      const newUrl = `${window.location.pathname}?${params.toString()}`;
      window.history.replaceState({}, '', newUrl);
    }
    
    setIsLoading(true);
    setLoadError(null);
    
    fetch(campaignUrl)
      .then(res => {
        if (!res.ok) throw new Error(`Failed to load campaign: ${res.statusText}`);
        return res.json();
      })
      .then(data => {
        setCampaign(data as FormGenCampaign);
        setIsLoading(false);
        // Reset all settings for the new campaign
        initializeSettings(data as FormGenCampaign);
        // Then randomize
        setTimeout(() => randomizeSettings(data as FormGenCampaign), 100);
      })
      .catch(err => {
        console.error('Failed to load campaign:', err);
        setLoadError(err.message);
        setIsLoading(false);
      });
  }, []); // Only run once on mount
  
  // Initialize settings when campaign changes
  const initializeSettings = (newCampaign: FormGenCampaign) => {
    // Reset persona
    setSelectedPersona(newCampaign.personas[0].personaId);
    setCustomPersona('');
    
    // Reset style
    setSelectedStyle(newCampaign.styleProfiles[0].styleId);
    setCustomStyle('');
    
    // Reset argument weights
    const weights: Record<string, number> = {};
    const included: Record<string, boolean> = {};
    const args = newCampaign.argumentDimensions || newCampaign.argumentPools || [];
    args.forEach(arg => {
      const key = arg.dimension || arg.category;
      weights[key] = arg.weight * 100;
      included[key] = true;
    });
    setArgumentWeights(weights);
    setIncludedArguments(included);
    
    // Reset tone
    setToneAdjustments({
      formality: 5,
      emotionality: 5,
      urgency: 5,
      aggression: 3,
      technicality: 5,
      empathy: 5,
      outrage: 3,
      hope: 5
    });
    
    // Reset personal details
    setPersonalDetails({
      name: '',
      organization: '',
      city: '',
      state: ''
    });
    setPersonalStory('');
  };
  
  // Auto-generate prompt whenever settings change
  useEffect(() => {
    generatePrompt();
  }, [
    selectedPersona,
    customPersona,
    selectedStyle,
    customStyle,
    targetWordCount,
    argumentWeights,
    includedArguments,
    toneAdjustments,
    personalDetails,
    personalStory,
    genParams
  ]);
  
  // Randomize all settings
  const randomizeSettings = (campaignData?: FormGenCampaign) => {
    const currentCampaign = campaignData || campaign;
    if (!currentCampaign) return;
    
    // Random persona (including chance for custom)
    const personas = [...currentCampaign.personas, { personaId: 'custom', label: 'Other' }];
    const randomPersona = personas[Math.floor(Math.random() * personas.length)];
    setSelectedPersona(randomPersona.personaId);
    if (randomPersona.personaId === 'custom') {
      setCustomPersona(''); // Clear custom text on randomization
    }
    
    // Random style (including chance for custom)
    const styles = [...currentCampaign.styleProfiles, { styleId: 'custom', label: 'Other' }];
    const randomStyle = styles[Math.floor(Math.random() * styles.length)];
    setSelectedStyle(randomStyle.styleId);
    if (randomStyle.styleId === 'custom') {
      setCustomStyle(''); // Clear custom text on randomization
    }
    
    // Random word count
    setTargetWordCount(Math.floor(Math.random() * 500) + 200); // 200-700 words
    
    // Randomize argument weights (30-100%)
    const newWeights: Record<string, number> = {};
    const newIncluded: Record<string, boolean> = {};
    const args = currentCampaign.argumentDimensions || currentCampaign.argumentPools || [];
    args.forEach(arg => {
      const key = arg.dimension || arg.category;
      const include = Math.random() > 0.3; // 70% chance to include
      newIncluded[key] = include;
      newWeights[key] = include ? Math.floor(Math.random() * 70) + 30 : 0;
    });
    setArgumentWeights(newWeights);
    setIncludedArguments(newIncluded);
    
    // Randomize tones (1-10)
    setToneAdjustments({
      formality: Math.floor(Math.random() * 10) + 1,
      emotionality: Math.floor(Math.random() * 10) + 1,
      urgency: Math.floor(Math.random() * 10) + 1,
      aggression: Math.floor(Math.random() * 7) + 1, // Limit aggression (1-7)
      technicality: Math.floor(Math.random() * 10) + 1,
      empathy: Math.floor(Math.random() * 10) + 1,
      outrage: Math.floor(Math.random() * 8) + 1,
      hope: Math.floor(Math.random() * 10) + 1
    });
    
    // Randomize generation parameters
    setGenParams({
      wordCount: Math.floor(Math.random() * 500) + 200, // 200-700 words
      temperature: 0.5 + Math.random() * 1.0 // 0.5-1.5
    });
    // Don't randomize personal story text - keep what user typed
  };
  
  // Preset tone configurations
  const applyTonePreset = (preset: string) => {
    const presets: Record<string, any> = {
      professional: {
        formality: 9, emotionality: 3, urgency: 5,
        aggression: 1, technicality: 7, empathy: 5,
        outrage: 2, hope: 6
      },
      angry: {
        formality: 4, emotionality: 9, urgency: 9,
        aggression: 8, technicality: 3, empathy: 2,
        outrage: 9, hope: 2
      },
      pleading: {
        formality: 5, emotionality: 9, urgency: 8,
        aggression: 1, technicality: 2, empathy: 9,
        outrage: 3, hope: 8
      },
      technical: {
        formality: 8, emotionality: 2, urgency: 4,
        aggression: 2, technicality: 10, empathy: 3,
        outrage: 3, hope: 4
      },
      hopeful: {
        formality: 6, emotionality: 7, urgency: 7,
        aggression: 2, technicality: 4, empathy: 8,
        outrage: 4, hope: 10
      }
    };
    
    if (presets[preset]) {
      setToneAdjustments(presets[preset]);
    }
  };
  
  // Helper function to get nearest tone level guidance
  const getToneGuidance = (dimension: string, level: number): any => {
    const guidance = campaign?.toneGuidance?.find(g => g.dimension === dimension);
    if (!guidance) return null;
    
    // Find the closest level that has guidance
    const levels = Object.keys(guidance.levels).map(Number).sort((a, b) => a - b);
    let closestLevel = levels[0];
    
    for (const l of levels) {
      if (Math.abs(l - level) < Math.abs(closestLevel - level)) {
        closestLevel = l;
      }
    }
    
    return guidance.levels[closestLevel];
  };
  
  // Generate the LLM prompt
  const generatePrompt = () => {
    if (!campaign) return;
    
    const persona = selectedPersona === 'custom' ? null : campaign?.personas?.find(p => p.personaId === selectedPersona);
    const style = selectedStyle === 'custom' ? null : campaign?.styleProfiles?.find(s => s.styleId === selectedStyle);
    
    // Use argumentDimensions instead of argumentPools
    const activeArguments = (campaign?.argumentDimensions || campaign?.argumentPools || []).filter(dim => 
      includedArguments[dim.dimension || dim.category] && argumentWeights[dim.dimension || dim.category] > 0
    );
    
    // Build detailed tone instructions based on slider positions
    let toneInstructions: string[] = [];
    let phrasesToUse: string[] = [];
    let keywordsToEmphasize: string[] = [];
    let structuralGuidance: string[] = [];
    let phrasesToAvoid: string[] = [];
    
    // Process each tone dimension
    Object.entries(toneAdjustments).forEach(([dimension, level]) => {
      const guidance = getToneGuidance(dimension, level);
      if (guidance) {
        if (guidance.instructions) {
          toneInstructions.push(...guidance.instructions);
        }
        if (guidance.phrases) {
          phrasesToUse.push(...guidance.phrases);
        }
        if (guidance.keywords) {
          keywordsToEmphasize.push(...guidance.keywords);
        }
        if (guidance.structure) {
          structuralGuidance.push(guidance.structure);
        }
        if (guidance.avoid) {
          phrasesToAvoid.push(...guidance.avoid);
        }
      }
    });
    
    // Randomly select concepts to emphasize
    const selectedPhrases = phrasesToUse.sort(() => Math.random() - 0.5).slice(0, 8);
    const selectedKeywords = keywordsToEmphasize.sort(() => Math.random() - 0.5).slice(0, 10);
    
    // Select random concepts from campaign themes
    const getRandomConcepts = (category: string, count: number): any[] => {
      const concepts = campaign?.conceptualThemes?.[category] || 
                      campaign?.phraseVariations?.[category] || [];
      if (Array.isArray(concepts)) {
        return concepts.sort(() => Math.random() - 0.5).slice(0, count);
      }
      return [];
    };
    
    const selectedOpenings = getRandomConcepts('openingIntents', 3);
    const selectedConnections = getRandomConcepts('connectionStrategies', 4);
    const selectedHarms = getRandomConcepts('harmCategories', 3);
    const selectedLegalPrinciples = getRandomConcepts('legalPrinciples', 2);
    const selectedActions = getRandomConcepts('actionRequests', 2);
    const selectedEmotions = getRandomConcepts('emotionalResonance', 2);
    const selectedCredibility = getRandomConcepts('credibilityBases', 2);
    
    // Build sections conditionally
    let promptSections: string[] = [];
    
    // Header
    promptSections.push(`═══════════════════════════════════════════════════════════════════
                    PUBLIC COMMENT GENERATION PROMPT
═══════════════════════════════════════════════════════════════════`);
    
    // Regulatory Context
    promptSections.push(`
╔═══ REGULATORY CONTEXT ═══════════════════════════════════════════╗
║ Title: ${campaign.metadata.regulatoryBackground?.noticeTitle}
║ Agency: ${campaign.metadata.regulatoryBackground?.agencyIssuing}
║ Docket: ${campaign.targetDocket}
║ Federal Register: ${campaign.metadata.regulatoryBackground?.federalRegisterNumber}
╚═══════════════════════════════════════════════════════════════════╝

SUMMARY:
${campaign?.metadata?.regulatoryBackground?.summary}

KEY CHANGES:
${campaign?.metadata?.regulatoryBackground?.keyChanges?.map(c => `  • ${c}`).join('\n') || ''}

PROCEDURAL ISSUES:
${campaign?.metadata?.regulatoryBackground?.proceduralIssues?.map(i => `  • ${i}`).join('\n') || ''}`);

    // Previous Policy
    promptSections.push(`
╔═══ PREVIOUS POLICY (27 YEARS) ════════════════════════════════════╗
${campaign?.metadata?.regulatoryBackground?.previousInterpretation?.description}

Duration: ${campaign?.metadata?.regulatoryBackground?.previousInterpretation?.duration}

Key Aspects Being Reversed:
${campaign?.metadata?.regulatoryBackground?.previousInterpretation?.keyAspects?.map(a => `  • ${a}`).join('\n') || ''}
╚═══════════════════════════════════════════════════════════════════╝`);

    // Impacts
    promptSections.push(`
╔═══ IMPACTS & HARMS ════════════════════════════════════════════════╗
ECONOMIC IMPACT:
  • Total cost: ${campaign?.metadata?.regulatoryBackground?.economicImpact?.totalCost}
  • Administrative burden: ${campaign?.metadata?.regulatoryBackground?.economicImpact?.administrativeBurden}

AFFECTED PROGRAMS:
${campaign?.metadata?.regulatoryBackground?.affectedPrograms?.slice(0, 3).map(p => 
  `  • ${p.name}: ${p.beneficiaries} affected, ${p.budget} budget\n    Impact: ${p.impact}`
).join('\n')}

POPULATION HARMS:
${campaign?.metadata?.regulatoryBackground?.populationHarms?.slice(0, 2).map(h => 
  `  • ${h.group}: ${h.harmType} affecting ${h.numberAffected}`
).join('\n')}
╚═══════════════════════════════════════════════════════════════════╝`);

    // Commenter Identity
    const hasPersonalInfo = personalDetails.name || personalDetails.organization || 
                           personalDetails.city || personalDetails.state;
    
    promptSections.push(`
╔═══ COMMENTER IDENTITY ═════════════════════════════════════════════╗
${persona ? `Role: ${persona.label}
Motivations: ${persona.motivations.join(', ')}
Concerns: ${persona.specificConcerns.join(', ')}
Credibility: ${persona.credibilityMarkers.join(', ')}` : 
(customPersona ? `Identity: ${customPersona}` : 'Identity: Concerned citizen')}
${hasPersonalInfo ? `\nPersonal Information:` : ''}
${personalDetails.name ? `  Name: ${personalDetails.name}` : ''}
${personalDetails.organization ? `  Organization: ${personalDetails.organization}` : ''}
${personalDetails.city && personalDetails.state ? `  Location: ${personalDetails.city}, ${personalDetails.state}` : 
  personalDetails.city ? `  City: ${personalDetails.city}` : 
  personalDetails.state ? `  State: ${personalDetails.state}` : ''}
╚═══════════════════════════════════════════════════════════════════╝`);

    // Writing Instructions - only if we have content
    if (toneInstructions.length > 0 || structuralGuidance.length > 0 || selectedPhrases.length > 0 || selectedKeywords.length > 0) {
      let writingSection = `
╔═══ WRITING INSTRUCTIONS ═══════════════════════════════════════════╗`;
      
      if (toneInstructions.length > 0) {
        writingSection += `\n\nTONE GUIDANCE:\n${toneInstructions.map(i => `  • ${i}`).join('\n')}`;
      }
      
      if (structuralGuidance.length > 0) {
        writingSection += `\n\nSTRUCTURE:\n${structuralGuidance.map(g => `  • ${g}`).join('\n')}`;
      }
      
      if (selectedPhrases.length > 0) {
        writingSection += `\n\nKEY PHRASES (use 3-5):\n${selectedPhrases.map(p => `  • "${p}"`).join('\n')}`;
      }
      
      if (selectedKeywords.length > 0) {
        writingSection += `\n\nEMPHASIS WORDS:\n  ${selectedKeywords.join(', ')}`;
      }
      
      if (phrasesToAvoid.length > 0) {
        writingSection += `\n\nAVOID:\n${phrasesToAvoid.map(a => `  • ${a}`).join('\n')}`;
      }
      
      writingSection += `\n╚═══════════════════════════════════════════════════════════════════╝`;
      promptSections.push(writingSection);
    }

    // Tone Settings
    promptSections.push(`
╔═══ TONE SETTINGS ══════════════════════════════════════════════════╗
  Formality:        ${'█'.repeat(toneAdjustments.formality)}${'░'.repeat(10-toneAdjustments.formality)} ${toneAdjustments.formality}/10
  Emotionality:     ${'█'.repeat(toneAdjustments.emotionality)}${'░'.repeat(10-toneAdjustments.emotionality)} ${toneAdjustments.emotionality}/10
  Urgency:          ${'█'.repeat(toneAdjustments.urgency)}${'░'.repeat(10-toneAdjustments.urgency)} ${toneAdjustments.urgency}/10
  Aggression:       ${'█'.repeat(toneAdjustments.aggression)}${'░'.repeat(10-toneAdjustments.aggression)} ${toneAdjustments.aggression}/10
  Technical Detail: ${'█'.repeat(toneAdjustments.technicality)}${'░'.repeat(10-toneAdjustments.technicality)} ${toneAdjustments.technicality}/10
  Empathy:          ${'█'.repeat(toneAdjustments.empathy)}${'░'.repeat(10-toneAdjustments.empathy)} ${toneAdjustments.empathy}/10
  Outrage:          ${'█'.repeat(toneAdjustments.outrage)}${'░'.repeat(10-toneAdjustments.outrage)} ${toneAdjustments.outrage}/10
  Hope:             ${'█'.repeat(toneAdjustments.hope)}${'░'.repeat(10-toneAdjustments.hope)} ${toneAdjustments.hope}/10
╚═══════════════════════════════════════════════════════════════════╝`);

    // Arguments if any are selected
    if (activeArguments.length > 0) {
      promptSections.push(`
╔═══ ARGUMENT CONCEPTS (by priority) ════════════════════════════════╗
${activeArguments
  .sort((a, b) => argumentWeights[b.dimension || b.category] - argumentWeights[a.dimension || a.category])
  .map(arg => {
    const dimension = arg.dimension || arg.category;
    const weight = argumentWeights[dimension];
    
    // For new concept-based arguments
    if (arg.coreConcepts) {
      const concept = arg.coreConcepts[Math.floor(Math.random() * arg.coreConcepts.length)];
      return `
[${dimension.toUpperCase()} - ${weight}% emphasis]
Concept: ${concept.concept}
Key Facts: ${JSON.stringify(concept.keyFacts || concept.principles || concept.impacts || {}, null, 2)}
Approach: ${Array.isArray(concept.approach) ? concept.approach.join(', ') : (concept.framing || concept.approach || 'standard')}`;
    }
    
    // Fallback for old template-based arguments
    const variation = arg.variations?.[Math.floor(Math.random() * arg.variations.length)];
    if (variation?.templates) {
      return `\n[${dimension.toUpperCase()} - ${weight}% weight]\n${variation.templates[Math.floor(Math.random() * variation.templates.length)]}`;
    }
    
    return `\n[${dimension.toUpperCase()} - ${weight}% weight]\nExpress ${dimension} concerns naturally`;
  }).join('\n')}
╚═══════════════════════════════════════════════════════════════════╝`);
    }

    // Generation Parameters
    promptSections.push(`
╔═══ GENERATION PARAMETERS ══════════════════════════════════════════╗
  Target Length:    ${targetWordCount} words
  Temperature:      ${genParams.temperature.toFixed(1)}
  Personal Story:   ${personalStory.trim() ? '✓ Yes' : '✗ No'}
╚═══════════════════════════════════════════════════════════════════╝`);

    // Personal Story - always include if provided
    if (personalStory.trim()) {
      promptSections.push(`
╔═══ PERSONAL STORY ═════════════════════════════════════════════════╗
${personalStory}

[Weave this naturally into the comment]
╚═══════════════════════════════════════════════════════════════════╝`);
    }

    let prompt = promptSections.join('\n') + `

═══════════════════════════════════════════════════════════════════
INSTRUCTIONS: Generate a ${targetWordCount}-word public comment that:
1. Opens expressing the intent/emotion from the opening concepts provided
2. Incorporates the argument concepts naturally - express the ideas, don't copy templates
3. Uses connection strategies to transition between points
4. Maintains consistent tone throughout based on the tone settings
5. Expresses harm concepts in your own words
6. Ends with an action request that fits the tone
${hasPersonalInfo ? '7. Naturally incorporates the personal information provided' : ''}
${personalDetails.name ? '8. Signs off with the name provided' : ''}
═══════════════════════════════════════════════════════════════════

IMPORTANT:
- Express concepts naturally in your own words
- Don't copy phrases verbatim - understand and rephrase
- Write in first person with authentic voice
- Let tone settings guide your expression style
${personalDetails.city || personalDetails.state ? '- Reference your location naturally if relevant' : ''}
${personalDetails.organization ? '- Mention your organizational affiliation if it adds credibility' : ''}
- Make arguments flow naturally from the concepts provided
- Vary sentence structure and vocabulary based on style settings

Generate the complete comment now:`;
    
    setGeneratedPrompt(prompt);
  };
  
  // Don't render until campaign is loaded
  if (!campaign) {
    return (
      <div className="app-container">
        <div className="wave-container">
          <div className="wave wave1"></div>
          <div className="wave wave2"></div>
          <div className="wave wave3"></div>
        </div>
        <header className="app-header">
          <div className="logo-container">
            <span className="logo-icon">🌊</span>
            <h1>FloodGate</h1>
          </div>
          {isLoading ? (
            <div className="loading-message">Loading campaign configuration...</div>
          ) : loadError ? (
            <div className="error-message">⚠️ {loadError}</div>
          ) : null}
        </header>
      </div>
    );
  }
  
  return (
    <div className="app-container">
      {/* Animated wave background */}
      <div className="wave-container">
        <div className="wave wave1"></div>
        <div className="wave wave2"></div>
        <div className="wave wave3"></div>
      </div>
      
      <header className="app-header">
        <div className="logo-container">
          <span className="logo-icon">🌊</span>
          <h1>FloodGate</h1>
        </div>
        <p className="tagline">Help individuals craft unique, personalized public comments</p>
        <div className="header-controls">
          <button onClick={() => randomizeSettings()} className="flood-button">
            🎲 Randomize All Settings
          </button>
        </div>
      </header>
      
      <div className="controls-grid">
        {/* Persona Selection */}
        <div className="control-section persona">
          <h3>Select Persona</h3>
          <select 
            value={selectedPersona} 
            onChange={(e) => setSelectedPersona(e.target.value)}
            className="select-control"
          >
            {campaign?.personas?.map(persona => (
              <option key={persona.personaId} value={persona.personaId}>
                {persona.label}
              </option>
            )) || []}
            <option value="custom">Other (specify below)</option>
          </select>
          {selectedPersona === 'custom' ? (
            <input
              type="text"
              placeholder="Describe your persona (e.g., 'retired nurse with 30 years experience')"
              value={customPersona}
              onChange={(e) => setCustomPersona(e.target.value)}
              style={{
                marginTop: '0.5rem',
                width: '100%',
                padding: '0.75rem',
                border: '2px solid #e2e8f0',
                borderRadius: '8px',
                fontSize: '1rem'
              }}
            />
          ) : (
            <div className="persona-details">
              {campaign?.personas?.find(p => p.personaId === selectedPersona)?.motivations?.map(m => (
                <span key={m} className="tag">{m}</span>
              )) || []}
            </div>
          )}
        </div>
        
        {/* Style Selection */}
        <div className="control-section style">
          <h3>Writing Style</h3>
          <select 
            value={selectedStyle} 
            onChange={(e) => setSelectedStyle(e.target.value)}
            className="select-control"
          >
            {campaign?.styleProfiles?.map(style => (
              <option key={style.styleId} value={style.styleId}>
                {style.label}
              </option>
            )) || []}
            <option value="custom">Other (specify below)</option>
          </select>
          {selectedStyle === 'custom' && (
            <input
              type="text"
              placeholder="Describe writing style (e.g., 'casual, uses regional dialect')"
              value={customStyle}
              onChange={(e) => setCustomStyle(e.target.value)}
              style={{
                marginTop: '0.5rem',
                width: '100%',
                padding: '0.75rem',
                border: '2px solid #e2e8f0',
                borderRadius: '8px',
                fontSize: '1rem'
              }}
            />
          )}
        </div>
        
        {/* Argument Weights */}
        <div className="control-section arguments">
          <h3>Argument Emphasis</h3>
          <div className="argument-controls">
            {(campaign?.argumentDimensions || campaign?.argumentPools || []).map(arg => {
              const key = arg.dimension || arg.category;
              return (
              <div key={key} className="argument-control">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={includedArguments[key]}
                    onChange={(e) => {
                      const isChecked = e.target.checked;
                      
                      if (!isChecked) {
                        // Store current weight before setting to 0
                        setPreviousWeights(prev => ({
                          ...prev,
                          [key]: argumentWeights[key]
                        }));
                        setArgumentWeights({
                          ...argumentWeights,
                          [key]: 0
                        });
                      } else {
                        // Restore previous weight or set to default 50
                        const restoredWeight = previousWeights[key] || 50;
                        setArgumentWeights({
                          ...argumentWeights,
                          [key]: restoredWeight
                        });
                      }
                      
                      setIncludedArguments({
                        ...includedArguments,
                        [key]: isChecked
                      });
                    }}
                  />
                  <span className="argument-category">{key}</span>
                </label>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={includedArguments[key] ? argumentWeights[key] : 0}
                  onChange={(e) => {
                    if (includedArguments[key]) {
                      setArgumentWeights({
                        ...argumentWeights,
                        [key]: parseInt(e.target.value)
                      });
                    }
                  }}
                  disabled={!includedArguments[key]}
                  className="weight-slider"
                  style={{
                    opacity: includedArguments[key] ? 1 : 0.3,
                    cursor: includedArguments[key] ? 'pointer' : 'not-allowed'
                  }}
                />
                <span className="weight-value" style={{
                  opacity: includedArguments[key] ? 1 : 0.4
                }}>
                  {includedArguments[key] ? argumentWeights[key] : 0}%
                </span>
              </div>
            )})}
          </div>
        </div>
        
        {/* Tone Controls */}
        <div className="control-section tone">
          <h3>Tone Adjustments</h3>
          <div className="tone-controls expanded">
            {Object.entries(toneAdjustments).map(([key, value]) => {
              const labels: Record<string, string> = {
                formality: "Formality",
                emotionality: "Emotionality",
                urgency: "Urgency",
                aggression: "Aggression",
                technicality: "Technical Detail",
                empathy: "Empathy",
                outrage: "Outrage",
                hope: "Hope/Optimism"
              };
              
              return (
                <div key={key} className="tone-control">
                  <label title={`Adjust ${labels[key] || key} level`}>
                    {labels[key] || key}
                  </label>
                  <input
                    type="range"
                    min="1"
                    max="10"
                    value={value}
                    onChange={(e) => setToneAdjustments({
                      ...toneAdjustments,
                      [key]: parseInt(e.target.value)
                    })}
                    className={`tone-slider tone-${key}`}
                  />
                  <span className="tone-value">{value}</span>
                </div>
              );
            })}
          </div>
        </div>
        
        
        {/* Personal Information */}
        <div className="control-section personal-info">
          <h3>Personal Information (Optional)</h3>
          <div className="personal-fields">
            <div className="field-group">
              <label htmlFor="name">Your Name</label>
              <input
                id="name"
                type="text"
                placeholder="John Smith"
                value={personalDetails.name}
                onChange={(e) => setPersonalDetails({
                  ...personalDetails,
                  name: e.target.value
                })}
                className="text-input"
              />
            </div>
            
            <div className="field-group">
              <label htmlFor="organization">Organization (if applicable)</label>
              <input
                id="organization"
                type="text"
                placeholder="Community Health Center"
                value={personalDetails.organization}
                onChange={(e) => setPersonalDetails({
                  ...personalDetails,
                  organization: e.target.value
                })}
                className="text-input"
              />
            </div>
            
            <div className="field-group">
              <label htmlFor="city">City</label>
              <input
                id="city"
                type="text"
                placeholder="Houston"
                value={personalDetails.city}
                onChange={(e) => setPersonalDetails({
                  ...personalDetails,
                  city: e.target.value
                })}
                className="text-input"
              />
            </div>
            
            <div className="field-group">
              <label htmlFor="state">State</label>
              <input
                id="state"
                type="text"
                placeholder="TX"
                value={personalDetails.state}
                onChange={(e) => setPersonalDetails({
                  ...personalDetails,
                  state: e.target.value
                })}
                className="text-input"
                maxLength={2}
                style={{ textTransform: 'uppercase' }}
              />
            </div>
          </div>
          
          {/* Personal Context & Story */}
          <div style={{ marginTop: '1.5rem' }}>
            <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500, color: '#4a5568' }}>
              Personal Context & Story (include any relevant details: location, profession, family situation, experiences)
            </label>
            <textarea
              placeholder="Example: I'm a pediatric nurse in Houston, Texas, with 15 years of experience. I have two young children. Last year, my neighbor's 3-year-old daughter was enrolled in Head Start. The program helped her overcome developmental delays and prepared her for kindergarten. Without Head Start, her family wouldn't have been able to afford early education. I've seen firsthand how these programs change lives..."
              value={personalStory}
              onChange={(e) => setPersonalStory(e.target.value)}
              style={{
                width: '100%',
                minHeight: '120px',
                padding: '0.75rem',
                borderRadius: '8px',
                border: '2px solid #e2e8f0',
                fontSize: '0.95rem',
                fontFamily: 'inherit',
                resize: 'vertical',
                background: 'rgba(255, 255, 255, 0.8)'
              }}
            />
            <button
              onClick={() => {
                if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
                  const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
                  const recognition = new SpeechRecognition();
                  
                  const button = document.querySelector('button:focus') as HTMLButtonElement;
                  if (button) {
                    button.textContent = '🔴 Recording...';
                    button.style.background = 'linear-gradient(135deg, #ff6b6b 0%, #f06595 100%)';
                  }
                  
                  recognition.continuous = true;
                  recognition.interimResults = true;
                  recognition.lang = 'en-US';
                  
                  let fullTranscript = '';
                  
                  recognition.onresult = (event: any) => {
                    fullTranscript = '';
                    
                    // Build the complete transcript from all results
                    for (let i = 0; i < event.results.length; i++) {
                      fullTranscript += event.results[i][0].transcript;
                    }
                    
                    // Replace the entire content with the complete transcript
                    setPersonalStory(fullTranscript);
                  };
                  
                  recognition.onend = () => {
                    if (button) {
                      button.textContent = '🎤 Dictate Story';
                      button.style.background = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
                    }
                  };
                  
                  recognition.start();
                } else {
                  alert('Speech recognition is not supported in your browser.');
                }
              }}
              style={{
                marginTop: '0.5rem',
                padding: '0.5rem 1rem',
                background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                color: 'white',
                border: 'none',
                borderRadius: '8px',
                cursor: 'pointer',
                fontSize: '1rem',
                fontWeight: 500
              }}
            >
              🎤 Dictate Story
            </button>
          </div>
        </div>
        
        {/* Generation Parameters */}
        <div className="control-section generation">
          <h3>Generation Parameters</h3>
          <div className="gen-params">
            {/* Word Count */}
            <div className="param-group">
              <label>Target Word Count</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                <input
                  type="range"
                  min="100"
                  max="1000"
                  step="50"
                  value={targetWordCount}
                  onChange={(e) => setTargetWordCount(parseInt(e.target.value))}
                  className="weight-slider"
                  style={{ flex: 1 }}
                />
                <span style={{ fontWeight: 600, color: 'var(--ocean-primary)', minWidth: '80px' }}>
                  {targetWordCount} words
                </span>
              </div>
            </div>
            
            <div className="param-group">
              <label>Temperature (Creativity)</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                <input
                  type="range"
                  min="0.1"
                  max="2"
                  step="0.1"
                  value={genParams.temperature}
                  onChange={(e) => setGenParams({
                    ...genParams,
                    temperature: parseFloat(e.target.value)
                  })}
                  className="temp-slider"
                  style={{ flex: 1 }}
                />
                <span className="temp-value">{genParams.temperature.toFixed(1)}</span>
              </div>
            </div>
          </div>
        </div>
        
        {/* Prompt Display - Always visible */}
        <div className="control-section prompt" style={{ marginTop: '1.5rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
            <h3 style={{ margin: 0 }}>Generated Prompt</h3>
          </div>
        
        {/* Action buttons ABOVE prompt */}
        <div className="prompt-actions" style={{ marginBottom: '1.5rem' }}>
          <button 
            onClick={() => {
              navigator.clipboard.writeText(generatedPrompt);
              // Visual feedback
              const button = event?.target as HTMLButtonElement;
              if (button) {
                const originalText = button.textContent;
                button.textContent = '✅ Copied!';
                setTimeout(() => {
                  button.textContent = originalText;
                }, 2000);
              }
            }}
            className="copy-button"
            style={{ fontSize: '1.2rem', padding: '1rem 2rem' }}
          >
            📋 Copy to Clipboard
          </button>
          
          <div className="model-links">
            <a href="https://chat.openai.com" target="_blank" rel="noopener noreferrer" className="model-link">
              → ChatGPT
            </a>
            <a href="https://claude.ai" target="_blank" rel="noopener noreferrer" className="model-link">
              → Claude
            </a>
            <a href="https://gemini.google.com" target="_blank" rel="noopener noreferrer" className="model-link">
              → Gemini
            </a>
            <a href="https://www.perplexity.ai" target="_blank" rel="noopener noreferrer" className="model-link">
              → Perplexity
            </a>
          </div>
        </div>
        
        <div className="prompt-display">
          <pre>{generatedPrompt || 'Generating your prompt...'}</pre>
        </div>
      </div>
      {/* End of prompt control-section */}
    </div>
    {/* End of controls-grid */}
  </div>
);
}

// Mount the app
const root = createRoot(document.getElementById('root')!);

root.render(<App />);
