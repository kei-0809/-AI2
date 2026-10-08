import express from 'express';
const app = express();

// 公開URLで他人にAPI課金されないよう、ACCESS_PASSWORD を設定するとBasic認証がかかる
const PASS = process.env.ACCESS_PASSWORD;
app.get('/healthz', (_, res) => res.send('ok'));
app.use((req, res, next) => {
  if (!PASS) return next();
  const [, b64] = (req.headers.authorization || '').split(' ');
  const pw = Buffer.from(b64 || '', 'base64').toString().split(':').slice(1).join(':');
  if (pw === PASS) return next();
  res.set('WWW-Authenticate', 'Basic realm="companion"').status(401).send('Auth required');
});

app.use(express.json({ limit: '1mb' }));
app.use(express.raw({ type: 'audio/*', limit: '25mb' }));
app.use(express.static('public'));

const { ANTHROPIC_API_KEY: AK, OPENAI_API_KEY: OK } = process.env;
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
const oai = (path, body, headers = {}) =>
  fetch('https://api.openai.com/v1' + path, { method: 'POST', headers: { Authorization: 'Bearer ' + OK, ...headers }, body });
const J = { 'Content-Type': 'application/json' };

const system = (name, persona) => `あなたは3Dコンパニオン「${name}」。ユーザーと音声で会話している。
${persona}
返答は必ず次のJSONのみ（前後に文章やコードブロックを付けない）:
{"reply":"話し言葉で1〜3文","emotion":"neutral|happy|sad|angry|surprised|relaxed","motion":"none|wave|nod|shake|bounce|think|bow","image_prompt":"画像を求められた時だけ英語の詳細な生成プロンプト。不要なら空文字"}`;

// 頭脳: Claude
app.post('/api/chat', async (req, res) => {
  try {
    const { messages, name = 'リナ', persona = '' } = req.body;
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': AK, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 600, system: system(name, persona), messages }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(JSON.stringify(j));
    const t = j.content.map((c) => c.text || '').join('');
    let o;
    try { o = JSON.parse(t.match(/\{[\s\S]*\}/)[0]); }
    catch { o = { reply: t, emotion: 'neutral', motion: 'none', image_prompt: '' }; }
    res.json(o);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// 音声合成: OpenAI
app.post('/api/tts', async (req, res) => {
  const { text, voice = 'nova', style = '' } = req.body;
  const r = await oai('/audio/speech', JSON.stringify({ model: 'gpt-4o-mini-tts', voice, input: text, instructions: style, response_format: 'mp3' }), J);
  if (!r.ok) return res.status(500).json({ error: await r.text() });
  res.type('audio/mpeg').send(Buffer.from(await r.arrayBuffer()));
});

// 音声認識: OpenAI
app.post('/api/stt', async (req, res) => {
  const type = req.headers['content-type'] || 'audio/webm';
  const fd = new FormData();
  fd.append('file', new Blob([req.body], { type }), type.includes('mp4') ? 'a.mp4' : 'a.webm');
  fd.append('model', 'gpt-4o-mini-transcribe');
  fd.append('language', 'ja');
  const r = await oai('/audio/transcriptions', fd);
  res.status(r.ok ? 200 : 500).json(await r.json());
});

// 画像生成: OpenAI
app.post('/api/image', async (req, res) => {
  const r = await oai('/images/generations', JSON.stringify({ model: 'gpt-image-1', prompt: req.body.prompt, size: '1024x1024' }), J);
  const j = await r.json();
  res.status(r.ok ? 200 : 500).json(r.ok ? { b64: j.data[0].b64_json } : j);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log('listening on ' + PORT));
