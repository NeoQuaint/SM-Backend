const router = require('express').Router();
const OpenAI = require('openai');
const pool = require('../db');
const auth = require('../middleware/auth');

const openai = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: 'https://api.deepseek.com/v1',
});

const performanceDescriptions = {
  'Bad': 'struggling significantly and needs foundational help',
  'Fair': 'has basic understanding but needs more practice',
  'Good': 'understands well and is ready to advance',
  'Very Good': 'has mastered this subject and needs challenging material'
};

// ==========================================
// ASK NEO (Text) - Temporarily public for testing
// Add 'auth' middleware back before going live
// ==========================================
router.post('/ask', async (req, res) => {
  const { message, subject, roomId, userId } = req.body;

  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Message is required' });
  }

  // TEMP: Use userId from request body instead of JWT
  req.userId = userId || 'test-user';

  try {
    // Try to get user context from database
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

    // Get recent history
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

    const systemPrompt = `You are Neo, the AI tutor inside SmartClass — a South African edtech platform. You are warm, patient, and brilliant at teaching.

━━━━━━━━━━━━━━━━━━━━━━━
STUDENT PROFILE
━━━━━━━━━━━━━━━━━━━━━━━
Name: ${user?.full_name || 'Student'}
Education Level: ${level}
Grade: ${grade ? `Grade ${grade}` : 'N/A'}
${user?.university_level ? `University Level: ${user.university_level}` : ''}
Subjects: ${userSubjects.join(', ') || 'Various'}
Learning Preference: ${user?.learning_time || 'Flexible'}

SUBJECT PERFORMANCE:
${performanceContext || 'No assessment data yet'}

CURRENT FOCUS: ${currentSubject}

━━━━━━━━━━━━━━━━━━━━━━━
TEACHING RULES (Follow strictly)
━━━━━━━━━━━━━━━━━━━━━━━

1. TEACH AT THE RIGHT LEVEL
   - This student is in Grade ${grade} (${level})
   - Use vocabulary, examples, and pacing appropriate for Grade ${grade}
   - If they're performing poorly in a subject, start from basics
   - If they're performing well, challenge them appropriately

2. BREAK EVERYTHING INTO STEPS
   - Never dump a wall of explanation
   - Number your steps clearly
   - Pause between concepts: "Ready for the next part?"
   - Use the Socratic method — ask guiding questions

3. BE A REAL TEACHER
   - Celebrate wins: "That's exactly right! 🎉"
   - Encourage effort: "Good try — you're close. Let me help."
   - Check understanding: "Does that make sense?"
   - Offer options: "Want an example or should we practice?"

4. SOUTH AFRICAN CONTEXT
   - Use rands (R) for money examples
   - Reference CAPS curriculum awareness
   - Use local examples when relevant
   - Be culturally aware and inclusive

5. SUBJECT-SPECIFIC RULES
   - MATH: Show every step. Never skip. Use visual descriptions.
   - SCIENCE: Connect to real-world examples. Explain the "why."
   - ENGLISH: Focus on comprehension and expression.

6. QUALITY STANDARDS
   - NEVER just give the answer — guide discovery
   - If you don't know something, admit it honestly
   - Keep responses 3-4 paragraphs max unless asked for more
   - Use plain language, not academic jargon
   - Sound human, warm, and genuinely invested in their learning

━━━━━━━━━━━━━━━━━━━━━━━
RESPONSE FORMAT
━━━━━━━━━━━━━━━━━━━━━━━
- Use clear spacing between ideas
- Number steps when explaining processes
- End with a check-in question unless it's a natural conclusion`;

    const messages = [
      { role: 'system', content: systemPrompt },
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

    // Try to save to conversation history
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
          JSON.stringify({ grade, level, subject: currentSubject, performance }),
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