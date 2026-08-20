const router = require('express').Router();
const OpenAI = require('openai');
const pool = require('../db');
const auth = require('../middleware/auth');

const openai = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: 'https://api.deepseek.com/v1',
});

// ElevenLabs Configuration - Jessica
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || 'sk_ba09732f52a6b3b2c4287daeb995841cf36e4180b8c06f2a';
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'cgSgspJ2msm6clMCkdW9'; // Jessica
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const performanceDescriptions = {
  'Bad': 'struggling significantly and needs foundational help',
  'Fair': 'has basic understanding but needs more practice',
  'Good': 'understands well and is ready to advance',
  'Very Good': 'has mastered this subject and needs challenging material'
};

// ==========================================
// ASK NEO (Text) - Short with Formulas
// ==========================================
router.post('/ask', async (req, res) => {
  const { message, subject, roomId, userId, systemPrompt, context } = req.body;

  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Message is required' });
  }

  req.userId = userId || 'test-user';

  try {
    let user = null;
    try {
      const userResult = await pool.query(
        `SELECT id, full_name, education_level, grade, university_level, 
                subjects, performance, learning_time 
         FROM users WHERE id = $1`,
        [req.userId]
      );
      user = userResult.rows[0];
    } catch (dbErr) {
      console.log('User not in DB, using defaults:', dbErr.message);
    }

    const grade = user?.grade || '10';
    const level = user?.education_level || 'highschool';
    const userSubjects = user?.subjects || [];
    const currentSubject = subject || userSubjects[0] || 'general';

    const finalSystemPrompt = systemPrompt || `You are Neo, the AI tutor inside SmartClass — a South African edtech platform.

TEACHING RULES:
1. MAX 3 SENTENCES total
2. Use analogies: CARS, HILLS, BALLS, STAIRS, MONEY, FRIENDS
3. ALWAYS show the formula in plain text format
4. Substitute ACTUAL numbers into the formula
5. Be warm but BRIEF
6. End with "Try again!"

FORMULA FORMATS TO USE:
- Gradient: m = (y2 - y1)/(x2 - x1)
- Y-intercept: Put x = 0
- X-intercept: Put y = 0
- Asymptote: y = [number]
- Turning point: x = -b/(2a)

ALWAYS write the formula with ACTUAL NUMBERS substituted.

Example gradient teaching:
"Gradient formula: m = (y2 - y1)/(x2 - x1)
Your points: A(0; -3) and B(2; 0)
m = (0 - (-3))/(2 - 0) = 3/2 = 1.5
Think: the hill goes up 3 for every 2 steps. Try again!"`;

    const messages = [
      { role: 'system', content: finalSystemPrompt },
    ];

    messages.push({ role: 'user', content: message });

    const completion = await openai.chat.completions.create({
      model: 'deepseek-chat',
      messages: messages,
      temperature: 0.7,
      max_tokens: 200,
    });

    const neoReply = completion.choices[0].message.content;
    const tokensUsed = completion.usage?.total_tokens || 0;

    res.json({ 
      reply: neoReply,
      tokens: tokensUsed,
    });

  } catch (err) {
    console.error('Neo error:', err.message);
    res.status(500).json({ 
      error: 'Neo is having trouble thinking. Try asking again.' 
    });
  }
});

// ==========================================
// NEO SPEAK — ElevenLabs (Jessica) - CREDIT SAVING
// ==========================================
router.post('/speak', async (req, res) => {
  try {
    const { text } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Text is required' });
    }

    // STRICTER truncation - saves credits
    let cleanText = text.replace(/[^a-zA-Z0-9\s.,!?()=+\-']/g, '');
    if (cleanText.length > 200) {
      cleanText = cleanText.substring(0, 200);
    }

    if (!cleanText.trim()) {
      return res.status(400).json({ error: 'No valid text to speak' });
    }

    console.log('Neo speaking (Jessica):', cleanText.substring(0, 100));

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': ELEVENLABS_API_KEY,
          'Accept': 'audio/mpeg',
        },
        body: JSON.stringify({
          text: cleanText,
          model_id: 'eleven_turbo_v2_5',
          voice_settings: {
            stability: 0.4,
            similarity_boost: 0.8,
            style: 0.3,
            use_speaker_boost: true,
          },
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('ElevenLabs error:', response.status, errorText);
      return res.status(response.status).json({ 
        error: 'ElevenLabs failed', 
        details: errorText 
      });
    }

    const audioBuffer = await response.arrayBuffer();
    
    res.set({
      'Content-Type': 'audio/mpeg',
      'Content-Length': audioBuffer.byteLength,
      'Cache-Control': 'no-cache',
    });
    
    res.send(Buffer.from(audioBuffer));

  } catch (err) {
    console.error('Speak error:', err.message);
    res.status(500).json({ error: 'Could not generate speech' });
  }
});

// ==========================================
// NEO VISION — OpenAI reads, DeepSeek teaches SHORT
// ==========================================
router.post('/vision', async (req, res) => {
  try {
    const { imageBase64, subject, message } = req.body;

    if (!imageBase64) {
      return res.status(400).json({ error: 'Image is required' });
    }

    console.log('=== NEO VISION STARTED ===');

    let extractedText = '';

    // Step 1: OpenAI reads handwriting
    if (OPENAI_API_KEY) {
      try {
        console.log('Step 1: OpenAI reading handwriting...');
        
        const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages: [
              {
                role: 'system',
                content: 'Read the handwritten math. Extract ONLY the answer. If unreadable, respond: UNCLEAR'
              },
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: 'What did the student write?'
                  },
                  {
                    type: 'image_url',
                    image_url: {
                      url: `data:image/jpeg;base64,${imageBase64}`
                    }
                  }
                ]
              }
            ],
            temperature: 0,
            max_tokens: 30,
          }),
        });

        const openaiData = await openaiResponse.json();
        extractedText = openaiData.choices?.[0]?.message?.content || '';
        console.log('OpenAI extracted:', extractedText);

      } catch (openaiErr) {
        console.error('OpenAI error:', openaiErr.message);
        extractedText = '';
      }
    }

    // Step 2: DeepSeek Vision fallback
    if (!extractedText || extractedText === 'UNCLEAR' || extractedText.includes('UNCLEAR')) {
      try {
        console.log('Step 2: DeepSeek Vision fallback...');
        
        const deepseekReadResponse = await fetch('https://api.deepseek.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: 'deepseek-chat',
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: 'Read the handwriting. Extract ONLY the answer. If unreadable, respond: UNCLEAR'
                  },
                  {
                    type: 'image_url',
                    image_url: {
                      url: `data:image/jpeg;base64,${imageBase64}`
                    }
                  }
                ]
              }
            ],
            temperature: 0,
            max_tokens: 30,
          }),
        });

        const deepseekReadData = await deepseekReadResponse.json();
        extractedText = deepseekReadData.choices?.[0]?.message?.content || '';
        console.log('DeepSeek extracted:', extractedText);

      } catch (deepseekReadErr) {
        console.error('DeepSeek read error:', deepseekReadErr.message);
      }
    }

    // Step 3: Return UNCLEAR
    if (!extractedText || extractedText === 'UNCLEAR' || extractedText.includes('UNCLEAR')) {
      return res.json({ reply: 'UNCLEAR: Cannot read handwriting' });
    }

    console.log('Extracted answer:', extractedText);

    // Step 4: DeepSeek teaches SHORT with formulas
    try {
      const deepseekResponse = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [
            {
              role: 'system',
              content: `You are Neo, a maths tutor for South African students with SHORT ATTENTION SPANS.

TEACHING RULES:
1. MAX 3 SENTENCES total
2. Use analogies: CARS, HILLS, BALLS, STAIRS, MONEY, FRIENDS
3. ALWAYS show the formula in plain text format
4. Substitute ACTUAL numbers into the formula
5. Be warm but BRIEF
6. End with "Try again!"

FORMULA FORMATS TO USE:
- Gradient: m = (y2 - y1)/(x2 - x1)
- Y-intercept: Put x = 0
- X-intercept: Put y = 0
- Asymptote: y = [number]
- Turning point: x = -b/(2a)

Example gradient teaching:
"Gradient formula: m = (y2 - y1)/(x2 - x1)
Your points: A(0; -3) and B(2; 0)
m = (0 - (-3))/(2 - 0) = 3/2 = 1.5
Think: the hill goes up 3 for every 2 steps. Try again!"

RESPOND IN THIS FORMAT:

If CORRECT:
"CORRECT: [3 words max]"

If WRONG:
"INCORRECT: [what they wrote vs correct]
WHY: [ONE sentence with formula]
FIX: [ONE sentence with formula and numbers]
AGAIN: [Try again!]"`
            },
            {
              role: 'user',
              content: `${message}\n\nSTUDENT'S EXTRACTED ANSWER: ${extractedText}\n\nRespond SHORT. Show formulas with actual numbers. Max 3 sentences.`
            }
          ],
          temperature: 0.7,
          max_tokens: 200,
        }),
      });

      const deepseekData = await deepseekResponse.json();
      const finalReply = deepseekData.choices?.[0]?.message?.content || '';
      console.log('DeepSeek final reply:', finalReply);

      if (!finalReply || !finalReply.trim()) {
        const extracted = extractedText.toLowerCase().trim();
        const correctAnswerMatch = message.match(/Correct answer: ([^\n]+)/);
        const correctAnswer = correctAnswerMatch ? correctAnswerMatch[1].toLowerCase().trim() : '';
        
        if (correctAnswer && extracted.includes(correctAnswer.replace(/y\s*=\s*/g, '').trim())) {
          return res.json({ reply: 'CORRECT: Yes! You got it!' });
        } else {
          return res.json({
            reply: `INCORRECT: You wrote "${extractedText}" but it's "${correctAnswer}"
WHY: Check the sign on the y-axis.
FIX: Look at the graph again. Try again!`
          });
        }
      }

      res.json({ reply: finalReply });

    } catch (deepseekErr) {
      console.error('DeepSeek teaching error:', deepseekErr.message);
      res.status(500).json({ error: 'DeepSeek failed: ' + deepseekErr.message });
    }

  } catch (err) {
    console.error('Vision error:', err.message);
    res.status(500).json({ error: 'Could not analyze image: ' + err.message });
  }
});

// ==========================================
// NEO MEMORY — Store and retrieve student context
// ==========================================

// Get student memory
router.get('/memory/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    const result = await pool.query(
      `SELECT * FROM neo_memory WHERE user_id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.json({ memory: {}, patterns: {}, preferences: {} });
    }

    const memory = result.rows[0];
    res.json({
      memory: memory.memory_data || {},
      patterns: memory.patterns || {},
      preferences: memory.preferences || {},
    });
  } catch (err) {
    console.error('Memory load error:', err);
    res.status(500).json({ error: 'Could not load memory' });
  }
});

// Save student memory
router.post('/memory', async (req, res) => {
  try {
    const { userId, memory, patterns, preferences } = req.body;

    await pool.query(
      `INSERT INTO neo_memory (user_id, memory_data, patterns, preferences, updated_at) 
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id) 
       DO UPDATE SET memory_data = $2, patterns = $3, preferences = $4, updated_at = NOW()`,
      [userId, JSON.stringify(memory), JSON.stringify(patterns), JSON.stringify(preferences)]
    );

    res.json({ status: 'saved' });
  } catch (err) {
    console.error('Memory save error:', err);
    res.status(500).json({ error: 'Could not save memory' });
  }
});

// ==========================================
// GET CONVERSATION HISTORY
// ==========================================
router.get('/history', async (req, res) => {
  try {
    const { userId, roomId } = req.query;
    
    let query = `
      SELECT id, message, response, context, tokens_used, created_at 
      FROM neo_conversations 
      WHERE user_id = $1 
    `;
    const params = [userId || 'test-user'];

    if (roomId) {
      query += ' AND room_id = $2';
      params.push(roomId);
    }

    query += ' ORDER BY created_at DESC LIMIT 50';

    const result = await pool.query(query, params);

    res.json({ 
      conversations: result.rows,
      count: result.rows.length 
    });

  } catch (err) {
    console.error('History error:', err);
    res.status(500).json({ error: 'Could not fetch conversation history' });
  }
});

// ==========================================
// HEALTH CHECK
// ==========================================
router.get('/health', (req, res) => {
  res.json({ status: 'Neo route is awake' });
});

module.exports = router;