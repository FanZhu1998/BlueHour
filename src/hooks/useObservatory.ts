import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Collection, Frame, FrameManifest, ServiceStatus } from '../../shared/contracts';
import { api } from '../lib/api';
import { gapLabel, utcDate } from '../lib/format';

const emptyManifest = (collection: Collection): FrameManifest => ({
  collection,
  frames: [],
  latestId: null,
  newestKnownObservedAt: null,
});

export function useObservatory(interval: number) {
  const [manifests, setManifests] = useState<Record<Collection, FrameManifest>>({
    natural: emptyManifest('natural'),
    enhanced: emptyManifest('enhanced'),
  });
  const [status, setStatus] = useState<ServiceStatus | null>(null);
  const [collection, setCollection] = useState<Collection>('natural');
  const [frame, setFrame] = useState<Frame | null>(null);
  const [latestActive, setLatestActive] = useState(true);
  const [mode, setMode] = useState<'recent' | 'daily'>('recent');
  const [day, setDay] = useState('');
  const [playing, setPlaying] = useState(false);
  const [frozenFrames, setFrozenFrames] = useState<Frame[]>([]);
  const [buffering, setBuffering] = useState(false);
  const [connectionLost, setConnectionLost] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [gap, setGap] = useState<string | null>(null);
  const [pendingCollection, setPendingCollection] = useState<Collection | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  const decoded = useRef(new Map<string, HTMLImageElement>());
  const manifest = manifests[collection];
  const latest =
    manifest.frames.find((item) => item.id === manifest.latestId) || manifest.frames.at(-1) || null;
  const days = useMemo(
    () => [...new Set(manifest.frames.map((item) => utcDate(item.observedAt)))].sort().reverse(),
    [manifest.frames],
  );
  const selectedDay = day || (latest ? utcDate(latest.observedAt) : '');
  const sequence = useMemo(
    () =>
      mode === 'daily'
        ? manifest.frames.filter((item) => utcDate(item.observedAt) === selectedDay)
        : manifest.frames,
    [manifest.frames, mode, selectedDay],
  );
  const visibleSequence = playing ? frozenFrames : sequence;

  const decodeFrame = useCallback(async (target: Frame) => {
    const existing = decoded.current.get(target.id);
    if (existing?.complete && existing.naturalWidth > 0) return;
    const image = new Image();
    image.decoding = 'async';
    image.src = target.imageUrl;
    await image.decode();
    if (!image.naturalWidth) throw new Error('Image unavailable');
    decoded.current.set(target.id, image);
    while (decoded.current.size > 4) decoded.current.delete(decoded.current.keys().next().value!);
  }, []);

  const showFrame = useCallback(
    async (target: Frame, previous?: Frame | null): Promise<boolean> => {
      const token = ++generation.current;
      setBuffering(true);
      try {
        await decodeFrame(target);
        if (!mounted.current || token !== generation.current) return false;
        setFrame(target);
        setGap(previous ? gapLabel(previous.observedAt, target.observedAt) : null);
        setBuffering(false);
        return true;
      } catch {
        if (mounted.current && token === generation.current) {
          setBuffering(false);
          setPlaying(false);
          setNotice('This observation could not be opened. The last good image is still here.');
        }
        return false;
      }
    },
    [decodeFrame],
  );

  const load = useCallback(async () => {
    try {
      const [nextStatus, natural, enhanced] = await Promise.all([
        api.status(),
        api.frames('natural'),
        api.frames('enhanced'),
      ]);
      if (!mounted.current) return;
      setStatus(nextStatus);
      setManifests({
        natural: {
          ...natural,
          frames: [...natural.frames].sort((a, b) => a.observedAt.localeCompare(b.observedAt)),
        },
        enhanced: {
          ...enhanced,
          frames: [...enhanced.frames].sort((a, b) => a.observedAt.localeCompare(b.observedAt)),
        },
      });
      setConnectionLost(false);
    } catch {
      if (mounted.current) setConnectionLost(true);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    const timer = window.setInterval(() => void load(), 7_000);
    return () => {
      mounted.current = false;
      generation.current++;
      window.clearInterval(timer);
    };
  }, [load]);

  useEffect(() => {
    if (!latestActive || playing || !latest || latest.id === frame?.id) return;
    void showFrame(latest);
  }, [latest?.id, latestActive, playing, showFrame, frame?.id]);

  useEffect(() => {
    if (!frame) return;
    const list = playing ? frozenFrames : sequence;
    const index = list.findIndex((item) => item.id === frame.id);
    for (const target of [list[index + 1], list[index - 1]].filter(Boolean))
      void decodeFrame(target).catch(() => undefined);
  }, [frame?.id, sequence, frozenFrames, playing, decodeFrame]);

  useEffect(() => {
    if (!playing || frozenFrames.length < 2 || buffering) return;
    const timer = window.setTimeout(() => {
      const index = frozenFrames.findIndex((item) => item.id === frame?.id);
      const next = frozenFrames[(index + 1) % frozenFrames.length];
      void showFrame(next, frame);
    }, interval);
    return () => window.clearTimeout(timer);
  }, [playing, frozenFrames, buffering, frame, interval, showFrame]);

  useEffect(() => {
    const ids = [
      ...new Set([
        ...(frame ? [frame.id] : []),
        ...(playing ? frozenFrames.map((item) => item.id) : []),
      ]),
    ];
    if (ids.length) void api.pin(ids).catch(() => undefined);
  }, [frame?.id, playing, frozenFrames]);

  async function selectFrame(target: Frame) {
    setPlaying(false);
    setLatestActive(false);
    setNotice(null);
    await showFrame(target, frame);
  }

  function step(direction: -1 | 1) {
    const index = visibleSequence.findIndex((item) => item.id === frame?.id);
    const nextIndex =
      index < 0
        ? direction > 0
          ? 0
          : visibleSequence.length - 1
        : Math.max(0, Math.min(visibleSequence.length - 1, index + direction));
    if (nextIndex === index) {
      generation.current++;
      setBuffering(false);
      setPlaying(false);
      return;
    }
    const next = visibleSequence[nextIndex];
    if (next) void selectFrame(next);
  }

  function togglePlayback() {
    if (playing) {
      generation.current++;
      setBuffering(false);
      setPlaying(false);
      return;
    }
    if (sequence.length < 2) return;
    setFrozenFrames([...sequence]);
    setLatestActive(false);
    setPlaying(true);
    setNotice(null);
  }

  async function goLatest() {
    if (!latest) return;
    setPlaying(false);
    setLatestActive(true);
    setDay(utcDate(latest.observedAt));
    setNotice(null);
    await showFrame(latest);
  }

  function changeMode(nextMode: 'recent' | 'daily') {
    setPlaying(false);
    setMode(nextMode);
    if (frame) {
      generation.current++;
      setBuffering(false);
      setLatestActive(false);
      setDay(utcDate(frame.observedAt));
    }
  }

  function changeDay(nextDay: string) {
    generation.current++;
    setBuffering(false);
    setPlaying(false);
    setLatestActive(false);
    setDay(nextDay);
    const dailyFrames = manifest.frames.filter((item) => utcDate(item.observedAt) === nextDay);
    if (dailyFrames[0]) void showFrame(dailyFrames[0]);
  }

  async function switchCollection(next: Collection) {
    if (next === collection) return;
    if (frame) {
      generation.current++;
      setBuffering(false);
    }
    setPlaying(false);
    setNotice(null);
    const available = manifests[next].frames;
    const sameDay = frame
      ? available.filter((item) => utcDate(item.observedAt) === utcDate(frame.observedAt))
      : available;
    if (!sameDay.length) {
      setPendingCollection(next);
      if (!available.length) {
        try {
          await api.refresh(next);
          await load();
        } catch {
          setConnectionLost(true);
        }
      }
      return;
    }
    const target = frame
      ? [...sameDay].sort(
          (a, b) =>
            Math.abs(new Date(a.observedAt).getTime() - new Date(frame.observedAt).getTime()) -
            Math.abs(new Date(b.observedAt).getTime() - new Date(frame.observedAt).getTime()),
        )[0]
      : sameDay.at(-1)!;
    if (await showFrame(target)) {
      setCollection(next);
      setLatestActive(false);
      setDay(utcDate(target.observedAt));
      if (frame && target.observedAt !== frame.observedAt)
        setNotice('Different observation time · the nearest available image on this UTC date.');
    }
  }

  async function acceptLatestCollection() {
    if (!pendingCollection) return;
    const nextManifest = manifests[pendingCollection];
    const target =
      nextManifest.frames.find((item) => item.id === nextManifest.latestId) ||
      nextManifest.frames.at(-1);
    if (!target) return;
    if (await showFrame(target)) {
      setCollection(pendingCollection);
      setLatestActive(true);
      setDay(utcDate(target.observedAt));
      setPendingCollection(null);
      setNotice(null);
    }
  }

  async function refresh() {
    try {
      await api.refresh(collection);
      await load();
    } catch {
      setConnectionLost(true);
    }
  }

  const index = visibleSequence.findIndex((item) => item.id === frame?.id);
  return {
    status,
    collection,
    frame,
    latest,
    manifest,
    manifests,
    latestActive,
    mode,
    days,
    selectedDay,
    sequence: visibleSequence,
    index,
    playing,
    buffering,
    connectionLost,
    loading,
    notice,
    gap,
    pendingCollection,
    setNotice,
    setPendingCollection,
    selectFrame,
    step,
    togglePlayback,
    goLatest,
    changeMode,
    changeDay,
    switchCollection,
    acceptLatestCollection,
    refresh,
    reload: load,
  };
}

export type Observatory = ReturnType<typeof useObservatory>;
