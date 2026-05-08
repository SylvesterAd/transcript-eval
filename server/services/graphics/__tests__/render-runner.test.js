import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFile: vi.fn((cmd, args, opts, cb) => {
    cb(null, { stdout: 'render complete', stderr: '' });
  }),
}));

vi.mock('node:fs/promises', async () => {
  const real = await vi.importActual('node:fs/promises');
  return {
    ...real,
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue('<html>{{mainText}}</html>'),
    stat: vi.fn().mockResolvedValue({ size: 1024 }),
  };
});

afterEach(() => {
  delete process.env.GRAPHICS_RENDER_DIR;
});

describe('renderTemplate', () => {
  it('substitutes variables and runs hyperframes render', async () => {
    process.env.GRAPHICS_RENDER_DIR = '/tmp/test-renders';
    const { renderTemplate } = await import('../render-runner.js');
    const result = await renderTemplate({
      template: 'lower-third',
      vars: {
        width: 1920, height: 1080, duration: 5,
        mainText: 'Hello', subText: 'World',
        accent: '#f59e0b',
        barBottom: 80, barLeft: 80, barHeight: 110, barMaxWidth: 800,
        mainSize: 48, subSize: 14,
      },
      renderId: 42,
    });
    expect(result.outputPath).toContain('/tmp/test-renders/42/out.mp4');
    expect(result.bytes).toBeGreaterThan(0);
  });

  it('throws when a required template variable is missing', async () => {
    process.env.GRAPHICS_RENDER_DIR = '/tmp/test-renders';
    const { renderTemplate } = await import('../render-runner.js');
    await expect(
      renderTemplate({
        template: 'lower-third',
        vars: {}, // mainText not provided — mock readFile returns {{mainText}}
        renderId: 99,
      })
    ).rejects.toThrow('Template variable not provided: mainText');
  });
});

describe('renderHtml', () => {
  it('writes raw HTML and runs hyperframes render', async () => {
    process.env.GRAPHICS_RENDER_DIR = '/tmp/test-renders';
    const { renderHtml } = await import('../render-runner.js');
    const html = '<!doctype html><html><body><div id="stage" data-composition-id="main" data-duration="5" data-width="1920" data-height="1080">x</div></body></html>';
    const result = await renderHtml({ html, renderId: 73 });
    expect(result.outputPath).toContain('/tmp/test-renders/73/out.mp4');
    expect(result.bytes).toBeGreaterThan(0);
  });

  it('throws if html lacks the stage marker (defense in depth)', async () => {
    process.env.GRAPHICS_RENDER_DIR = '/tmp/test-renders';
    const { renderHtml } = await import('../render-runner.js');
    await expect(
      renderHtml({ html: '<html><body>no stage</body></html>', renderId: 74 })
    ).rejects.toThrow(/missing.*data-composition-id="main"/i);
  });

  it('writes to subDir when provided', async () => {
    process.env.GRAPHICS_RENDER_DIR = '/tmp/test-renders';
    const { renderHtml } = await import('../render-runner.js');
    const html = '<!doctype html><html><body><div id="stage" data-composition-id="main" data-duration="5" data-width="1920" data-height="1080">x</div></body></html>';
    const result = await renderHtml({ html, renderId: 88, subDir: 'scene-0' });
    expect(result.outputPath).toContain('/tmp/test-renders/88/scene-0/out.mp4');
    expect(result.workDir).toContain('/scene-0');
  });
});
