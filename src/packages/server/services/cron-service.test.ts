import { describe, it, expect, afterEach, vi } from 'vitest';
import * as cronService from './cron-service.js';

// cronService.schedule's same-minute guard compares `job.lastFired` (real
// `Date.now()`) against `currentMinute` derived from `getDateInTimezone(tz)`,
// which constructs a Date with LOCAL-tz semantics from the formatted parts of
// the requested tz. The two minute integers only line up when local tz === tz.
// We pin the cron tz to the runner's local tz so the math is consistent
// regardless of where the suite executes (CI under UTC, dev box in CDMX, etc).
const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

// All schedule calls install a setInterval — clean up after each spec so timers
// don't leak between tests and the spec doesn't keep vitest's event loop alive.
const startedJobs: cronService.CronJob[] = [];

afterEach(() => {
  for (const job of startedJobs) cronService.stop(job);
  startedJobs.length = 0;
  vi.useRealTimers();
});

describe('cronService.schedule initialLastFired', () => {
  it('defaults job.lastFired to null when initialLastFired is omitted (back-compat)', () => {
    const job = cronService.schedule('* * * * *', 'UTC', () => {});
    startedJobs.push(job);
    expect(job.lastFired).toBeNull();
  });

  it('seeds job.lastFired from initialLastFired when provided', () => {
    const seed = 1_700_000_000_000;
    const job = cronService.schedule('* * * * *', 'UTC', () => {}, { initialLastFired: seed });
    startedJobs.push(job);
    expect(job.lastFired).toBe(seed);
  });

  it('treats initialLastFired: null as "no seed" (same as omitting it)', () => {
    const job = cronService.schedule('* * * * *', 'UTC', () => {}, { initialLastFired: null });
    startedJobs.push(job);
    expect(job.lastFired).toBeNull();
  });

  it('seeded job does NOT fire on the same-minute poll (regression: cron double-fire)', () => {
    // Anchor wall clock so getDateInTimezone returns a stable minute.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-28T15:30:15Z'));

    const cb = vi.fn();
    // initialLastFired anchored inside the current minute — guard must trip.
    const job = cronService.schedule('* * * * *', LOCAL_TZ, cb, { initialLastFired: Date.now() });
    startedJobs.push(job);

    // Advance through the next interval tick (30s default) while staying in the
    // same minute — fake clock lands at 15:30:45Z.
    vi.advanceTimersByTime(30_000);
    expect(cb).not.toHaveBeenCalled();
  });

  it('seeded job DOES fire once the wall clock crosses into the next minute', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-28T15:30:15Z'));

    const cb = vi.fn();
    const job = cronService.schedule('* * * * *', LOCAL_TZ, cb, { initialLastFired: Date.now() });
    startedJobs.push(job);

    // Two interval ticks: 30s lands at 15:30:45Z (same minute → guarded),
    // 60s lands at 15:31:15Z (new minute → fires).
    vi.advanceTimersByTime(60_000);
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('任务33 活动监视器注册点', () => {
  it('表达式固定、start 幂等、stop 后可重启', () => {
    expect(cronService.SENTINEL_SCAN_CRON).toBe('10 0 * * *');
    const first = cronService.startSentinelScanJob();
    expect(cronService.startSentinelScanJob()).toBe(first); // 幂等:重复 start 返回同句柄
    cronService.stopSentinelScanJob();
    const restarted = cronService.startSentinelScanJob();
    expect(restarted).not.toBe(first); // stop 后可再注册
    cronService.stopSentinelScanJob();
  });

  it('到点触发:惰性加载 sentinel-service 并调 runSentinelDailyScan(重复 start 不重复触发)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 5, 0, 9, 50)); // 本地 00:09:50,30s 后跨入 00:10

    const runScan = vi.fn().mockResolvedValue(undefined);
    vi.doMock('./sentinel-service.js', () => ({ runSentinelDailyScan: runScan }));

    const job = cronService.startSentinelScanJob();
    cronService.startSentinelScanJob(); // 幂等:不应产生第二个 interval

    vi.advanceTimersByTime(30_000);
    await vi.waitFor(() => expect(runScan).toHaveBeenCalledTimes(1));
    expect(job.lastFired).not.toBeNull();

    cronService.stopSentinelScanJob();
    vi.doUnmock('./sentinel-service.js');
  });
});
