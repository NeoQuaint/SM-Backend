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
// ASK NEO (Text) - Short with Analogies
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
    const performance = user?.performance || {};
    const currentSubject = subject || userSubjects[0] || 'general';

    const finalSystemPrompt = systemPrompt || `You are Neo, the AI tutor inside SmartClass — a South African edtech platform.

TEACHING RULES:
1. MAX 3 SENTENCES per explanation
2. MAX 2-3 STEPS
3. Use analogies with PEOPLE, CARS, HILLS, BALLS, STAIRS, MONEY
4. Explain formulas in plain language
5. Be warm but BRIEF
6. End with "Try again!"

FORMULA ANALOGIES:
- Gradient: "How steep the hill is. Two friends on a hill — top friend minus bottom friend."
- Asymptote: "A car driving toward a wall that it never hits."
- Turning point: "Throw a ball up. The highest point before it falls."
- X-intercept: "Where the graph crosses the road (x-axis)."
- Y-intercept: "Where the graph starts on the y-axis."`;

    const messages = [
      { role: 'system', content: finalSystemPrompt },
    ];

    messages.push({ role: 'user', content: message });

    const completion = await openai.chat.completions.create({
      model: 'deepseek-chat',
      messages: messages,
      temperature: 0.7,
      max_tokens: 150,
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
          model_id: 'eleven_turbo_v2_5', // Turbo = cheaper
          voice_settings: {
            stability: 0.4,
            similarity_boost: 0.8,
            style: 0.3, // Lower style = cheaper
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

    // Step 1: OpenAI reads handwriting (cheap - max 30 tokens)
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

    // Step 2: DeepSeek Vision fallback (free)
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

    // Step 4: DeepSeek teaches SHORT with analogies
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
              content: `You are Neo, a maths tutor for South African students with SHORT ATTENTION SPANS who get 12/100.

TEACHING RULES:
1. MAX 3 SENTENCES total
2. Use analogies: CARS, HILLS, BALLS, STAIRS, MONEY, FRIENDS
3. Explain formulas in plain language
4. Be warm but BRIEF
5. End with "Try again!"

FORMULA ANALOGIES:
- Gradient: "How steep the hill is. Top friend minus bottom friend."
- Asymptote: "A car driving toward a wall it never hits."
- Turning point: "Throw a ball up. Highest point before it falls."
- X-intercept: "Where the graph crosses the road."
- Y-intercept: "Where the graph starts on the y-axis."

RESPOND IN THIS FORMAT:

If CORRECT:
"CORRECT: [3 words max]"

If WRONG:
"INCORRECT: [what they wrote vs correct]
WHY: [ONE sentence with analogy]
FIX: [ONE sentence]
AGAIN: [Try again!]"`
            },
            {
              role: 'user',
              content: `${message}\n\nSTUDENT'S EXTRACTED ANSWER: ${extractedText}\n\nRespond SHORT. Max 3 sentences. Use analogies.`
            }
          ],
          temperature: 0.7,
          max_tokens: 120,
        }),
      });

      const deepseekData = await deepseekResponse.json();
      const finalReply = deepseekData.choices?.[0]?.message?.content || '';
      console.log('DeepSeek final reply:', finalReply);

      if (!finalReply || !finalReply.trim()) {
        // Basic fallback
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