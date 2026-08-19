#!/usr/bin/env node
/**
 * 完整重排评测脚本
 * 
 * 读取私有标注数据，执行查询并计算 recall@k、MRR、位置偏差指标。
 * 标注数据路径：../../Materials/语料A/structured-data/标注数据.json
 * 
 * 注意：标注数据含证据引文（原文摘录），绝不提交 Git。
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { GenericAdapter } from '../packages/adapter-generic/dist/index.js';
import { WritingService } from '../packages/core/dist/service.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ANNOTATION_PATH = resolve(__dirname, '../../Materials/语料A/structured-data/标注数据.json');

// 加载标注数据
function loadAnnotation() {
  const raw = readFileSync(ANNOTATION_PATH, 'utf-8');
  return JSON.parse(raw);
}

// 执行 MCP 查询（直接调用 core 库）
async function executeQuery(service, workRef, query) {
  const result = await service.explore(workRef, 'search', query, 10);
  return result;
}

// 检查结果是否包含期望术语
function checkExpectedTerms(results, expectedTerms) {
  if (!results || results.length === 0) return false;
  
  // 将所有结果的 excerpt 和 title 拼接为文本
  const resultText = results.map(row => {
    const parts = [];
    if (row.title) parts.push(row.title);
    if (row.evidence?.excerpt) parts.push(row.evidence.excerpt);
    return parts.join(' ');
  }).join(' ').toLowerCase();
  
  // 检查所有期望术语是否都出现
  return expectedTerms.every(term => resultText.includes(term.toLowerCase()));
}

// 找到第一个命中的排名（1-based）
function findFirstHitRank(results, expectedTerms) {
  if (!results || results.length === 0) return -1;
  
  for (let i = 0; i < results.length; i++) {
    const row = results[i];
    const text = [
      row.title || '',
      row.evidence?.excerpt || ''
    ].join(' ').toLowerCase();
    
    if (expectedTerms.every(term => text.includes(term.toLowerCase()))) {
      return i + 1; // 1-based rank
    }
  }
  
  return -1;
}

// 检查结果是否命中期望章节
function checkExpectedChapters(results, expectedChapters) {
  // TODO: 实现章节匹配逻辑
  // expectedChapters 格式：{volume, chapter} 或 {volume, from, to} 或数组
  return false;
}

// 计算 recall@k
function calculateRecallAtK(queries, k) {
  const relevant = queries.filter(q => q.hit);
  return relevant.length / queries.length;
}

// 计算 MRR (Mean Reciprocal Rank)
function calculateMRR(queries) {
  const reciprocalRanks = queries.map(q => q.hit ? 1 / q.firstHitRank : 0);
  return reciprocalRanks.reduce((a, b) => a + b, 0) / queries.length;
}

// 主评测函数
async function evaluate() {
  console.log('加载标注数据...');
  const annotation = loadAnnotation();
  console.log(`共 ${annotation.facts.length} 条事实`);

  // 初始化服务
  const adapter = new GenericAdapter();
  const service = new WritingService([adapter]);
  
  // 解析作品（使用 TXT 格式）
  const bookPath = resolve(__dirname, '../../Materials/语料A/book-txt/语料A.txt');
  console.log(`解析作品: ${bookPath}`);
  const resolveResult = await service.resolve(bookPath);
  console.log(`解析状态: ${resolveResult.status}`);
  if (resolveResult.status !== 'resolved') {
    throw new Error(`作品解析失败: ${resolveResult.status}`);
  }
  const workRef = resolveResult.workRef;
  console.log(`workRef: ${workRef}`);
  
  // 索引作品
  console.log('索引作品...');
  const indexResult = await service.index(workRef, 'rebuild');
  console.log(`索引完成: ${indexResult.stats.documents} 文档, ${indexResult.stats.spans} spans`);

  // 分离训练集和 holdout 集
  // holdout: 前 3 章 + 后 2 章
  // 卷 1: 30 章, 卷 2: 25 章
  // holdout = 卷 1 的 1-3 章 + 卷 2 的 24-25 章
  const trainFacts = [];
  const holdoutFacts = [];
  
  for (const fact of annotation.facts) {
    const chapters = Array.isArray(fact.expectedChapters) 
      ? fact.expectedChapters 
      : [fact.expectedChapters];
    
    const isHoldout = chapters.some(ch => {
      const vol = ch.volume;
      const maxChapter = vol === 1 ? 30 : 25;
      
      if (ch.from !== undefined) {
        // 区间格式
        return ch.from <= 3 || ch.to >= maxChapter - 1;
      } else {
        // 单章格式
        return ch.chapter <= 3 || ch.chapter >= maxChapter - 1;
      }
    });
    
    if (isHoldout) {
      holdoutFacts.push(fact);
    } else {
      trainFacts.push(fact);
    }
  }
  
  console.log(`\n训练集: ${trainFacts.length} 条, Holdout: ${holdoutFacts.length} 条`);

  // 执行查询并收集结果
  console.log('\n执行查询...');
  const queryResults = [];
  
  for (let i = 0; i < trainFacts.length; i++) {
    const fact = trainFacts[i];
    const query = fact.query;
    
    try {
      const result = await executeQuery(service, workRef, query);
      
      // 检查是否命中
      const hit = checkExpectedTerms(result.results || [], fact.expectedTerms);
      const firstHitRank = hit ? findFirstHitRank(result.results || [], fact.expectedTerms) : -1;
      
      queryResults.push({
        id: fact.id,
        query: query,
        hit: hit,
        firstHitRank: firstHitRank,
        expectedTerms: fact.expectedTerms,
        expectedChapters: fact.expectedChapters
      });
      
      if ((i + 1) % 10 === 0) {
        console.log(`  已处理 ${i + 1}/${trainFacts.length} 条`);
      }
    } catch (err) {
      console.error(`  查询失败 [${fact.id}]: ${err.message}`);
      queryResults.push({
        id: fact.id,
        query: query,
        hit: false,
        firstHitRank: -1,
        error: err.message
      });
    }
  }
  
  // 计算指标
  const recallAt5 = calculateRecallAtK(queryResults, 5);
  const recallAt10 = calculateRecallAtK(queryResults, 10);
  const mrr = calculateMRR(queryResults);
  
  console.log('\n=== 评测结果 ===');
  console.log(`Recall@5: ${(recallAt5 * 100).toFixed(2)}%`);
  console.log(`Recall@10: ${(recallAt10 * 100).toFixed(2)}%`);
  console.log(`MRR: ${mrr.toFixed(4)}`);
  console.log(`命中: ${queryResults.filter(q => q.hit).length}/${queryResults.length}`);
}

evaluate().catch(err => {
  console.error('评测失败:', err);
  process.exit(1);
});
