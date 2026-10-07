import { describe, expect, it } from 'vitest';
import { isPathLike, resolveExecutableOnPath, type ProbeResult } from './executable-path';

/** Fake filesystem; paths compare case-insensitively (Windows semantics). */
function fakeProbe(files: string[], dirs: string[] = [], notExecutable: string[] = []) {
  const fileSet = new Set(files.map((f) => f.toLowerCase()));
  const dirSet = new Set(dirs.map((d) => d.toLowerCase()));
  const noExec = new Set(notExecutable.map((f) => f.toLowerCase()));
  const probed: string[] = [];
  const probe = (candidate: string): ProbeResult => {
    probed.push(candidate);
    const key = candidate.toLowerCase();
    if (fileSet.has(key)) return 'file';
    if (dirSet.has(key)) return 'dir';
    if (noExec.has(key)) return 'not-executable';
    return 'missing';
  };
  return { probe, probed };
}

/** Win32 scans must always stub the where.exe fallback so tests stay hermetic. */
function neverFound(): string | null {
  return null;
}

describe('isPathLike', () => {
  it('detects separators and drive prefixes, not bare names', () => {
    expect(isPathLike('claude')).toBe(false);
    expect(isPathLike('C:\\tools\\claude.exe')).toBe(true);
    expect(isPathLike('./claude')).toBe(true);
    expect(isPathLike('/usr/bin/claude')).toBe(true);
    expect(isPathLike('C:claude')).toBe(true);
  });
});

describe('resolveExecutableOnPath (win32)', () => {
  it('finds a bare name via PATHEXT (.cmd)', () => {
    const { probe } = fakeProbe(['C:\\npm\\claude.cmd']);
    const hit = resolveExecutableOnPath('claude', {
      platform: 'win32',
      pathValue: 'C:\\tools;C:\\npm',
      pathext: '.COM;.EXE;.BAT;.CMD',
      probe,
      whichFallback: neverFound,
    });
    // The candidate keeps PATHEXT's casing; the Windows filesystem matches
    // case-insensitively at stat time.
    expect(hit).toBe('C:\\npm\\claude.CMD');
  });

  it('falls back to cmd\'s builtin PATHEXT list when PATHEXT is unset', () => {
    const { probe } = fakeProbe(['C:\\bin\\mytool.BAT']);
    const hit = resolveExecutableOnPath('mytool', {
      platform: 'win32',
      pathValue: 'C:\\bin',
      probe,
      whichFallback: neverFound,
    });
    expect(hit).toBe('C:\\bin\\mytool.BAT');
  });

  it('does not append another extension when the name already carries one', () => {
    const { probe, probed } = fakeProbe(['C:\\bin\\claude.exe']);
    const hit = resolveExecutableOnPath('claude.exe', {
      platform: 'win32',
      pathValue: 'C:\\bin',
      pathext: '.COM;.EXE;.BAT;.CMD',
      probe,
      whichFallback: neverFound,
    });
    expect(hit).toBe('C:\\bin\\claude.exe');
    expect(probed).toEqual(['C:\\bin\\claude.exe']);
  });

  it('accepts an exact extensionless match first', () => {
    const { probe } = fakeProbe(['C:\\local\\bin\\claude']);
    const hit = resolveExecutableOnPath('claude', {
      platform: 'win32',
      pathValue: 'C:\\local\\bin',
      pathext: '.EXE;.CMD',
      probe,
      whichFallback: neverFound,
    });
    expect(hit).toBe('C:\\local\\bin\\claude');
  });

  it('prefers the first PATH entry', () => {
    const { probe } = fakeProbe(['C:\\a\\tool.exe', 'C:\\b\\tool.exe']);
    const hit = resolveExecutableOnPath('tool', {
      platform: 'win32',
      pathValue: 'C:\\a;C:\\b',
      pathext: '.EXE',
      probe,
      whichFallback: neverFound,
    });
    expect(hit).toBe('C:\\a\\tool.EXE');
  });

  it('uses the injected where.exe fallback on a full miss', () => {
    const { probe } = fakeProbe([]);
    const hit = resolveExecutableOnPath('claude', {
      platform: 'win32',
      pathValue: 'C:\\nope',
      probe,
      whichFallback: (name) => (name === 'claude' ? 'C:\\alias\\claude.exe' : null),
    });
    expect(hit).toBe('C:\\alias\\claude.exe');
  });

  it('treats empty PATH segments as the current directory', () => {
    const { probe } = fakeProbe(['claude']);
    const hit = resolveExecutableOnPath('claude', {
      platform: 'win32',
      pathValue: ';C:\\bin',
      pathext: '.EXE',
      probe,
      whichFallback: neverFound,
    });
    expect(hit).toBe('claude');
  });

  it('never throws when the probe itself throws', () => {
    const hit = resolveExecutableOnPath('claude', {
      platform: 'win32',
      pathValue: 'C:\\bin',
      probe: () => {
        throw new Error('boom');
      },
      whichFallback: () => {
        throw new Error('also boom');
      },
    });
    expect(hit).toBeNull();
  });
});

describe('resolveExecutableOnPath (unix)', () => {
  it('finds an executable on PATH', () => {
    const { probe } = fakeProbe(['/opt/bin/mytool']);
    const hit = resolveExecutableOnPath('mytool', {
      platform: 'linux',
      pathValue: '/usr/bin:/opt/bin',
      probe,
    });
    expect(hit).toBe('/opt/bin/mytool');
  });

  it('skips non-executable files and keeps looking', () => {
    const { probe } = fakeProbe(['/opt/bin/tool'], [], ['/usr/bin/tool']);
    const hit = resolveExecutableOnPath('tool', {
      platform: 'linux',
      pathValue: '/usr/bin:/opt/bin',
      probe,
    });
    expect(hit).toBe('/opt/bin/tool');
  });

  it('skips a directory with the same name', () => {
    const { probe } = fakeProbe([], ['/usr/bin/tool']);
    const hit = resolveExecutableOnPath('tool', {
      platform: 'linux',
      pathValue: '/usr/bin',
      probe,
    });
    expect(hit).toBeNull();
  });

  it('prefers the first PATH entry and returns null on a full miss', () => {
    const { probe } = fakeProbe(['/a/tool', '/b/tool']);
    expect(
      resolveExecutableOnPath('tool', { platform: 'darwin', pathValue: '/a:/b', probe })
    ).toBe('/a/tool');
    const miss = fakeProbe([]);
    expect(
      resolveExecutableOnPath('tool', { platform: 'darwin', pathValue: '/a:/b', probe: miss.probe })
    ).toBeNull();
  });
});
