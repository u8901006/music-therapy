#!/usr/bin/env node

import { writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { XMLParser } from 'fast-xml-parser';

const PUBMED_SEARCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi';
const PUBMED_FETCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi';

const JOURNALS = [
  'Journal of Music Therapy',
  'Music Therapy Perspectives',
  'Nordic Journal of Music Therapy',
  'Voices: A World Forum for Music Therapy',
  'Approaches: An Interdisciplinary Journal of Music Therapy',
  'Australian Journal of Music Therapy',
  'British Journal of Music Therapy',
  'Music and Medicine',
  'The Arts in Psychotherapy',
  'Arts & Health',
  'Frontiers in Human Neuroscience',
  'Frontiers in Neuroscience',
  'Neurorehabilitation and Neural Repair',
  'Psychology of Music',
  'Journal of Alzheimer\'s Disease',
  'Pain',
  'Journal of Pain and Symptom Management',
  'Supportive Care in Cancer',
  'Journal of Advanced Nursing',
  'Aging & Mental Health',
];

const TOPICS = [
  'music therapy',
  'music-based intervention',
  'neurologic music therapy',
  'melodic intonation therapy',
  'rhythmic auditory stimulation',
  'music medicine',
  'therapeutic songwriting',
  'community music therapy',
  'guided imagery and music',
  'improvisational music therapy',
  'music listening intervention',
  'singing intervention',
  'drumming',
  'arts in health',
];

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { days: 7, maxPapers: 40, output: '-' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days' && args[i + 1]) opts.days = parseInt(args[++i], 10);
    else if (args[i] === '--max-papers' && args[i + 1]) opts.maxPapers = parseInt(args[++i], 10);
    else if (args[i] === '--output' && args[i + 1]) opts.output = args[++i];
  }
  return opts;
}

function buildJournalQuery(maxJournals = 20) {
  return JOURNALS.slice(0, maxJournals)
    .map(j => `"${j}"[Journal]`)
    .join(' OR ');
}

function buildTopicQuery() {
  return TOPICS.map(t => `"${t}"[tiab]`).join(' OR ');
}

function buildQuery(days) {
  const now = new Date();
  const lookback = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const dateStr = lookback.toISOString().slice(0, 10).replace(/-/g, '/');
  const datePart = `"${dateStr}"[Date - Publication] : "3000"[Date - Publication]`;
  const journalPart = buildJournalQuery();
  const topicPart = buildTopicQuery();
  return `((${journalPart}) OR (${topicPart})) AND ${datePart}`;
}

async function searchPapers(query, retmax = 50) {
  const url = `${PUBMED_SEARCH}?db=pubmed&term=${encodeURIComponent(query)}&retmax=${retmax}&sort=date&retmode=json`;
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'MusicTherapyBot/1.0 (research aggregator)' },
      signal: AbortSignal.timeout(30000),
    });
    const data = await resp.json();
    return data?.esearchresult?.idlist || [];
  } catch (e) {
    console.error(`[ERROR] PubMed search failed: ${e.message}`);
    return [];
  }
}

async function fetchDetails(pmids) {
  if (!pmids.length) return [];
  const ids = pmids.join(',');
  const url = `${PUBMED_FETCH}?db=pubmed&id=${ids}&retmode=xml`;
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'MusicTherapyBot/1.0 (research aggregator)' },
      signal: AbortSignal.timeout(60000),
    });
    const xml = await resp.text();
    return parseXmlPapers(xml);
  } catch (e) {
    console.error(`[ERROR] PubMed fetch failed: ${e.message}`);
    return [];
  }
}

function parseXmlPapers(xml) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    isArray: (name) => ['PubmedArticle', 'AbstractText', 'Keyword'].includes(name),
  });
  const root = parser.parse(xml);
  const articles = root?.PubmedArticleSet?.PubmedArticle || [];
  const papers = [];

  for (const article of articles) {
    try {
      const medline = article.MedlineCitation;
      if (!medline) continue;
      const art = medline.Article;
      if (!art) continue;

      const titleEl = art.ArticleTitle;
      const title = typeof titleEl === 'string' ? titleEl.trim() : (titleEl?.['#text'] || titleEl?.['#'] || '').trim();
      if (!title) continue;

      let abstract = '';
      const abstractParts = art.Abstract?.AbstractText || [];
      const parts = Array.isArray(abstractParts) ? abstractParts : [abstractParts];
      for (const part of parts) {
        const label = part['@_Label'] || '';
        const text = typeof part === 'string' ? part : (part['#text'] || part['#'] || '');
        if (label && text) abstract += `${label}: ${text} `;
        else if (text) abstract += `${text} `;
      }
      abstract = abstract.trim().slice(0, 2000);

      const journal = art.Journal?.Title || '';
      const pubDate = art.Journal?.JournalIssue?.PubDate;
      let dateStr = '';
      if (pubDate) {
        const y = pubDate.Year || '';
        const m = pubDate.Month || '';
        const d = pubDate.Day || '';
        dateStr = [y, m, d].filter(Boolean).join(' ');
      }

      const pmid = String(medline.PMID || '');
      const link = pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : '';

      const kwList = medline.KeywordList || [];
      const keywords = [];
      const kwArrays = Array.isArray(kwList) ? kwList : [kwList];
      for (const kl of kwArrays) {
        const kws = kl?.Keyword || [];
        for (const kw of (Array.isArray(kws) ? kws : [kws])) {
          const kwText = typeof kw === 'string' ? kw : (kw?.['#text'] || kw?.['#'] || '');
          if (kwText) keywords.push(kwText.trim());
        }
      }

      papers.push({ pmid, title, journal, date: dateStr, abstract, url: link, keywords });
    } catch (e) {
      console.error(`[WARN] Failed to parse article: ${e.message}`);
    }
  }
  return papers;
}

function getAlreadySummarizedPmids() {
  const docsDir = resolve(process.cwd(), 'docs');
  if (!existsSync(docsDir)) return new Set();
  const pmids = new Set();
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  try {
    const files = readdirSync(docsDir)
      .filter(f => f.startsWith('music-therapy-') && f.endsWith('.html'))
      .sort()
      .reverse()
      .slice(0, 7);

    for (const file of files) {
      try {
        const html = readFileSync(resolve(docsDir, file), 'utf-8');
        const matches = html.matchAll(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/g);
        for (const m of matches) pmids.add(m[1]);
      } catch { /* skip unreadable files */ }
    }
  } catch { /* directory read error */ }

  return pmids;
}

function getTaipeiDate() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

async function main() {
  const opts = parseArgs();
  console.error(`[INFO] Searching PubMed for music therapy papers from last ${opts.days} days...`);

  const query = buildQuery(opts.days);
  let pmids = await searchPapers(query, opts.maxPapers);
  console.error(`[INFO] Found ${pmids.length} PMIDs`);

  if (!pmids.length) {
    const empty = { date: getTaipeiDate(), count: 0, papers: [] };
    const json = JSON.stringify(empty, null, 2);
    if (opts.output === '-') console.log(json);
    else writeFileSync(opts.output, json, 'utf-8');
    return;
  }

  const papers = await fetchDetails(pmids);
  console.error(`[INFO] Fetched details for ${papers.length} papers`);

  const alreadySummarized = getAlreadySummarizedPmids();
  const newPapers = papers.filter(p => !alreadySummarized.has(p.pmid));
  console.error(`[INFO] After dedup: ${newPapers.length} new papers (skipped ${papers.length - newPapers.length} already summarized)`);

  const output = {
    date: getTaipeiDate(),
    count: newPapers.length,
    papers: newPapers,
  };

  const json = JSON.stringify(output, null, 2);
  if (opts.output === '-') console.log(json);
  else {
    writeFileSync(opts.output, json, 'utf-8');
    console.error(`[INFO] Saved to ${opts.output}`);
  }
}

main().catch(e => {
  console.error(`[FATAL] ${e.message}`);
  process.exit(1);
});
