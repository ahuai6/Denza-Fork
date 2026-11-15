import { useEffect, useMemo, useRef, useState } from 'react';
import { tx } from '../../i18n';
import {
  translationLines,
  mergeTranslations,
  matchTranslations,
  readTranslationPaste,
  type TranslationFragment,
  type TranslationMatch,
} from '../../engine';
import { request, jobId } from '../online/state';
import type { TranslationProvider } from '../online/types';
import { OnlineDialog, SearchSongs } from './OnlineMusic';
import { Button, Dropdown, Note } from './kit';
import s from './OnlineMusic.module.css';

interface Props {
  source: string;
  song: { title: string; artist: string; album: string };
  apply(text: string): void;
  close(): void;
}
const defaults: TranslationProvider = {
  kind: 'openai',
  baseURL: 'https://api.openai.com/v1',
  protocol: 'responses',
  model: '',
  hasKey: false,
};
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
export function TranslationEditor({ source, song, apply, close }: Props) {
  const baseline = useRef(source),
    alive = useRef(true),
    task = useRef(''),
    suggested = useRef<Record<string, string>>({});
  const lines = useMemo(() => translationLines(baseline.current), []);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(lines.map((l) => [l.id, l.translation])),
  );
  const [locked, setLocked] = useState<string[]>([]),
    [mode, setMode] = useState('online'),
    [language, setLanguage] = useState('zh-Hans');
  const [provider, setProvider] = useState<TranslationProvider>(defaults),
    [key, setKey] = useState(''),
    [models, setModels] = useState<string[]>([]);
  const [context, setContext] = useState(''),
    [paste, setPaste] = useState(''),
    [shift, setShift] = useState(0);
  const [extra, setExtra] = useState<TranslationFragment[]>([]),
    [matches, setMatches] = useState<TranslationMatch[]>([]),
    [selectedLine, setSelectedLine] = useState(lines[0]?.id || ''),
    [selectedFragments, setSelectedFragments] = useState<number[]>([]);
  const [busy, setBusy] = useState(false),
    [status, setStatus] = useState(''),
    [connected, setConnected] = useState(false),
    [dirty, setDirty] = useState(false);
  useEffect(() => {
    request<TranslationProvider>('provider')
      .then((p) => {
        if (alive.current) setProvider(p);
      })
      .catch((e) => {
        if (alive.current) setStatus(errorText(e));
      });
    return () => {
      alive.current = false;
      if (task.current) void request('cancel', { jobId: task.current });
    };
  }, []);
  const fragments = useMemo(
    () => [...readTranslationPaste(paste), ...extra].map((f, index) => ({ ...f, index })),
    [paste, extra],
  );
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setStatus('');
    try {
      await fn();
    } catch (e) {
      if (alive.current) setStatus(errorText(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const saveProvider = async () => {
    const saved = await request<TranslationProvider>('setProvider', { ...provider, ...(key ? { key } : {}) });
    if (alive.current) {
      setProvider(saved);
      setKey('');
      setStatus(tx('tr.saved'));
    }
  };
  const useMatches = (proposals: TranslationMatch[]) => {
    setMatches(proposals);
    const previous = suggested.current;
    const next = Object.fromEntries(
      proposals
        .filter((m) => !locked.includes(m.id))
        .map((m) => [m.id, m.fragments.map((i) => fragments.find((f) => f.index === i)?.text || '').join(' ')]),
    );
    suggested.current = next;
    setValues((old) => {
      const values = { ...old };
      // Re-matching a different paste must not leave obsolete automatic suggestions in unmatched rows.
      for (const [id, value] of Object.entries(previous))
        if (!locked.includes(id) && old[id] === value)
          values[id] = lines.find((line) => line.id === id)?.translation || '';
      return { ...values, ...next };
    });
    setDirty(true);
  };
  const translate = () =>
    act(async () => {
      await saveProvider();
      const id = jobId();
      task.current = id;
      try {
        const result = await request<{ id: string; translation: string }[]>('translate', {
          jobId: id,
          input: {
            song,
            language,
            context,
            lines: lines.map(({ id, text }) => ({ id, text })),
            wanted: lines.filter((l) => !locked.includes(l.id)).map((l) => l.id),
            locked: Object.fromEntries(locked.map((id) => [id, values[id]])),
          },
        });
        if (alive.current && source === baseline.current) {
          setValues((v) => ({ ...v, ...Object.fromEntries(result.map((l) => [l.id, l.translation])) }));
          setDirty(true);
        }
      } finally {
        task.current = '';
      }
    });
  return (
    <OnlineDialog title={tx('tr.title')} close={close}>
      <div className={s.stack} data-test="translation-editor">
        <Note>{tx('tr.draftHelp')}</Note>
        {source !== baseline.current && <Note>{tx('tr.changed')}</Note>}
        <nav className={s.toolbar}>
          {['online', 'paste', 'search'].map((k) => (
            <Button
              key={k}
              aria-pressed={mode === k}
              kind={mode === k ? 'primary' : 'quiet'}
              onClick={() => setMode(k)}
            >
              {tx(k === 'search' ? 'on.lyrics' : 'tr.' + k)}
            </Button>
          ))}
        </nav>
        <div className={s.editorLayout}>
          <section className={s.stack}>
            {mode === 'online' && (
              <>
                <details open={!provider.model}>
                  <summary>{tx('tr.provider')}</summary>
                  <div className={s.providerForm}>
                    <Dropdown
                      label={tx('tr.provider')}
                      value={provider.kind}
                      onChange={(v) =>
                        setProvider({
                          ...defaults,
                          kind: v as TranslationProvider['kind'],
                          baseURL:
                            v === 'openai'
                              ? 'https://api.openai.com/v1'
                              : v === 'deepseek'
                                ? 'https://api.deepseek.com'
                                : '',
                          protocol: v === 'openai' || v === 'codex' ? 'responses' : 'chat',
                        })
                      }
                      options={['openai', 'compatible', 'deepseek', 'codex'].map((k) => [
                        k,
                        k === 'compatible'
                          ? 'OpenAI compatible'
                          : k === 'openai'
                            ? 'OpenAI'
                            : k === 'deepseek'
                              ? 'DeepSeek'
                              : 'Codex',
                      ])}
                    />
                    {provider.kind !== 'codex' && (
                      <>
                        {provider.kind === 'compatible' && (
                          <label>
                            Base URL
                            <input
                              value={provider.baseURL}
                              onChange={(e) => setProvider({ ...provider, baseURL: e.target.value })}
                            />
                          </label>
                        )}
                        <Dropdown
                          label="API"
                          value={provider.protocol}
                          onChange={(v) => setProvider({ ...provider, protocol: v as TranslationProvider['protocol'] })}
                          options={[
                            ['responses', 'Responses'],
                            ['chat', 'Chat Completions'],
                          ]}
                        />
                        <label>
                          {tx('tr.key')}
                          <input
                            type="password"
                            autoComplete="off"
                            value={key}
                            onChange={(e) => setKey(e.target.value)}
                          />
                        </label>
                      </>
                    )}
                    <label>
                      {tx('tr.model')}
                      <input
                        value={provider.model}
                        onChange={(e) => setProvider({ ...provider, model: e.target.value })}
                        list="denza-models"
                      />
                    </label>
                    <datalist id="denza-models">
                      {models.map((m) => (
                        <option key={m} value={m} />
                      ))}
                    </datalist>
                    <div className={s.toolbar}>
                      <Button disabled={busy} onClick={() => void act(saveProvider)}>
                        {tx('tr.saveProvider')}
                      </Button>
                      <Button
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            await saveProvider();
                            const value = await request<string[]>('models');
                            if (alive.current) setModels(value);
                          })
                        }
                      >
                        {tx('tr.models')}
                      </Button>
                      {provider.kind === 'codex' && (
                        <>
                          <Button
                            disabled={busy}
                            onClick={() =>
                              void act(async () => {
                                await saveProvider();
                                const value = await request<{ connected: boolean }>('codex', { action: 'login' });
                                if (alive.current) setConnected(value.connected);
                              })
                            }
                          >
                            {tx(connected ? 'tr.connected' : 'tr.signin')}
                          </Button>
                          <Button
                            disabled={busy}
                            onClick={() =>
                              void act(async () => {
                                const value = await request<{ connected: boolean }>('codex', { action: 'status' });
                                if (alive.current) {
                                  setConnected(value.connected);
                                  setStatus(tx(value.connected ? 'tr.connected' : 'tr.signin'));
                                }
                              })
                            }
                          >
                            {tx('on.check')}
                          </Button>
                          <Button
                            disabled={busy}
                            onClick={() =>
                              void act(async () => {
                                await request('codex', { action: 'logout' });
                                setConnected(false);
                              })
                            }
                          >
                            {tx('on.logout')}
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                </details>
                <label>
                  {tx('tr.language')}
                  <input value={language} maxLength={80} onChange={(e) => setLanguage(e.target.value)} />
                </label>
                <label>
                  {tx('tr.context')}
                  <textarea value={context} maxLength={8000} onChange={(e) => setContext(e.target.value)} />
                </label>
                <Button
                  disabled={busy || !lines.length || locked.length === lines.length || !language.trim()}
                  onClick={() => void translate()}
                >
                  {tx(busy ? 'on.wait' : 'tr.online')}
                </Button>
              </>
            )}
            {mode === 'search' && (
              <SearchSongs
                initialQuery={song.title}
                onReferences={(refs) => {
                  setExtra((v) => [...v, ...refs]);
                  setMode('paste');
                }}
              />
            )}
            {mode === 'paste' && (
              <>
                <label>
                  {tx('tr.paste')}
                  <textarea className={s.paste} value={paste} onChange={(e) => setPaste(e.target.value)} />
                </label>
                <label>
                  {tx('tr.offset')}
                  <input type="number" value={shift} step="0.01" onChange={(e) => setShift(+e.target.value || 0)} />
                </label>
                <Button
                  disabled={!fragments.length || busy}
                  onClick={() => useMatches(matchTranslations(lines, fragments, shift))}
                >
                  {tx('tr.match')}
                </Button>
                <div className={s.columns}>
                  <div className={s.rows}>
                    {lines.map((l) => (
                      <Button
                        key={l.id}
                        aria-pressed={l.id === selectedLine}
                        onClick={() => {
                          setSelectedLine(l.id);
                          setSelectedFragments(matches.find((m) => m.id === l.id)?.fragments || []);
                        }}
                      >
                        {l.text}
                      </Button>
                    ))}
                  </div>
                  <div className={s.rows}>
                    {fragments.map((f) => (
                      <label key={f.index}>
                        <input
                          type="checkbox"
                          checked={selectedFragments.includes(f.index)}
                          onChange={(e) =>
                            setSelectedFragments((v) =>
                              e.target.checked ? [...v, f.index] : v.filter((i) => i !== f.index),
                            )
                          }
                        />
                        {f.text}
                      </label>
                    ))}
                  </div>
                </div>
                <Button
                  disabled={!selectedLine || locked.includes(selectedLine)}
                  onClick={() => {
                    const retained = matches.filter(
                      (m) => m.id !== selectedLine && !m.fragments.some((i) => selectedFragments.includes(i)),
                    );
                    const next = selectedFragments.length
                      ? [
                          ...retained,
                          {
                            id: selectedLine,
                            fragments: [...selectedFragments].sort((a, b) => a - b),
                            evidence: 'manual' as const,
                          },
                        ]
                      : retained;
                    const displaced = matches
                      .filter((m) => m.id !== selectedLine && m.fragments.some((i) => selectedFragments.includes(i)))
                      .map((m) => m.id);
                    setValues((v) => ({
                      ...v,
                      ...Object.fromEntries([...displaced, selectedLine].map((id) => [id, ''])),
                    }));
                    useMatches(next);
                  }}
                >
                  {tx('tr.manual')}
                </Button>
              </>
            )}
          </section>
          <section className={s.stack}>
            {status && <Note>{status}</Note>}
            <div className={s.translation}>
              {lines.map((l) => (
                <div key={l.id} className={s.preview}>
                  <div className={s.toolbar}>
                    <b>{l.text}</b>
                    <label>
                      <input
                        type="checkbox"
                        checked={locked.includes(l.id)}
                        aria-label={tx('tr.lock')}
                        onChange={(e) =>
                          setLocked((v) => (e.target.checked ? [...v, l.id] : v.filter((id) => id !== l.id)))
                        }
                      />
                      {tx('tr.lock')}
                    </label>
                  </div>
                  <textarea
                    aria-label={l.text}
                    disabled={locked.includes(l.id) || busy}
                    value={values[l.id] || ''}
                    onChange={(e) => {
                      setValues({ ...values, [l.id]: e.target.value });
                      setDirty(true);
                    }}
                  />
                  <small>
                    {matches.find((m) => m.id === l.id)
                      ? tx('tr.' + matches.find((m) => m.id === l.id)!.evidence)
                      : tx(values[l.id] ? 'tr.draft' : 'tr.unmatched')}
                  </small>
                </div>
              ))}
            </div>
            <div className={s.toolbar}>
              {busy && task.current && (
                <Button onClick={() => void request('cancel', { jobId: task.current })}>{tx('on.cancel')}</Button>
              )}
              <Button
                kind="primary"
                disabled={busy || !dirty || !lines.length || source !== baseline.current}
                onClick={() => {
                  apply(
                    mergeTranslations(
                      baseline.current,
                      Object.fromEntries(
                        lines.filter((l) => values[l.id] !== l.translation).map((l) => [l.id, values[l.id]]),
                      ),
                    ),
                  );
                  close();
                }}
              >
                {tx('tr.apply')}
              </Button>
            </div>
          </section>
        </div>
      </div>
    </OnlineDialog>
  );
}
