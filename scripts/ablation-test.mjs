#!/usr/bin/env node
/**
 * 因子 Ablation 脚本
 * 
 * 逐个禁用排序因子，测量对 recall@5 和 MRR 的影响。
 * 阈值：recall@5>2%/MRR>5% 变化触发调整。
 * 
 * 注意：此脚本需要修改 store.ts 中的排序公式，仅用于本地评测。
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORE_PATH = resolve(__dirname, '../packages/core/src/store.ts');

// 因子配置
const FACTORS = [
  { name: 'coverage', pattern: /coverage\*4/g, replacement: '0' },
  { name: 'aliasBoost', pattern: /\+aliasBoost\+proximity/g, replacement: '+proximity' },
  { name: 'proximity', pattern: /\+proximity/g, replacement: '+0' },
  { name: 'headingMatches', pattern: /\+headingMatches\*\.5/g, replacement: '+0' },
  { name: 'bm25', pattern: /Math\.min\(1,Number\(row\.bm25_score\?\?0\)\/10\)/g, replacement: '0' },
  { name: 'trustBonus', pattern: /\+trustBonus/g, replacement: '+0' }
];

// 备份原始文件
function backupFile() {
  const backup = STORE_PATH + '.backup';
  writeFileSync(backup, readFileSync(STORE_PATH));
  console.log(`已备份: ${backup}`);
  return backup;
}

// 恢复文件
function restoreFile(backup) {
  writeFileSync(STORE_PATH, readFileSync(backup));
  console.log(`已恢复: ${STORE_PATH}`);
}

// 禁用单个因子
function disableFactor(factor) {
  const content = readFileSync(STORE_PATH, 'utf-8');
  const modified = content.replace(factor.pattern, factor.replacement);
  writeFileSync(STORE_PATH, modified);
  console.log(`已禁用因子: ${factor.name}`);
}

// 重新构建
function rebuild() {
  console.log('重新构建...');
  execSync('pnpm build', { cwd: resolve(__dirname, '..'), stdio: 'inherit' });
}

// 运行评测
function runEvaluation() {
  console.log('运行评测...');
  const output = execSync('node scripts/evaluate-reranking.mjs', { 
    cwd: resolve(__dirname, '..'),
    encoding: 'utf-8'
  });
  
  // 解析结果
  const recallMatch = output.match(/Recall@5: ([\d.]+)%/);
  const mrrMatch = output.match(/MRR: ([\d.]+)/);
  
  return {
    recall: recallMatch ? parseFloat(recallMatch[1]) : 0,
    mrr: mrrMatch ? parseFloat(mrrMatch[1]) : 0
  };
}

// 主函数
async function ablate() {
  console.log('=== 因子 Ablation 测试 ===\n');
  
  const backup = backupFile();
  const baseline = runEvaluation();
  console.log(`\n基线: Recall@5=${baseline.recall}%, MRR=${baseline.mrr}\n`);
  
  const results = [];
  
  for (const factor of FACTORS) {
    console.log(`\n--- 测试因子: ${factor.name} ---`);
    
    try {
      disableFactor(factor);
      rebuild();
      const result = runEvaluation();
      
      const recallDelta = result.recall - baseline.recall;
      const mrrDelta = ((result.mrr - baseline.mrr) / baseline.mrr) * 100;
      
      results.push({
        factor: factor.name,
        recall: result.recall,
        mrr: result.mrr,
        recallDelta: recallDelta,
        mrrDelta: mrrDelta,
        significant: Math.abs(recallDelta) > 2 || Math.abs(mrrDelta) > 5
      });
      
      console.log(`结果: Recall@5=${result.recall}% (Δ${recallDelta.toFixed(2)}), MRR=${result.mrr} (Δ${mrrDelta.toFixed(2)}%)`);
      console.log(`显著性: ${results[results.length - 1].significant ? '是' : '否'}`);
      
    } catch (err) {
      console.error(`测试失败: ${err.message}`);
      results.push({
        factor: factor.name,
        error: err.message
      });
    }
    
    // 恢复原始文件
    restoreFile(backup);
  }
  
  // 输出汇总
  console.log('\n\n=== Ablation 汇总 ===');
  console.log('因子\t\tRecall@5\tMRR\t\t显著性');
  for (const result of results) {
    if (result.error) {
      console.log(`${result.factor}\t错误: ${result.error}`);
    } else {
      console.log(`${result.factor}\t${result.recall}%\t\t${result.mrr}\t${result.significant ? '✓' : ''}`);
    }
  }
}

ablate().catch(err => {
  console.error('Ablation 失败:', err);
  process.exit(1);
});
