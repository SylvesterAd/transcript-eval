import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function substitute(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (vars[key] === undefined) {
      throw new Error(`Template variable not provided: ${key}`);
    }
    return String(vars[key]);
  });
}

export async function renderTemplate({ template, vars, renderId, fps = 30, quality = 'standard' }) {
  const baseDir = process.env.GRAPHICS_RENDER_DIR || '/tmp/graphics-renders';
  const workDir = path.join(baseDir, String(renderId));
  await mkdir(workDir, { recursive: true });

  const templatePath = path.join(__dirname, 'templates', `${template}.html`);
  const html = await readFile(templatePath, 'utf8');
  const filledHtml = substitute(html, vars);
  await writeFile(path.join(workDir, 'index.html'), filledHtml, 'utf8');

  // Minimal hyperframes config
  await writeFile(
    path.join(workDir, 'hyperframes.json'),
    JSON.stringify({ paths: { blocks: 'compositions', components: 'compositions/components', assets: 'assets' } })
  );
  await writeFile(
    path.join(workDir, 'meta.json'),
    JSON.stringify({ id: `render-${renderId}`, name: `Render ${renderId}` })
  );

  const outputPath = path.join(workDir, 'out.mp4');
  const start = Date.now();
  await exec(
    'npx',
    ['-y', 'hyperframes', 'render', '-q', quality, '-f', String(fps), '-w', '1', '-o', outputPath],
    { cwd: workDir, timeout: 5 * 60 * 1000 }
  );
  const stats = await stat(outputPath);
  const durationMs = Date.now() - start;

  return {
    outputPath,
    bytes: stats.size,
    durationMs,
    workDir,
  };
}

const STAGE_MARKER_RE = /data-composition-id\s*=\s*"main"/i;

export async function renderHtml({ html, renderId, fps = 30, quality = 'standard', subDir = null }) {
  if (!STAGE_MARKER_RE.test(html)) {
    throw new Error(`renderHtml: html missing data-composition-id="main"`);
  }
  const baseDir = process.env.GRAPHICS_RENDER_DIR || '/tmp/graphics-renders';
  const workDir = subDir
    ? path.join(baseDir, String(renderId), subDir)
    : path.join(baseDir, String(renderId));
  await mkdir(workDir, { recursive: true });

  await writeFile(path.join(workDir, 'index.html'), html, 'utf8');
  await writeFile(
    path.join(workDir, 'hyperframes.json'),
    JSON.stringify({ paths: { blocks: 'compositions', components: 'compositions/components', assets: 'assets' } })
  );
  await writeFile(
    path.join(workDir, 'meta.json'),
    JSON.stringify({ id: `render-${renderId}`, name: `Render ${renderId}` })
  );

  const outputPath = path.join(workDir, 'out.mp4');
  const start = Date.now();
  await exec(
    'npx',
    ['-y', 'hyperframes', 'render', '-q', quality, '-f', String(fps), '-w', '1', '-o', outputPath],
    { cwd: workDir, timeout: 5 * 60 * 1000 }
  );
  const stats = await stat(outputPath);
  return {
    outputPath,
    bytes: stats.size,
    durationMs: Date.now() - start,
    workDir,
  };
}
