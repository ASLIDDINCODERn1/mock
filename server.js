require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/firebase-config', (req, res) => {
  res.json({
    apiKey: process.env.FIREBASE_API_KEY || '',
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || '',
    databaseURL: process.env.FIREBASE_DATABASE_URL || '',
    projectId: process.env.FIREBASE_PROJECT_ID || '',
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || '',
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '',
    appId: process.env.FIREBASE_APP_ID || '',
    measurementId: process.env.FIREBASE_MEASUREMENT_ID || ''
  });
});

app.get('/api/ai-status', (req, res) => {
  const hasGroqKey = Boolean(process.env.GROQ_API_KEY && process.env.GROQ_API_KEY.trim());
  res.json({
    ok: hasGroqKey,
    provider: 'groq',
    model: GROQ_MODEL,
    missing: hasGroqKey ? [] : ['GROQ_API_KEY'],
    message: hasGroqKey
      ? 'Groq AI is configured.'
      : 'Groq AI is not configured. Add GROQ_API_KEY to your .env file.'
  });
});

app.post('/api/writing-check', async (req, res) => {
  const { text, taskType, prompt } = req.body;
  if (!text) return res.status(400).json({ error: 'No text provided' });

  try {
    const data = await callGroqJson({
      systemPrompt: `You are an expert English writing examiner. Return valid JSON only with this exact structure:
{
  "overallScore": <number 0-100>,
  "band": "<IELTS band or grade>",
  "taskAchievement": { "score": <0-100>, "feedback": "<feedback>" },
  "coherence": { "score": <0-100>, "feedback": "<feedback>" },
  "lexicalResource": { "score": <0-100>, "feedback": "<feedback>" },
  "grammaticalRange": { "score": <0-100>, "feedback": "<feedback>" },
  "strengths": ["<strength1>", "<strength2>", "<strength3>"],
  "improvements": ["<improvement1>", "<improvement2>", "<improvement3>"],
  "correctedExcerpt": "<corrected version of the first 2 sentences>",
  "summary": "<2-sentence overall assessment>"
}`,
      userPrompt: `Task type: ${taskType || 'Essay'}
Prompt: ${prompt || 'Not provided'}

Student answer:
${text}`
    });

    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Writing analysis failed', detail: err.message });
  }
});

app.post('/api/speaking-evaluate', async (req, res) => {
  const { transcript, prompt, duration } = req.body;
  if (!transcript) return res.status(400).json({ error: 'No transcript' });

  try {
    const data = await callGroqJson({
      systemPrompt: `You are an expert IELTS speaking examiner. Return valid JSON only with this exact structure:
{
  "overallScore": <0-100>,
  "band": "<band score e.g. 7.0>",
  "fluency": { "score": <0-100>, "feedback": "<feedback>" },
  "vocabulary": { "score": <0-100>, "feedback": "<feedback>", "notableWords": ["<word1>", "<word2>"] },
  "grammar": { "score": <0-100>, "feedback": "<feedback>" },
  "pronunciation": { "score": <0-100>, "feedback": "<feedback>" },
  "taskResponse": { "score": <0-100>, "feedback": "<feedback>" },
  "strengths": ["<strength1>", "<strength2>"],
  "improvements": ["<improvement1>", "<improvement2>"],
  "modelAnswer": "<2-3 sentence example of excellent response opening>",
  "summary": "<overall assessment in 2 sentences>"
}`,
      userPrompt: `Speaking prompt:
${prompt || 'Not provided'}

Transcript (${duration || 0} seconds):
${transcript}`
    });

    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Speaking evaluation failed', detail: err.message });
  }
});

async function callGroqJson({ systemPrompt, userPrompt }) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error('Missing GROQ_API_KEY in environment');
  }

  const response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error?.message || `Groq HTTP ${response.status}`);
  }

  const content = payload.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('Groq returned an empty response');
  }

  return JSON.parse(extractJson(content));
}

function extractJson(content) {
  const text = String(content || '').trim();
  const fenceMatch = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/i);
  if (fenceMatch) return fenceMatch[1].trim();
  return text;
}

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AI Mock Exam running at http://localhost:${PORT}`));
