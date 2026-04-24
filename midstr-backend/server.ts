import 'dotenv/config';
import express from 'express';
import midstrAiRouter from './midstr_ai_endpoints';

const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(midstrAiRouter);

app.listen(3001, () => {
  console.log('AI backend running on http://localhost:3001');
});