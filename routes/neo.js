const router = require('express').Router();
const OpenAI = require('openai');
const pool = require('../db');
const auth = require('../middleware/auth');

const openai = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: 'https://api.deepseek.com/v1',
});

// ElevenLabs Configuration - Jessica is BACK
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
// ASK NEO (Text) - 7th Grade Teaching Style
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

    const performanceContext = Object.entries(performance)
      .map(([subj, lvl]) => `${subj}: ${lvl} (${performanceDescriptions[lvl] || 'unknown'})`)
      .join('\n');

    let history = [];
    try {
      const historyResult = await pool.query(
        `SELECT message, response FROM neo_conversations 
         WHERE user_id = $1 
         ORDER BY created_at DESC 
         LIMIT 6`,
        [req.userId]
      );
      history = historyResult.rows.reverse();
    } catch (dbErr) {
      console.log('Could not fetch history:', dbErr.message);
    }

    const finalSystemPrompt = systemPrompt || `You are Neo, the AI tutor inside SmartClass — a South African edtech platform.

YOU ARE TEACHING STUDENTS WHO GET 12/100 IN MATHS. They are NOT dumb — they just never had someone explain it simply enough.

━━━━━━━━━━━━━━━━━━━━━━━
TEACHING RULES (Follow STRICTLY)
━━━━━━━━━━━━━━━━━━━━━━━

1. EXPLAIN LIKE THEY'RE IN 7TH GRADE
   - Use the SIMPLEST words possible
   - Use everyday analogies (cookies, stairs, temperature, money, soccer)
   - One idea per sentence
   - Short sentences

2. BREAK EVERYTHING INTO TINY NUMBERED STEPS
   - Step 1, Step 2, Step 3...
   - Never skip steps
   - Assume they know NOTHING

3. BE WARM AND ENCOURAGING
   - Celebrate small wins
   - Never judge
   - "You've got this!" energy

4. SOUTH AFRICAN CONTEXT
   - Use rands, local examples
   - CAPS awareness

5. NEVER just give the answer
   - Guide them to discover it
   - Ask "What do YOU think?"

6. Keep it SHORT — 4-5 sentences max per step
7. Sound human, warm, genuinely invested

End with an encouraging check-in question.`;

    const messages = [
      { role: 'system', content: finalSystemPrompt },
    ];

    for (const h of history) {
      messages.push({ role: 'user', content: h.message });
      messages.push({ role: 'assistant', content: h.response });
    }

    messages.push({ role: 'user', content: message });

    const completion = await openai.chat.completions.create({
      model: 'deepseek-chat',
      messages: messages,
      temperature: 0.7,
      max_tokens: 800,
    });

    const neoReply = completion.choices[0].message.content;
    const tokensUsed = completion.usage?.total_tokens || 0;

    try {
      await pool.query(
        `INSERT INTO neo_conversations 
         (user_id, room_id, message, response, context, tokens_used, model) 
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          req.userId,
          roomId || null,
          message,
          neoReply,
          JSON.stringify(context || { grade, level, subject: currentSubject, performance }),
          tokensUsed,
          'deepseek-chat'
        ]
      );
    } catch (dbErr) {
      console.log('Could not save conversation:', dbErr.message);
    }

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
// NEO SPEAK — ElevenLabs (Jessica)
// ==========================================
router.post('/speak', async (req, res) => {
  try {
    const { text } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Text is required' });
    }

    let cleanText = text.replace(/[^a-zA-Z0-9\s.,!?()=+\-']/g, '');
    if (cleanText.length > 500) {
      cleanText = cleanText.substring(0, 500);
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
            style: 0.5,
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
// NEO VISION — OpenAI reads, DeepSeek teaches (7th Grade Style)
// ==========================================
router.post('/vision', async (req, res) => {
  try {
    const { imageBase64, subject, message } = req.body;

    if (!imageBase64) {
      return res.status(400).json({ error: 'Image is required' });
    }

    console.log('=== NEO VISION STARTED ===');
    console.log('Subject:', subject);

    let extractedText = '';
    let usedOpenAI = false;

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
                content: 'You are a handwriting recognition system. Read the handwritten math in the image and extract ONLY what the student wrote. Return just the answer text, nothing else. If you cannot read it, respond exactly: UNCLEAR'
              },
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: 'Read the handwriting in this image. What did the student write?'
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
            max_tokens: 100,
          }),
        });

        const openaiData = await openaiResponse.json();
        extractedText = openaiData.choices?.[0]?.message?.content || '';
        usedOpenAI = true;
        console.log('OpenAI extracted:', extractedText);

      } catch (openaiErr) {
        console.error('OpenAI error:', openaiErr.message);
        extractedText = '';
      }
    }

    // Step 2: DeepSeek Vision fallback
    if (!extractedText || extractedText === 'UNCLEAR' || extractedText.includes('UNCLEAR')) {
      try {
        console.log('Step 2: Falling back to DeepSeek Vision...');
        
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
                    text: 'Read the handwriting in this image. Extract ONLY what the student wrote. If you cannot read it, respond: UNCLEAR'
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
            max_tokens: 100,
          }),
        });

        const deepseekReadData = await deepseekReadResponse.json();
        extractedText = deepseekReadData.choices?.[0]?.message?.content || '';
        console.log('DeepSeek extracted:', extractedText);

      } catch (deepseekReadErr) {
        console.error('DeepSeek read error:', deepseekReadErr.message);
      }
    }

    // Step 3: Return UNCLEAR if still no text
    if (!extractedText || extractedText === 'UNCLEAR' || extractedText.includes('UNCLEAR')) {
      console.log('Could not read handwriting. Returning UNCLEAR.');
      return res.json({ reply: 'UNCLEAR: Cannot read handwriting' });
    }

    console.log('Extracted answer:', extractedText);

    // Step 4: DeepSeek teaches like a 7th grader
    console.log('Step 4: DeepSeek teaching (7th grade style)...');
    
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
              content: `You are Neo, a warm and patient mathematics tutor for South African students who get 12/100 in maths. They are NOT dumb — they just never had someone explain it simply.

EXPLAIN LIKE YOU'RE TALKING TO A 7TH GRADER:
- Use the SIMPLEST words possible
- Use everyday analogies (cookies, stairs, temperature, money, soccer)
- One idea per sentence
- Break everything into TINY numbered steps (Step 1, Step 2, Step 3...)
- NEVER assume they know anything
- Be encouraging: "You've got this!"

RESPOND IN THIS FORMAT:

If CORRECT:
"CORRECT: [warm, brief praise]"

If WRONG:
"INCORRECT: [what they wrote vs correct answer in simple words]
MISTAKE: [explain the mistake in ONE simple sentence]
TEACHING: [explain the solution like talking to a 7th grader. Use analogies. Number each step. Be encouraging.]"`
            },
            {
              role: 'user',
              content: `${message}\n\nSTUDENT'S EXTRACTED ANSWER: ${extractedText}\n\nCompare this to the memorandum and explain like you're teaching a 7th grader who gets 12/100 in maths. Use analogies and tiny steps.`
            }
          ],
          temperature: 0.7,
          max_tokens: 800,
        }),
      });

      const deepseekData = await deepseekResponse.json();
      const finalReply = deepseekData.choices?.[0]?.message?.content || '';
      console.log('DeepSeek final reply:', finalReply);

      if (!finalReply || !finalReply.trim()) {
        console.log('DeepSeek returned empty. Using basic comparison...');
        
        const extracted = extractedText.toLowerCase().trim();
        const correctAnswerMatch = message.match(/Correct answer: ([^\n]+)/);
        const correctAnswer = correctAnswerMatch ? correctAnswerMatch[1].toLowerCase().trim() : '';
        
        const correctSimplified = correctAnswer
          .replace(/or/gi, '|')
          .replace(/y\s*=\s*/g, '')
          .replace(/k\(x\)\s*=\s*/g, '')
          .trim();
        
        const extractedSimplified = extracted
          .replace(/y\s*=\s*/g, '')
          .replace(/k\(x\)\s*=\s*/g, '')
          .trim();
        
        if (correctSimplified.includes(extractedSimplified) || extractedSimplified.includes(correctSimplified)) {
          return res.json({ reply: 'CORRECT: Well done! You got it right!' });
        } else {
          return res.json({
            reply: `INCORRECT: You wrote "${extractedText}" but the correct answer is "${correctAnswer}"
MISTAKE: Your answer doesn't match what we need
TEACHING: Step 1: Look at the graph. Step 2: Find where the dotted line sits on the y-axis. Step 3: That number is your answer. You've got this!`
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