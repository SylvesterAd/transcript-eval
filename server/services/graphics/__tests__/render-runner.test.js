import { describe, it, expect, vi } from 'vitest';

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
