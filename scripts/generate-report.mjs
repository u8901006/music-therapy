#!/usr/bin/env node

import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const API_BASE = process.env.NVIDIA_API_BASE || 'https://integrate.api.nvidia.com/v1';
const MODELS = ['nvidia/nemotron-3-super-120b-a12b', 'nvidia/nemotron-3-nano-30b-a3b'];

const SYSTEM_PROMPT = `你是音樂治療領域的資深研究員與科學傳播者。你的任務是：
1. 從提供的醫學文獻中，篩選出最具臨床意義與研究價值的音樂治療相關論文
2. 對每篇論文進行繁體中文摘要、分類、PICO 分析
3. 評估其臨床實用性（高/中/低）
4. 生成適合醫療專業人員閱讀的日報

輸出格式要求：
- 語言：繁體中文（台灣用語）
- 專業但易懂
- 每篇論文需包含：中文標題、一句話總結、PICO分析、臨床實用性、分類標籤
- 最後提供今日精選 TOP 3（最重要/最影響臨床實踐的論文）
回傳格式必須是純 JSON，不要用 markdown code block 包裹。`;

const TAG_OPTIONS = [
  '憂鬱症', '焦慮症', '失智症', '自閉症', 'PTSD',
  '腦中風復健', '帕金森氏症', '疼痛管理', '安寧緩和醫療',
  '新生兒加護', '社區音樂治療', '神經音樂治療',
  '即興音樂治療', '接受式音樂治療', '歌曲創作治療',
  '節奏聽覺刺激', '旋律語調治療', '團體音樂治療',
  '神經科學', '生理機制', '生活品質', '情緒調節',
  '社會參與', '照顧者支持', '兒少治療', '老年照護',
  '成癮治療', '思覺失調症', '睡眠醫學', '安寧照護',
];

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { input: '', output: '', apiKey: process.env.NVIDIA_API_KEY || '' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && args[i + 1]) opts.input = args[++i];
    else if (args[i] === '--output' && args[i + 1]) opts.output = args[++i];
    else if (args[i] === '--api-key' && args[i + 1]) opts.apiKey = args[++i];
  }
  return opts;
}

function loadPapers(path) {
  const raw = path === '-' ? readFileSync(0, 'utf-8') : readFileSync(resolve(path), 'utf-8');
  return JSON.parse(raw);
}

function robustJsonParse(text) {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    const firstNewline = cleaned.indexOf('\n');
    cleaned = firstNewline >= 0 ? cleaned.slice(firstNewline + 1) : cleaned.slice(3);
    cleaned = cleaned.replace(/```\s*$/, '');
  }
  cleaned = cleaned.trim();

  try {
    return JSON.parse(cleaned);
  } catch { /* try harder */ }

  const jsonStart = cleaned.indexOf('{');
  const jsonEnd = cleaned.lastIndexOf('}');
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    try {
      return JSON.parse(cleaned.slice(jsonStart, jsonEnd + 1));
    } catch { /* fall through */ }
  }

  const arrayStart = cleaned.indexOf('[');
  const arrayEnd = cleaned.lastIndexOf(']');
  if (arrayStart >= 0 && arrayEnd > arrayStart) {
    try {
      return JSON.parse(cleaned.slice(arrayStart, arrayEnd + 1));
    } catch { /* fall through */ }
  }

  throw new Error('Unable to parse AI response as JSON');
}

async function analyzePapers(apiKey, papersData) {
  const dateStr = papersData.date || new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const count = papersData.count || 0;
  const papersText = JSON.stringify(papersData.papers || [], null, 2);

  const prompt = `以下是 ${dateStr} 從 PubMed 抓取的最新音樂治療文獻（共 ${count} 篇）。
請進行以下分析，並以 JSON 格式回傳（不要用 markdown code block）：
{
  "date": "${dateStr}",
  "market_summary": "1-2句話總結今天文獻的整體趨勢與亮點",
  "top_picks": [
    {
      "rank": 1,
      "title_zh": "中文標題",
      "title_en": "English Title",
      "journal": "期刊名",
      "summary": "一句話總結（繁體中文，點出核心發現與臨床意義）",
      "pico": {
        "population": "研究對象",
        "intervention": "介入措施",
        "comparison": "對照組",
        "outcome": "主要結果"
      },
      "clinical_utility": "高/中/低",
      "utility_reason": "為什麼實用的一句話說明",
      "tags": ["標籤1", "標籤2"],
      "url": "原文連結",
      "emoji": "相關emoji"
    }
  ],
  "all_papers": [
    {
      "title_zh": "中文標題",
      "title_en": "English Title",
      "journal": "期刊名",
      "summary": "一句話總結",
      "clinical_utility": "高/中/低",
      "tags": ["標籤1"],
      "url": "連結",
      "emoji": "emoji"
    }
  ],
  "keywords": ["關鍵字1", "關鍵字2"],
  "topic_distribution": {
    "失智症": 3,
    "自閉症": 2
  }
}

原始文獻資料：
${papersText}

請篩選出最重要的 TOP 5-8 篇論文放入 top_picks（按重要性排序），其餘放入 all_papers。
每篇 paper 的 tags 請從以下選擇：${TAG_OPTIONS.join('、')}。
記住：回傳純 JSON，不要用 \`\`\`json\`\`\` 包裹。`;

  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };

  for (const model of MODELS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        console.error(`[INFO] Trying ${model} (attempt ${attempt + 1})...`);
        const resp = await fetch(`${API_BASE}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: prompt },
            ],
            temperature: 1.0,
            top_p: 0.95,
            max_tokens: 16384,
            chat_template_kwargs: { enable_thinking: false },
          }),
          signal: AbortSignal.timeout(480000),
        });

        if (resp.status === 429) {
          const wait = 60000 * (attempt + 1);
          console.error(`[WARN] Rate limited, waiting ${wait / 1000}s...`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }

        if (!resp.ok) {
          const body = await resp.text();
          console.error(`[ERROR] HTTP ${resp.status}: ${body.slice(0, 200)}`);
          if (resp.status >= 500) { await new Promise(r => setTimeout(r, 5000)); continue; }
          break;
        }

        const data = await resp.json();
        const text = data.choices?.[0]?.message?.content || '';
        const result = robustJsonParse(text);
        console.error(`[INFO] Analysis complete: ${(result.top_picks || []).length} top picks, ${(result.all_papers || []).length} total`);
        return result;
      } catch (e) {
        if (e.name === 'SyntaxError' || e.message?.includes('JSON')) {
          console.error(`[WARN] JSON parse failed on attempt ${attempt + 1}: ${e.message}`);
          if (attempt < 2) { await new Promise(r => setTimeout(r, 5000)); continue; }
        } else {
          console.error(`[ERROR] ${model} failed: ${e.message}`);
          break;
        }
      }
    }
  }

  return null;
}

function generateHtml(analysis) {
  const dateStr = analysis.date || new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const parts = dateStr.split('-');
  const dateDisplay = parts.length === 3 ? `${parts[0]}年${parseInt(parts[1])}月${parseInt(parts[2])}日` : dateStr;

  const summary = escapeHtml(analysis.market_summary || '');
  const topPicks = analysis.top_picks || [];
  const allPapers = analysis.all_papers || [];
  const keywords = analysis.keywords || [];
  const topicDist = analysis.topic_distribution || {};

  const utilityClass = (u) => u === '高' ? 'utility-high' : u === '中' ? 'utility-mid' : 'utility-low';

  const renderPico = (pico) => {
    if (!pico || !Object.keys(pico).length) return '';
    return `<div class="pico">
      <div class="pico-item"><strong>P</strong> ${escapeHtml(pico.population || '-')}</div>
      <div class="pico-item"><strong>I</strong> ${escapeHtml(pico.intervention || '-')}</div>
      <div class="pico-item"><strong>C</strong> ${escapeHtml(pico.comparison || '-')}</div>
      <div class="pico-item"><strong>O</strong> ${escapeHtml(pico.outcome || '-')}</div>
    </div>`;
  };

  const topPicksHtml = topPicks.map(pick => {
    const tags = (pick.tags || []).map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('');
    const util = pick.clinical_utility || '中';
    return `<div class="paper-card top-pick">
      <div class="pick-rank">#${pick.rank || ''}</div>
      <span class="paper-emoji">${pick.emoji || '📄'}</span>
      <span class="utility-badge ${utilityClass(util)}">${escapeHtml(util)}實用性</span>
      <h3>${escapeHtml(pick.title_zh || pick.title_en || '')}</h3>
      <p class="journal">${escapeHtml(pick.journal || '')} · ${escapeHtml(pick.title_en || '')}</p>
      <p class="summary">${escapeHtml(pick.summary || '')}</p>
      ${renderPico(pick.pico)}
      ${pick.utility_reason ? `<p class="utility-reason">💡 ${escapeHtml(pick.utility_reason)}</p>` : ''}
      <div class="tags">${tags}</div>
      <a href="${escapeHtml(pick.url || '#')}" class="read-more" target="_blank" rel="noopener">閱讀原文 →</a>
    </div>`;
  }).join('\n');

  const allPapersHtml = allPapers.map(paper => {
    const tags = (paper.tags || []).map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('');
    const util = paper.clinical_utility || '中';
    return `<div class="paper-card">
      <span class="paper-emoji">${paper.emoji || '📄'}</span>
      <span class="utility-badge ${utilityClass(util)}">${escapeHtml(util)}</span>
      <h3>${escapeHtml(paper.title_zh || paper.title_en || '')}</h3>
      <p class="journal">${escapeHtml(paper.journal || '')}</p>
      <p class="summary">${escapeHtml(paper.summary || '')}</p>
      <div class="tags">${tags}</div>
      <a href="${escapeHtml(paper.url || '#')}" class="read-more" target="_blank" rel="noopener">PubMed →</a>
    </div>`;
  }).join('\n');

  const keywordsHtml = keywords.map(k => `<span class="keyword">${escapeHtml(k)}</span>`).join('');

  const maxCount = Math.max(...Object.values(topicDist), 1);
  const topicBarsHtml = Object.entries(topicDist).map(([topic, count]) => {
    const widthPct = Math.round((count / maxCount) * 100);
    return `<div class="topic-row">
      <span class="topic-label">${escapeHtml(topic)}</span>
      <div class="topic-bar-bg"><div class="topic-bar" style="width:${widthPct}%"></div></div>
      <span class="topic-count">${count}</span>
    </div>`;
  }).join('\n');

  const totalCount = topPicks.length + allPapers.length;

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Music Therapy Research · 音樂治療研究文獻日報 · ${dateDisplay}</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🎵</text></svg>">
<style>${CSS}</style>
</head>
<body>
<div class="container">
<h1>🎵 Music Therapy Research · 音樂治療研究文獻日報</h1>
<div class="divider"></div>
<div class="meta">📅 ${dateDisplay} &nbsp;|&nbsp; 📊 ${totalCount} 篇文獻 &nbsp;|&nbsp; Powered by PubMed + nvidia/nemotron-3-super-120b-a12b</div>
<h2>📋 今日文獻趨勢</h2>
<p class="market-summary">${summary}</p>
${topPicksHtml ? `<h2>⭐ 今日精選 TOP Picks</h2>\n${topPicksHtml}` : ''}
${allPapersHtml ? `<h2>📚 其他值得關注的文獻</h2>\n${allPapersHtml}` : ''}
${topicBarsHtml ? `<h2>📊 主題分布</h2>\n${topicBarsHtml}` : ''}
${keywordsHtml ? `<h2>🏷️ 關鍵字</h2>\n<div class="keywords">${keywordsHtml}</div>` : ''}
<div class="footer">
  <div class="footer-links">
    <a href="https://www.leepsyclinic.com/" target="_blank" rel="noopener">🏥 李政洋身心診所首頁</a>
    <a href="https://blog.leepsyclinic.com/" target="_blank" rel="noopener">📬 訂閱電子報</a>
    <a href="https://buymeacoffee.com/CYlee" target="_blank" rel="noopener">☕ Buy Me a Coffee</a>
  </div>
  <p class="footer-info">資料來源：PubMed · 分析模型：nvidia/nemotron-3-super-120b-a12b · <a href="https://github.com/u8901006/music-therapy">GitHub</a></p>
</div>
</div>
</body>
</html>`;
}

const CSS = `
:root {
  --bg: #f6f1e8;
  --surface: #fffaf2;
  --line: #d8c5ab;
  --text: #2b2118;
  --muted: #766453;
  --accent: #8c4f2b;
  --accent-soft: #ead2bf;
  --card-bg: #fffcf5;
}
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: "Noto Sans TC", "PingFang TC", "Helvetica Neue", Arial, sans-serif;
  background: radial-gradient(circle at top, #fff6ea 0, var(--bg) 55%, #ead8c6 100%);
  color: var(--text);
  min-height: 100vh;
  line-height: 1.75;
  -webkit-font-smoothing: antialiased;
}
.container {
  max-width: 880px;
  margin: 0 auto;
  padding: 40px 20px 60px;
}
h1 {
  font-size: 1.65rem;
  font-weight: 700;
  color: var(--accent);
  letter-spacing: 0.02em;
}
.divider {
  height: 3px;
  background: linear-gradient(90deg, var(--accent), var(--accent-soft), transparent);
  border-radius: 2px;
  margin: 12px 0 20px;
}
.meta {
  font-size: 0.92rem;
  color: var(--muted);
  margin-bottom: 28px;
}
h2 {
  font-size: 1.2rem;
  font-weight: 600;
  color: var(--text);
  margin: 36px 0 16px;
  padding-bottom: 8px;
  border-bottom: 2px solid var(--line);
}
.market-summary {
  font-size: 1.02rem;
  color: var(--text);
  line-height: 1.8;
  padding: 14px 18px;
  background: var(--surface);
  border-radius: 16px;
  border: 1px solid var(--line);
}
.paper-card {
  background: var(--card-bg);
  border: 1px solid var(--line);
  border-radius: 24px;
  padding: 22px 26px 18px;
  margin-bottom: 18px;
  position: relative;
  animation: fadeUp 0.4s ease both;
  transition: box-shadow 0.2s, transform 0.2s;
}
.paper-card:hover {
  box-shadow: 0 6px 24px rgba(61,36,15,0.09);
  transform: translateY(-2px);
}
.paper-card.top-pick {
  border-left: 4px solid var(--accent);
  background: linear-gradient(135deg, var(--card-bg) 0%, #fff8ee 100%);
}
.pick-rank {
  position: absolute;
  top: 14px;
  right: 18px;
  font-size: 2rem;
  font-weight: 800;
  color: var(--accent-soft);
  line-height: 1;
}
.paper-emoji { font-size: 1.3rem; margin-right: 6px; }
.utility-badge {
  display: inline-block;
  font-size: 0.78rem;
  font-weight: 600;
  padding: 2px 10px;
  border-radius: 12px;
  margin-left: 4px;
  vertical-align: middle;
}
.utility-high { background: #d4edda; color: #155724; }
.utility-mid { background: #fff3cd; color: #856404; }
.utility-low { background: #e2e3e5; color: #6c757d; }
.paper-card h3 {
  font-size: 1.05rem;
  font-weight: 600;
  margin: 10px 0 6px;
  color: var(--text);
  line-height: 1.5;
  padding-right: 48px;
}
.journal {
  font-size: 0.85rem;
  color: var(--muted);
  margin-bottom: 8px;
}
.summary {
  font-size: 0.95rem;
  color: var(--text);
  line-height: 1.7;
  margin-bottom: 10px;
}
.pico {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  background: var(--surface);
  border-radius: 12px;
  padding: 12px 16px;
  margin: 10px 0;
  font-size: 0.88rem;
  border: 1px solid var(--line);
}
.pico-item strong {
  color: var(--accent);
  margin-right: 4px;
}
.utility-reason {
  font-size: 0.88rem;
  color: var(--muted);
  margin-bottom: 8px;
}
.tags { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 6px; }
.tag {
  display: inline-block;
  font-size: 0.78rem;
  background: var(--accent-soft);
  color: var(--accent);
  padding: 2px 10px;
  border-radius: 12px;
  font-weight: 500;
}
.read-more {
  display: inline-block;
  font-size: 0.88rem;
  color: var(--accent);
  text-decoration: none;
  font-weight: 500;
  margin-top: 4px;
  transition: color 0.15s;
}
.read-more:hover { text-decoration: underline; }
.keywords { display: flex; flex-wrap: wrap; gap: 8px; }
.keyword {
  display: inline-block;
  font-size: 0.82rem;
  background: var(--surface);
  border: 1px solid var(--line);
  color: var(--text);
  padding: 4px 14px;
  border-radius: 20px;
}
.topic-row {
  display: flex;
  align-items: center;
  margin-bottom: 8px;
  gap: 10px;
}
.topic-label {
  min-width: 100px;
  font-size: 0.88rem;
  text-align: right;
  color: var(--text);
}
.topic-bar-bg {
  flex: 1;
  height: 18px;
  background: var(--surface);
  border-radius: 9px;
  overflow: hidden;
  border: 1px solid var(--line);
}
.topic-bar {
  height: 100%;
  background: linear-gradient(90deg, var(--accent), var(--accent-soft));
  border-radius: 9px;
  transition: width 0.5s ease;
}
.topic-count {
  min-width: 28px;
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--muted);
}
.footer {
  margin-top: 48px;
  padding-top: 24px;
  border-top: 2px solid var(--line);
  text-align: center;
}
.footer-links {
  display: flex;
  justify-content: center;
  flex-wrap: wrap;
  gap: 16px;
  margin-bottom: 16px;
}
.footer-links a {
  display: inline-block;
  font-size: 0.92rem;
  color: var(--accent);
  text-decoration: none;
  padding: 8px 18px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 20px;
  transition: background 0.15s, transform 0.15s;
}
.footer-links a:hover {
  background: var(--accent-soft);
  transform: translateY(-1px);
}
.footer-info {
  font-size: 0.82rem;
  color: var(--muted);
}
.footer-info a { color: var(--accent); text-decoration: none; }
.footer-info a:hover { text-decoration: underline; }
@keyframes fadeUp {
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: translateY(0); }
}
@media (max-width: 600px) {
  .container { padding: 20px 14px 40px; }
  h1 { font-size: 1.3rem; }
  .paper-card { padding: 16px 16px 14px; border-radius: 18px; }
  .paper-card h3 { font-size: 0.95rem; padding-right: 0; }
  .pick-rank { font-size: 1.5rem; }
  .pico { grid-template-columns: 1fr; }
  .topic-label { min-width: 70px; font-size: 0.8rem; }
  .footer-links { flex-direction: column; align-items: center; }
}
`;

async function main() {
  const opts = parseArgs();
  const papersData = loadPapers(opts.input);

  let analysis;
  const paperCount = Number(papersData?.count ?? papersData?.papers?.length ?? 0);
  if (paperCount === 0 || !papersData?.papers?.length) {
    console.error('[WARN] No papers found, generating empty report');
    const dateStr = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    analysis = {
      date: dateStr,
      market_summary: '今日 PubMed 暫無新的音樂治療文獻更新。請明天再查看。',
      top_picks: [],
      all_papers: [],
      keywords: [],
      topic_distribution: {},
    };
  } else {
    if (!opts.apiKey) {
      console.error('[ERROR] Missing NVIDIA_API_KEY repository secret');
      process.exit(1);
    }
    analysis = await analyzePapers(opts.apiKey, papersData);
  }

  if (!analysis) {
    console.error('[ERROR] Analysis failed, cannot generate report');
    process.exit(1);
  }

  const html = generateHtml(analysis);
  const outPath = resolve(opts.output);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html, 'utf-8');
  console.error(`[INFO] Report saved to ${opts.output}`);
}

main().catch(e => {
  console.error(`[FATAL] ${e.message}`);
  process.exit(1);
});
