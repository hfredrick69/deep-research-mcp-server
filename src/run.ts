import * as fs from 'node:fs/promises';
import * as readline from 'node:readline';
import { research, writeFinalReport, type ResearchProgress } from './deep-research.js';
import { OutputManager } from './output-manager.js';

const output = new OutputManager();
function log(...args: unknown[]) {
  output.log(args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' '));
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function askQuestion(query: string): Promise<string> {
  return new Promise(resolve => {
    rl.question(query, answer => resolve(answer.trim()));
  });
}

async function run() {
  try {
    let initialQuery: string = '';
    if (process.argv.length > 2) {
      initialQuery = process.argv.slice(2).join(' ');
      log('Research query from command line: ' + initialQuery);
    } else {
      initialQuery = await askQuestion('What would you like to research? ');
    }

    if (!initialQuery) {
      log('Query empty.'); rl.close(); return;
    }

    let breadth = 2;
    let depth = 2;

    log('Starting research: ' + initialQuery + ' (Depth: ' + depth + ', Breadth: ' + breadth + ')');

    const { learnings, visitedUrls } = await research({
      query: initialQuery,
      breadth,
      depth,
      onProgress: (p) => output.updateProgress(p),
    });

    log('Writing report...');
    const report = await writeFinalReport({ prompt: initialQuery, learnings, visitedUrls });
    await fs.writeFile('output.md', report, 'utf-8');
    log('Done. Saved to output.md');

  } catch (error) {
    console.error('Error:', error);
  } finally {
    rl.close();
  }
}

run();
