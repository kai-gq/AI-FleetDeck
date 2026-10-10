import { describe, it, expect, afterEach } from 'vitest';
import {
  humanizeWeChatId,
  isEmptyWeChatContent,
  resolveWeChatDisplayName,
  wechatTriggerHandler,
  type NormalizedWeChatMessage,
} from './wechat-trigger-handler.js';
import { resetConfigCacheForTests, updateConfig } from './wechat-config.js';
import * as fs from 'fs';
import * as path from 'path';
import { getDataDir } from '../../data/index.js';
import type { ExternalEvent, TriggerDefinition } from '../../../shared/integration-types.js';

function baseMsg(overrides: Partial<NormalizedWeChatMessage> = {}): NormalizedWeChatMessage {
  return {
    fromUserId: 'wxid_abc123456@im.wechat',
    body: 'hello world',
    contextToken: 'ctx-1',
    messageId: 'm1',
    timestamp: 1_780_000_000_000,
    itemTypes: [1],
    direction: 'inbound',
    raw: {},
    ...overrides,
  };
}

function eventOf(msg: NormalizedWeChatMessage): ExternalEvent {
  return { source: 'wechat', type: 'message', data: msg, timestamp: msg.timestamp };
}

function triggerWith(config: Record<string, unknown>): TriggerDefinition {
  return {
    id: 't1',
    type: 'wechat',
    name: 'test',
    enabled: true,
    matchMode: 'structural',
    config,
  } as TriggerDefinition;
}

afterEach(() => {
  fs.rmSync(path.join(getDataDir(), 'wechat-config.json'), { force: true });
  resetConfigCacheForTests();
});

describe('humanizeWeChatId', () => {
  it('masks the middle of long ids and keeps short ones as-is', () => {
    expect(humanizeWeChatId('a1b2c3d4e5f6g7h8@im.wechat')).toBe('a1b2c3…g7h8');
    expect(humanizeWeChatId('abc@im.wechat')).toBe('abc');
    expect(humanizeWeChatId('')).toBe('');
  });
});

describe('isEmptyWeChatContent', () => {
  it('flags blank body with no media, passes media-only and text', () => {
    expect(isEmptyWeChatContent(baseMsg({ body: '' }))).toBe(true);
    expect(isEmptyWeChatContent(baseMsg({ body: '   ' }))).toBe(true);
    expect(isEmptyWeChatContent(baseMsg({ body: '', itemTypes: [2] }))).toBe(false);
    expect(isEmptyWeChatContent(baseMsg({ body: 'hi' }))).toBe(false);
  });
});

describe('wechatTriggerHandler.structuralMatch', () => {
  it('matches any non-empty message with an empty config', () => {
    expect(wechatTriggerHandler.structuralMatch(triggerWith({}), eventOf(baseMsg()))).toBe(true);
  });

  it('fromFilter is a case-insensitive substring match', () => {
    expect(wechatTriggerHandler.structuralMatch(triggerWith({ fromFilter: ['ABC'] }), eventOf(baseMsg()))).toBe(true);
    expect(wechatTriggerHandler.structuralMatch(triggerWith({ fromFilter: ['zzz'] }), eventOf(baseMsg()))).toBe(false);
  });

  it('excludeFrom wins over fromFilter on overlap', () => {
    const cfg = { fromFilter: ['abc'], excludeFrom: ['abc123'] };
    expect(wechatTriggerHandler.structuralMatch(triggerWith(cfg), eventOf(baseMsg()))).toBe(false);
  });

  it('bodyPattern is a case-insensitive regex; invalid patterns never match', () => {
    expect(wechatTriggerHandler.structuralMatch(triggerWith({ bodyPattern: 'HELLO' }), eventOf(baseMsg()))).toBe(true);
    expect(wechatTriggerHandler.structuralMatch(triggerWith({ bodyPattern: '^nope$' }), eventOf(baseMsg()))).toBe(false);
    expect(wechatTriggerHandler.structuralMatch(triggerWith({ bodyPattern: '(' }), eventOf(baseMsg()))).toBe(false);
  });

  it('onlyWithContextToken gates reply-incapable messages', () => {
    expect(
      wechatTriggerHandler.structuralMatch(triggerWith({ onlyWithContextToken: true }), eventOf(baseMsg({ contextToken: undefined }))),
    ).toBe(false);
    expect(
      wechatTriggerHandler.structuralMatch(triggerWith({ onlyWithContextToken: true }), eventOf(baseMsg())),
    ).toBe(true);
  });

  it('rejects empty-content messages and dmOnly passes DM messages', () => {
    expect(wechatTriggerHandler.structuralMatch(triggerWith({}), eventOf(baseMsg({ body: '' })))).toBe(false);
    expect(wechatTriggerHandler.structuralMatch(triggerWith({ dmOnly: true }), eventOf(baseMsg()))).toBe(true);
  });
});

describe('wechatTriggerHandler.extractVariables', () => {
  it('exposes the wechat.* namespace with stable keys', () => {
    const vars = wechatTriggerHandler.extractVariables(
      triggerWith({}),
      eventOf(baseMsg({ body: '你好', itemTypes: [1, 2], voiceTranscription: undefined })),
    );
    expect(Object.keys(vars).sort()).toEqual(
      [
        'wechat.body',
        'wechat.contextToken',
        'wechat.from',
        'wechat.fromName',
        'wechat.hasContextToken',
        'wechat.itemTypes',
        'wechat.mediaBlock',
        'wechat.messageId',
        'wechat.timestamp',
        'wechat.toUserId',
        'wechat.voiceTranscription',
      ].sort(),
    );
    expect(vars['wechat.body']).toBe('你好');
    expect(vars['wechat.contextToken']).toBe('ctx-1');
    expect(vars['wechat.hasContextToken']).toBe('true');
    expect(vars['wechat.itemTypes']).toBe('1,2');
    expect(vars['wechat.mediaBlock']).toContain('image');
    expect(vars['wechat.fromName']).toBe('wxid_a…3456');
  });

  it('resolves the display name via raw field → alias → masked fallback', () => {
    const msg = baseMsg();
    expect(resolveWeChatDisplayName(msg)).toBeUndefined();
    expect(wechatTriggerHandler.extractVariables(triggerWith({}), eventOf(msg))['wechat.fromName']).toBe('wxid_a…3456');

    updateConfig({ aliases: { 'wxid_abc123456@im.wechat': '张三' } });
    expect(resolveWeChatDisplayName(msg)).toBe('张三');

    const withRawName = baseMsg({ raw: { from_name: '李四' } });
    expect(resolveWeChatDisplayName(withRawName)).toBe('李四');
  });
});

describe('wechatTriggerHandler.formatEventForLLM', () => {
  it('includes sender, body, and the reply-token status', () => {
    const withToken = wechatTriggerHandler.formatEventForLLM(eventOf(baseMsg({ body: '你好' })));
    expect(withToken).toContain('你好');
    expect(withToken).toContain('Reply token: present');
    expect(withToken).toContain('wxid_a…3456');

    const withoutToken = wechatTriggerHandler.formatEventForLLM(
      eventOf(baseMsg({ contextToken: undefined, voiceTranscription: '语音内容', itemTypes: [3], body: '语音内容' })),
    );
    expect(withoutToken).toContain('MISSING');
    expect(withoutToken).toContain('[voice transcription: 语音内容]');
    expect(withoutToken).toContain('[attachments: voice]');
  });
});
