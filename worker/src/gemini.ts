const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent';

const FALLBACK_WORDS = [
  'elephant', 'bicycle', 'guitar', 'volcano', 'pyramid', 'submarine',
  'telescope', 'umbrella', 'cactus', 'lighthouse', 'penguin', 'compass',
  'waterfall', 'dinosaur', 'library', 'rainbow', 'astronaut', 'snowflake',
  'jellyfish', 'escalator', 'thermometer', 'parachute', 'kangaroo', 'cathedral',
  'microscope', 'avalanche', 'hammock', 'quicksand', 'chandelier', 'labyrinth',
];

export async function generateSecretWord(apiKey: string): Promise<string> {
  if (!apiKey) {
    return FALLBACK_WORDS[Math.floor(Math.random() * FALLBACK_WORDS.length)];
  }

  const prompt = {
    contents: [{
      parts: [{
        text: `You are a game master for the 20 Questions game. Generate exactly ONE valid noun (Person, Place, or Thing). The word should be common enough for English learners but not too obvious. Output ONLY the word in lowercase, with no punctuation or additional text.`
      }]
    }]
  };

  const resp = await fetch(`${GEMINI_API_BASE}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(prompt),
  });

  if (!resp.ok) throw new Error(`Gemini word gen failed: ${resp.status}`);

  const data = await resp.json() as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  return raw.trim().toLowerCase().replace(/[^a-z\s]/g, '').split('\n')[0].trim();
}

export interface EvaluationResult {
  score: number;
  feedback: string;
  highlightedWords: string[];
}

// Score words by CEFR difficulty: A1=1, A2=2, B1=3, B2=4, C1/C2=5
// Sends all words in a single API call to minimise token usage.
export async function scoreWordDifficulty(apiKey: string, words: string[]): Promise<Record<string, number>> {
  if (!words.length) return {};
  if (!apiKey) return Object.fromEntries(words.map(w => [w, 1]));

  const prompt = {
    contents: [{
      parts: [{
        text: `You are a CEFR English level expert. Score each of the following words by difficulty:
A1=1, A2=2, B1=3, B2=4, C1 or C2=5.

Words: ${words.join(', ')}

Return ONLY valid JSON (no markdown) with this exact format:
{"word1": 2, "word2": 4, ...}
Include every word. Use 1-5 only.`
      }]
    }]
  };

  try {
    const resp = await fetch(`${GEMINI_API_BASE}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prompt),
    });
    if (!resp.ok) throw new Error(`Gemini word score failed: ${resp.status}`);
    const data = await resp.json() as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
    const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    const result: Record<string, number> = {};
    for (const word of words) {
      const v = parsed[word];
      result[word] = typeof v === 'number' ? Math.max(1, Math.min(5, Math.round(v))) : 1;
    }
    return result;
  } catch {
    return Object.fromEntries(words.map(w => [w, 1]));
  }
}

export async function evaluateQuestion(apiKey: string, question: string): Promise<EvaluationResult> {
  const prompt = {
    contents: [{
      parts: [{
        text: `You are an English language teacher evaluating a student's question in a 20 Questions game. The student asked: "${question}"

Evaluate the question based on: 1) Grammatical correctness 2) Vocabulary usage.

Return ONLY valid JSON (no markdown, no code blocks) with exactly these keys:
{"score": <integer 1-10>, "feedback": "<short encouraging sentence>", "highlighted_words": [<good vocab words>]}`
      }]
    }]
  };

  const resp = await fetch(`${GEMINI_API_BASE}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(prompt),
  });

  if (!resp.ok) throw new Error(`Gemini eval failed: ${resp.status}`);

  const data = await resp.json() as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> };
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';

  try {
    const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(cleaned) as { score?: unknown; feedback?: unknown; highlighted_words?: unknown };
    return {
      score: typeof parsed.score === 'number' ? Math.max(1, Math.min(10, parsed.score)) : 5,
      feedback: typeof parsed.feedback === 'string' ? parsed.feedback : 'Good effort!',
      highlightedWords: Array.isArray(parsed.highlighted_words) ? parsed.highlighted_words as string[] : [],
    };
  } catch {
    return { score: 5, feedback: 'Good effort! Keep practicing.', highlightedWords: [] };
  }
}
