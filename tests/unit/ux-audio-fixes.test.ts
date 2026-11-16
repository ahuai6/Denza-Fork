import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as THREE from 'three';
import { PASSAGE, RING, ROOMS, ROOM_IN, at, regionAt } from '../../src/app/space/plan';
import { RoomAudio, type SoundSource } from '../../src/app/space/systems/audio';
import { setLang, tx } from '../../src/i18n';
import '../../src/app/online/words';

function makeFakeAudioContext() {
  const created = {
    splitters: 0,
    gains: [] as { gain: { value: number }; connects: unknown[] }[],
    delays: [] as { delayTime: { value: number }; connects: unknown[] }[],
    filters: [] as { type: string; frequency: { value: number }; Q: { value: number }; connects: unknown[] }[],
    panners: [] as { panningModel: string }[],
  };
  const param = (v = 0) => {
    const obj = {
      value: v,
      setValueAtTime(next: number) {
        obj.value = next;
      },
      setTargetAtTime(next: number) {
        obj.value = next;
      },
      linearRampToValueAtTime(next: number) {
        obj.value = next;
      },
      exponentialRampToValueAtTime(next: number) {
        obj.value = next;
      },
      cancelScheduledValues() {},
    };
    return obj;
  };
  const baseNode = () => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
  });
  const ctx = {
    currentTime: 1,
    sampleRate: 48000,
    destination: baseNode(),
    listener: {
      positionX: param(),
      positionY: param(),
      positionZ: param(),
      forwardX: param(),
      forwardY: param(),
      forwardZ: param(),
      upX: param(),
      upY: param(),
      upZ: param(1),
    },
    resume: vi.fn(async () => {}),
    createGain() {
      const node = {
        gain: param(1),
        connects: [] as unknown[],
        connect: vi.fn((t: unknown) => node.connects.push(t)),
        disconnect: vi.fn(),
      };
      created.gains.push(node);
      return node;
    },
    createAnalyser() {
      return {
        fftSize: 1024,
        frequencyBinCount: 512,
        connect: vi.fn(),
        disconnect: vi.fn(),
        getByteFrequencyData: vi.fn(),
      };
    },
    createConvolver() {
      return { buffer: null, connect: vi.fn(), disconnect: vi.fn() };
    },
    createBiquadFilter() {
      const f = {
        type: 'lowpass',
        frequency: param(18000),
        Q: param(1),
        connects: [] as unknown[],
        connect: vi.fn((t: unknown) => f.connects.push(t)),
        disconnect: vi.fn(),
      };
      created.filters.push(f);
      return f;
    },
    createChannelSplitter() {
      created.splitters++;
      return { connect: vi.fn(), disconnect: vi.fn() };
    },
    createDelay() {
      const d = {
        delayTime: param(0),
        connects: [] as unknown[],
        connect: vi.fn((t: unknown) => d.connects.push(t)),
        disconnect: vi.fn(),
      };
      created.delays.push(d);
      return d;
    },
    createPanner() {
      const p = {
        panningModel: 'HRTF',
        distanceModel: 'linear',
        refDistance: 1,
        maxDistance: 1e4,
        rolloffFactor: 0,
        positionX: param(),
        positionY: param(),
        positionZ: param(),
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      created.panners.push(p);
      return p;
    },
  };
  return { ctx: ctx as unknown as AudioContext, created };
}

describe('online i18n eager registration', () => {
  it('registers on.short and on.close eagerly without waiting for lazy UI chunks', () => {
    const mainTsx = readFileSync(resolve('src/app/main.tsx'), 'utf8');
    expect(mainTsx).toContain("import './online/words'");

    setLang('zh-Hans');
    expect(tx('on.short')).toBe('在线');
    expect(tx('on.close')).toBe('关闭');

    setLang('en');
    expect(tx('on.short')).toBe('Online');
    expect(tx('on.close')).toBe('Close');

    setLang('zh-Hant');
  });
});

describe('listening room entry and 5.1 surround sound field', () => {
  it('transitions into side rooms near the doorway inner face instead of delaying 1.5m into the room', () => {
    const midPassage = at(ROOMS.listening.th, PASSAGE.from + PASSAGE.len * 0.5);
    const justInside = at(ROOMS.listening.th, ROOM_IN + 0.35);
    expect(regionAt(midPassage)?.door).toBe(true);
    expect(regionAt(justInside)).toMatchObject({ room: 'listening' });
    expect(regionAt(justInside)?.door).toBeUndefined();
    expect(RING.r1).toBeLessThan(ROOM_IN);
  });

  it('builds one shared stereo splitter for all 6 feeds and lights every listening field speaker in the room', async () => {
    const { ctx, created } = makeFakeAudioContext();
    const sources: SoundSource[] = (['L', 'R', 'C', 'SL', 'SR', 'LFE'] as const).map((feed, i) => ({
      room: 'listening',
      pos: new THREE.Vector3(28 + i, 1.5, -40),
      feed,
      field: true,
      level: 0.5,
    }));
    const room = new RoomAudio({
      audio: () => ({ ctx, route: vi.fn(), hifi: false }),
      sources,
      ambientFrom: { room: 'atrium', pos: new THREE.Vector3(0, 1.5, -40) },
      ambientUrl: '',
      reverb: { listening: 1.2 },
      path: (from, _fr, to) => [from.clone(), to.clone()],
      voices: 2,
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('skip'));
    const origWin = globalThis.window;
    Object.defineProperty(globalThis, 'window', {
      value: { setTimeout: globalThis.setTimeout },
      configurable: true,
    });
    try {
      await room.start();
      room.setPhones(false);
      room.tick(0.2, { pos: new THREE.Vector3(28, 1.6, -40), quat: new THREE.Quaternion(), room: 'listening' }, true);
      expect(created.splitters).toBe(1);
      expect(sources.every((s) => s.lit)).toBe(true);
      const feedGains = created.gains.map((g) => g.gain.value);
      expect(feedGains).toContain(0.95);
      expect(feedGains).toContain(-0.18);
      expect(feedGains).toContain(1.75);
      expect(created.delays.map((d) => d.delayTime.value)).toEqual(expect.arrayContaining([0.014, 0.018]));
    } finally {
      room.dispose();
      fetchMock.mockRestore();
      Object.defineProperty(globalThis, 'window', { value: origWin, configurable: true });
    }
  });
});
